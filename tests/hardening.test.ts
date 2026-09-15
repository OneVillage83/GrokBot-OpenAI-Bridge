import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, ready, receipt, response, FakeCodex, FakeGit } from './helpers.js';
import { LocalGitAdapter } from '../src/adapters/git/git-adapter.js';
import { EVIDENCE_LIMITS, snapshotUntracked } from '../src/adapters/git/file-evidence.js';
import { captureGit } from '../src/adapters/git/git-capture.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { SQLiteStore } from '../src/adapters/storage/sqlite-adapter.js';
import { BrowserChatGPTAdapter } from '../src/adapters/chatgpt/browser-adapter.js';
import {
  repositoryFromConfig,
  workstreamFromConfig,
  registrationFromConfig,
} from '../src/config/project.js';
import { resolveRoute } from '../src/core/routing.js';
import { mayApprove } from '../src/core/policy.js';

const temp = () => mkdtempSync(join(tmpdir(), 'bridge-hardening-'));
function second(f: ReturnType<typeof fixture>, enabled = true) {
  const repo = repositoryFromConfig(f.p.project_id, {
    ...f.repo,
    repository_id: 'Daily-NFL',
    logical_name: 'Daily NFL',
    repo_path: temp(),
    enabled,
  });
  const w = workstreamFromConfig(f.p.project_id, {
    repository_id: repo.repository_id,
    workstream_id: 'nfl-work',
  });
  f.store.addRepository(repo);
  f.store.addWorkstream(w);
  return { repo, w };
}
async function realFixture() {
  const f = fixture(':memory:', temp()),
    git = new LocalGitAdapter();
  await git.git(f.repo.repo_path, ['init', '-b', 'bridge/test']);
  await git.git(f.repo.repo_path, ['remote', 'add', 'origin', f.repo.repo_url]);
  writeFileSync(join(f.repo.repo_path, 'baseline.txt'), 'baseline\n');
  await git.git(f.repo.repo_path, ['add', 'baseline.txt']);
  await git.git(f.repo.repo_path, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'baseline',
  ]);
  f.engine = new Orchestrator(f.store, f.browser, f.codex, git);
  return { ...f, realGit: git };
}
function evidence(f: ReturnType<typeof fixture>, runId: string) {
  return JSON.parse(f.store.artifacts(runId).find((x) => x.kind === 'git-evidence')!.raw as string)
    .repositories['daily-repo'];
}

test('new UTF-8 source and documentation plus completed Codex patches reach the actual review packet', async () => {
  const f = await realFixture();
  try {
    const r = await ready(f);
    const source = 'export const greeting = "Hello, 世界 🌍";\n',
      doc = '# New guide\nReview this new documentation.\n';
    writeFileSync(join(f.repo.repo_path, 'new.ts'), source);
    writeFileSync(join(f.repo.repo_path, 'new.md'), doc);
    f.codex.result.items.push({
      id: 'patch',
      type: 'fileChange',
      status: 'completed',
      changes: [
        {
          path: join(f.repo.repo_path, 'new.ts'),
          kind: { type: 'add' },
          diff: '+ exact completed patch',
        },
      ],
    });
    const after = await f.engine.drive(f.p, r);
    assert.equal(after.state, 'WAITING_FOR_CHATGPT');
    const packet = f.store.chat(after.pending_chatgpt_id!).message;
    assert.ok(packet.includes(JSON.stringify(source)));
    assert.ok(packet.includes(JSON.stringify(doc)));
    assert.match(packet, /exact completed patch/);
    const e = evidence(f, after.id);
    assert.equal(e.untracked_content.find((x: any) => x.path === 'new.ts').content, source);
    assert.equal(
      readFileSync(e.untracked_content.find((x: any) => x.path === 'new.ts').snapshot_path, 'utf8'),
      source,
    );
    assert.equal(after.codex_turns, 1);
    assert.equal(after.turn_limit, 1);
  } finally {
    f.store.close();
  }
});

test('binary and invalid UTF-8 evidence sends metadata only and preserves complete private bytes', async () => {
  const f = await realFixture();
  try {
    const r = await ready(f),
      inputs = {
        'image.bin': Buffer.from([0, 1, 2, 3, 255]),
        'invalid.txt': Buffer.from([0xc3, 0x28]),
      };
    for (const [name, data] of Object.entries(inputs))
      writeFileSync(join(f.repo.repo_path, name), data);
    const after = await f.engine.drive(f.p, r);
    assert.equal(after.state, 'WAITING_FOR_CHATGPT');
    const e = evidence(f, r.id);
    for (const file of e.untracked_content) {
      assert.equal(file.kind, 'binary');
      assert.equal(file.content, undefined);
      assert.deepEqual(readFileSync(file.snapshot_path), inputs[file.path as keyof typeof inputs]);
      assert.match(file.omitted_reason, /metadata only/);
    }
    assert.match(f.store.chat(after.pending_chatgpt_id!).message, /invalid.txt/);
  } finally {
    f.store.close();
  }
});

test('per-file overflow stops review without prefix truncation and retains the entire file', async () => {
  const f = await realFixture();
  try {
    const r = await ready(f),
      content = 'é'.repeat(EVIDENCE_LIMITS.perFileBytes);
    writeFileSync(join(f.repo.repo_path, 'large.txt'), content);
    const after = await f.engine.drive(f.p, r);
    assert.equal(after.state, 'WAITING_FOR_USER');
    assert.match(after.reason, /FILE_EVIDENCE_TOO_LARGE/);
    assert.equal(after.pending_chatgpt_id, null);
    const file = evidence(f, r.id).untracked_content[0];
    assert.equal(file.content, undefined);
    assert.equal(readFileSync(file.snapshot_path, 'utf8'), content);
    assert.equal(file.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(f.store.artifacts(r.id).filter((x) => x.kind === 'chatgpt-message').length, 1);
  } finally {
    f.store.close();
  }
});

test('aggregate new-file limit halts review and snapshots every file completely', async () => {
  const f = await realFixture();
  try {
    const r = await ready(f),
      content = 'x'.repeat(24 * 1024);
    for (const name of ['a', 'b', 'c'])
      writeFileSync(join(f.repo.repo_path, name + '.txt'), content);
    const after = await f.engine.drive(f.p, r);
    assert.equal(after.state, 'WAITING_FOR_USER');
    assert.match(after.reason, /TOTAL_EVIDENCE_TOO_LARGE/);
    const files = evidence(f, r.id).untracked_content;
    assert.equal(files.length, 3);
    for (const file of files) assert.equal(readFileSync(file.snapshot_path, 'utf8'), content);
    assert.equal(files.filter((x: any) => x.content !== undefined).length, 2);
  } finally {
    f.store.close();
  }
});

test('full packet UTF-8 byte overflow retains raw review and never queues a partial review', async () => {
  const f = fixture();
  try {
    f.codex.result.final_response = '界'.repeat(40_000);
    const after = await f.engine.drive(f.p, await ready(f));
    assert.equal(after.state, 'WAITING_FOR_USER');
    assert.match(after.reason, /EVIDENCE_TOO_LARGE/);
    const raw = f.store.artifacts(after.id).find((x) => x.kind === 'chatgpt-review-body')!
      .raw as string;
    assert.ok(raw.includes(f.codex.result.final_response));
    assert.ok(Buffer.byteLength(raw) > 100_000);
    assert.equal(f.store.artifacts(after.id).filter((x) => x.kind === 'chatgpt-message').length, 1);
  } finally {
    f.store.close();
  }
});

test('oversized tracked Git output is fully archived instead of truncated', async () => {
  const f = await realFixture();
  try {
    const content = 'tracked change\n'.repeat(12_000);
    writeFileSync(join(f.repo.repo_path, 'baseline.txt'), content);
    const capture = await captureGit(
      f.repo.repo_path,
      ['diff', '--no-ext-diff', '--no-textconv'],
      temp(),
      1024,
    );
    assert.equal(capture.text, undefined);
    assert.ok(capture.issue);
    const raw = readFileSync(capture.snapshot_path, 'utf8');
    assert.ok(raw.length > 1024);
    assert.equal((raw.match(/\+tracked change/g) ?? []).length, 12_000);
  } finally {
    f.store.close();
  }
});

test('unsafe and missing untracked paths fail closed without reading outside the root', async () => {
  const root = temp(),
    archive = temp();
  writeFileSync(join(archive, 'private.txt'), 'outside private content');
  const result = await snapshotUntracked(
    root,
    ['../' + archive.split(/[\\/]/).at(-1) + '/private.txt', 'missing.txt'],
    archive,
  );
  assert.equal(result.issues.length, 2);
  assert.ok(result.files.every((x) => x.content === undefined && x.snapshot_path === undefined));
});

test('project registers multiple repositories atomically and rejects overlapping checkout or imported threads', () => {
  const f = fixture();
  try {
    second(f);
    assert.equal(f.store.repositories(f.p.project_id).length, 2);
    assert.equal(f.store.workstreams(f.p.project_id).length, 2);
    assert.throws(
      () =>
        f.store.addRepository({
          ...f.repo,
          repository_id: 'overlap',
          repo_path: join(f.repo.repo_path, 'nested'),
        }),
      /non-overlapping/,
    );
    assert.throws(
      () =>
        workstreamFromConfig(f.p.project_id, {
          repository_id: 'daily-repo',
          workstream_id: 'import',
          codex_thread_id: 'external',
        }),
      /THREAD_IMPORT_NOT_SUPPORTED/,
    );
    const bundle = registrationFromConfig({
      ...f.p,
      project_id: 'other',
      repositories: [{ ...f.repo, project_id: 'other', repo_path: temp() }],
      workstreams: [{ repository_id: 'unknown', workstream_id: 'bad' }],
    });
    assert.throws(() => f.store.register(bundle));
    assert.throws(() => f.store.project('other'), /other/);
  } finally {
    f.store.close();
  }
});

test('ChatGPT routes the exact instruction to the selected repository and matching workstream', async () => {
  const f = fixture();
  try {
    const { repo, w } = second(f);
    let r = await f.engine.start(f.p, 'Task', [repo.repository_id]);
    const rec = receipt(f, r);
    rec.response = response(
      rec.request_id,
      'CONTINUE_CODEX',
      'Exact NFL instruction.',
      repo.repository_id,
      w.workstream_id,
    );
    r = await f.engine.receive(f.p, r, rec);
    r = await f.engine.drive(f.p, r);
    assert.equal(r.state, 'WAITING_FOR_CHATGPT');
    assert.deepEqual(f.codex.calls, ['Exact NFL instruction.']);
    assert.equal(f.codex.contexts[0].repo_path, repo.repo_path);
    assert.equal(f.codex.contexts[0].repository_id, repo.repository_id);
    assert.equal(
      f.store.workstream(f.p.project_id, w.workstream_id).codex_thread_id,
      'thread-nfl-work',
    );
    assert.equal(f.store.workstream(f.p.project_id, 'main-work').codex_thread_id, null);
    const items = new Map([
      [
        'wrong',
        {
          type: 'fileChange',
          changes: [{ path: join(f.repo.repo_path, 'bad.ts'), kind: { type: 'add' } }],
        },
      ],
    ]);
    assert.equal(
      mayApprove(
        { ...f.codex.contexts[0], approval_policy: 'local-edits' },
        'item/fileChange/requestApproval',
        { itemId: 'wrong' },
        items,
      ),
      false,
    );
  } finally {
    f.store.close();
  }
});

for (const scenario of [
  'unregistered',
  'outside-run',
  'wrong-workstream',
  'unknown-workstream',
  'multiple',
  'disabled',
] as const)
  test(`routing fails closed: ${scenario}`, async () => {
    const f = fixture();
    try {
      const { repo, w } = second(f, scenario !== 'disabled');
      let r = await f.engine.start(f.p, 'Task', ['daily-repo']);
      const rec = receipt(f, r);
      const id =
        scenario === 'unregistered'
          ? 'invented'
          : scenario === 'outside-run' || scenario === 'disabled'
            ? repo.repository_id
            : 'daily-repo';
      const stream =
        scenario === 'wrong-workstream'
          ? w.workstream_id
          : scenario === 'unknown-workstream'
            ? 'invented'
            : 'main-work';
      rec.response = response(rec.request_id, 'CONTINUE_CODEX', 'Do work', id, stream);
      if (scenario === 'multiple')
        rec.response = rec.response.replace('["daily-repo"]', '["daily-repo","Daily-NFL"]');
      if (scenario === 'disabled')
        assert.throws(
          () =>
            resolveRoute(
              f.store,
              f.p,
              { ...r, authorized_repository_ids: [repo.repository_id] },
              { target_repos: [repo.repository_id], workstream_id: w.workstream_id },
            ),
          /Daily-NFL/,
        );
      r = await f.engine.receive(f.p, r, rec);
      assert.equal(r.state, 'WAITING_FOR_USER');
      await f.engine.drive(f.p, r);
      assert.equal(f.codex.calls.length, 0);
      assert.equal(f.store.repositories(f.p.project_id).length, 2);
    } finally {
      f.store.close();
    }
  });

test('workstream thread identity persists across database reopen and evidence stays separate by repository', async () => {
  const parent = temp(),
    repoRoot = join(parent, 'repo');
  mkdirSync(repoRoot);
  const f = fixture(join(parent, 'state', 'bridge.sqlite'), repoRoot);
  const { repo, w } = second(f);
  let r = await f.engine.drive(f.p, await ready(f));
  r = await f.engine.receive(f.p, r, receipt(f, r, 'TASK_COMPLETE'));
  const firstId = r.id;
  let next = await f.engine.start(f.p, 'Second repository', [repo.repository_id]);
  const rec = receipt(f, next);
  rec.response = response(
    rec.request_id,
    'CONTINUE_CODEX',
    'NFL task',
    repo.repository_id,
    w.workstream_id,
  );
  next = await f.engine.drive(f.p, await f.engine.receive(f.p, next, rec));
  const done = receipt(f, next, 'TASK_COMPLETE');
  await f.engine.receive(f.p, next, done);
  const firstEvidence = JSON.parse(
    f.store.artifacts(firstId).find((x) => x.kind === 'git-evidence')!.raw as string,
  );
  const secondEvidence = JSON.parse(
    f.store.artifacts(next.id).find((x) => x.kind === 'git-evidence')!.raw as string,
  );
  assert.deepEqual(Object.keys(firstEvidence.repositories), ['daily-repo']);
  assert.deepEqual(Object.keys(secondEvidence.repositories), ['Daily-NFL']);
  f.store.close();
  const store = new SQLiteStore(join(parent, 'state', 'bridge.sqlite'));
  try {
    assert.equal(store.workstream(f.p.project_id, 'main-work').codex_thread_id, 'durable-thread');
    assert.equal(
      store.workstream(f.p.project_id, w.workstream_id).codex_thread_id,
      'thread-nfl-work',
    );
    const codex = new FakeCodex();
    codex.thread = 'would-create-new-thread';
    const browser = new BrowserChatGPTAdapter(store),
      engine = new Orchestrator(store, browser, codex, new FakeGit());
    const reopened = { ...f, store, browser, codex, engine };
    const again = await engine.drive(store.project(f.p.project_id), await ready(reopened));
    assert.equal(again.state, 'WAITING_FOR_CHATGPT');
    assert.equal(codex.contexts[0].codex_thread_id, 'durable-thread');
    assert.throws(
      () =>
        store.saveWorkstream({
          ...store.workstream(f.p.project_id, 'main-work'),
          codex_thread_id: 'replacement',
        }),
      /WORKSTREAM_IDENTITY_CHANGE/,
    );
  } finally {
    store.close();
  }
});
