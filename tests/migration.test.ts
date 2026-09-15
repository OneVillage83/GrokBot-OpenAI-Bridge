import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, ready, FakeCodex, FakeGit } from './helpers.js';
import { SQLiteStore } from '../src/adapters/storage/sqlite-adapter.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { BrowserChatGPTAdapter } from '../src/adapters/chatgpt/browser-adapter.js';
import { LocalGitAdapter } from '../src/adapters/git/git-adapter.js';

async function legacy() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-migration-')),
    repo = join(root, 'repo'),
    path = join(root, 'state', 'bridge.sqlite');
  mkdirSync(repo);
  const f = fixture(path, repo),
    run = await ready(f);
  const oldProject = {
    ...f.p,
    ...{
      repo_path: f.repo.repo_path,
      repo_url: f.repo.repo_url,
      working_branch: f.repo.working_branch,
      codex_thread_id: 'original-v1-thread',
      autonomy_enabled: true,
      smoke_passed: true,
    },
  };
  const {
    repository_baselines,
    authorized_repository_ids,
    pending_repository_ids,
    pending_workstream_id,
    ...rest
  } = run;
  const oldRun = { ...rest, baseline_head: 'v1-baseline' };
  f.store.artifact(run, 'legacy-sensitive-raw', 'Exact original private artifact');
  f.store.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(oldProject), f.p.project_id);
  f.store.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(oldRun), run.id);
  f.store.db.exec(
    'DROP TABLE codex_workstreams; DROP TABLE project_repositories; PRAGMA user_version=1;',
  );
  f.store.close();
  return { path, run, oldProject };
}

test('schema v1 requires explicit migration, preserves backup/thread/artifacts and blocks old instruction replay', async () => {
  const { path, run, oldProject } = await legacy();
  assert.throws(() => new SQLiteStore(path), /Stop bridge controllers/);
  const store = new SQLiteStore(path, { migrate: true });
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.ok(store.migrationBackup);
    const backup = new DatabaseSync(store.migrationBackup!, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 1);
      assert.deepEqual(
        JSON.parse(backup.prepare('SELECT data FROM projects').get()!.data as string),
        oldProject,
      );
    } finally {
      backup.close();
    }
    const p = store.project(run.project_id),
      repo = store.repository(p.project_id, 'primary'),
      w = store.workstream(p.project_id, 'primary'),
      r = store.run(run.id);
    assert.equal(p.autonomy_enabled, false);
    assert.equal(p.smoke_passed, false);
    assert.equal('repo_path' in p, false);
    assert.equal(w.codex_thread_id, 'original-v1-thread');
    assert.equal(w.repository_id, 'primary');
    assert.equal(repo.default_branch, '');
    assert.deepEqual(r.repository_baselines, { primary: 'v1-baseline' });
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.equal(r.migration_review_required, true);
    assert.equal(
      store.artifacts(r.id).find((x) => x.kind === 'legacy-sensitive-raw')!.raw,
      'Exact original private artifact',
    );
    const codex = new FakeCodex(),
      engine = new Orchestrator(store, new BrowserChatGPTAdapter(store), codex, new FakeGit());
    await assert.rejects(() => engine.drive(p, r), /No old instruction/);
    await assert.rejects(() => engine.recover(p, r), /No old instruction/);
    assert.throws(() => engine.resume(p, r), /No old instruction/);
    assert.equal(codex.calls.length, 0);
    await assert.rejects(
      () => new LocalGitAdapter().setup(repo, false),
      /Configure default_branch/,
    );
    assert.throws(
      () => store.updateRepository({ ...repo, default_branch: 'main' }),
      /stopped, reconciled/,
    );
    store.transition(r, 'FAILED', 'HUMAN_CANCELLED: reconciled migration');
    store.updateRepository({ ...repo, default_branch: 'main' });
    const fresh = await engine.start(p, 'Fresh routed instruction', ['primary']);
    assert.equal(fresh.turn_limit, 1);
    assert.equal(fresh.migration_review_required, undefined);
  } finally {
    store.close();
  }
  const reopened = new SQLiteStore(path, { migrate: true });
  assert.equal(reopened.migrationBackup, undefined);
  reopened.close();
});

test('migration refuses outstanding controller locks without changing schema', async () => {
  const { path } = await legacy();
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO locks VALUES(?,?,?,?)').run(
    'daily-line',
    'owner',
    process.pid,
    'test-host',
  );
  db.close();
  assert.throws(() => new SQLiteStore(path, { migrate: true }), /Stop all bridge controllers/);
  const read = new DatabaseSync(path);
  try {
    assert.equal(read.prepare('PRAGMA user_version').get()!.user_version, 1);
  } finally {
    read.close();
  }
});
