import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGitAdapter } from '../src/adapters/git/git-adapter.js';
import { projectFromConfig } from '../src/config/project.js';
test('real Git checks branch/origin/dirty state and collects committed, unstaged and untracked evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-git-'));
  const git = new LocalGitAdapter();
  await git.git(dir, ['init', '-b', 'main']);
  await git.git(dir, ['remote', 'add', 'origin', 'https://example.invalid/bridge-test.git']);
  writeFileSync(join(dir, 'file.txt'), 'baseline\n');
  await git.git(dir, ['add', 'file.txt']);
  await git.git(dir, [
    '-c',
    'user.name=Bridge Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'baseline',
  ]);
  const p = projectFromConfig({
    project_id: 'git-test',
    project_name: 'Git test',
    chatgpt_thread_url: 'https://chatgpt.com/c/test',
    chatgpt_thread_title: 'Test',
    repo_url: 'https://example.invalid/bridge-test.git',
    repo_path: dir,
    working_branch: 'bridge/test',
  });
  await assert.rejects(() => git.verify(p), /Expected bridge\/test/);
  await git.setup(p, false);
  const baseline = await git.prepare(p);
  writeFileSync(join(dir, 'file.txt'), 'committed change\n');
  await git.git(dir, ['add', 'file.txt']);
  await git.git(dir, [
    '-c',
    'user.name=Bridge Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'change',
  ]);
  writeFileSync(join(dir, 'file.txt'), 'unstaged final\n');
  writeFileSync(join(dir, 'new.txt'), 'untracked\n');
  const evidence = await git.evidence(p, baseline);
  assert.notEqual(evidence.head, baseline);
  assert.match(evidence.diff, /unstaged final/);
  assert.match(evidence.files_changed, /file.txt/);
  assert.ok(evidence.untracked_files.includes('new.txt'));
  assert.match(String(evidence.commits), /change/);
  await assert.rejects(() => git.verify(p, true), /Commit or stash/);
  p.repo_url = 'https://example.invalid/wrong.git';
  await assert.rejects(() => git.verify(p), /origin differs/);
  const child = join(dir, 'child');
  mkdirSync(child);
  p.repo_path = child;
  await assert.rejects(() => git.verify(p), /WRONG_REPOSITORY/);
});
