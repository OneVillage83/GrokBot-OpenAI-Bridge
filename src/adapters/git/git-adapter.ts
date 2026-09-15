import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BridgeError, type Project, type GitAdapter, type GitEvidence } from '../../core/types.js';
const exec = promisify(execFile);
export class LocalGitAdapter implements GitAdapter {
  async git(cwd: string, args: string[]) {
    try {
      return (
        await exec(
          'git',
          ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args],
          {
            cwd,
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 32 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
          },
        )
      ).stdout;
    } catch (e: any) {
      throw new BridgeError('GIT_ERROR', e.stderr || e.message);
    }
  }
  async verify(p: Project, clean = false) {
    if (!existsSync(p.repo_path)) throw new BridgeError('REPOSITORY_MISSING');
    const top = (await this.git(p.repo_path, ['rev-parse', '--show-toplevel'])).trim();
    if (realpathSync(top) !== realpathSync(p.repo_path)) throw new BridgeError('WRONG_REPOSITORY');
    const origin = (await this.git(p.repo_path, ['remote', 'get-url', 'origin'])).trim();
    if (origin !== p.repo_url)
      throw new BridgeError('WRONG_REPOSITORY', 'origin differs from the registered URL');
    const branch = (await this.git(p.repo_path, ['branch', '--show-current'])).trim();
    if (branch !== p.working_branch || /^(main|master|production|prod)$/i.test(branch))
      throw new BridgeError(
        'WRONG_BRANCH',
        `Expected ${p.working_branch}, found ${branch || 'detached HEAD'}`,
      );
    if ((await this.git(p.repo_path, ['ls-files', '-u'])).trim())
      throw new BridgeError('GIT_CONFLICT');
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
      const path = (await this.git(p.repo_path, ['rev-parse', '--git-path', marker])).trim();
      if (existsSync(resolve(p.repo_path, path)))
        throw new BridgeError('GIT_OPERATION_IN_PROGRESS');
    }
    if (clean && (await this.git(p.repo_path, ['status', '--porcelain'])).trim())
      throw new BridgeError(
        'DIRTY_WORKING_TREE',
        'Commit or stash existing work yourself before a new run.',
      );
  }
  async setup(p: Project, clone: boolean) {
    if (!existsSync(p.repo_path)) {
      if (!clone)
        throw new BridgeError('REPOSITORY_MISSING', 'Use bridge repo prepare <project> --clone');
      await this.git(resolve(p.repo_path, '..'), ['clone', '--', p.repo_url, p.repo_path]);
    }
    const top = (await this.git(p.repo_path, ['rev-parse', '--show-toplevel'])).trim();
    if (
      realpathSync(top) !== realpathSync(p.repo_path) ||
      (await this.git(p.repo_path, ['remote', 'get-url', 'origin'])).trim() !== p.repo_url
    )
      throw new BridgeError('WRONG_REPOSITORY');
    if ((await this.git(p.repo_path, ['status', '--porcelain'])).trim())
      throw new BridgeError('DIRTY_WORKING_TREE');
    await this.git(p.repo_path, ['check-ref-format', '--branch', p.working_branch]);
    let exists = true;
    try {
      await this.git(p.repo_path, ['show-ref', '--verify', `refs/heads/${p.working_branch}`]);
    } catch {
      exists = false;
    }
    await this.git(
      p.repo_path,
      exists ? ['switch', p.working_branch] : ['switch', '-c', p.working_branch],
    );
    await this.verify(p, true);
  }
  async prepare(p: Project) {
    await this.verify(p, true);
    return (await this.git(p.repo_path, ['rev-parse', 'HEAD'])).trim();
  }
  async evidence(p: Project, baseline: string): Promise<GitEvidence> {
    await this.verify(p);
    const commands = [
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain=v1'],
      ['diff', '--no-ext-diff', '--no-textconv', '--name-status', baseline, '--'],
      ['diff', '--no-ext-diff', '--no-textconv', '--stat', baseline, '--'],
      ['diff', '--no-ext-diff', '--no-textconv', '--binary', baseline, '--'],
      ['ls-files', '--others', '--exclude-standard', '-z'],
      ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--stat'],
      ['log', '--format=%H %s', `${baseline}..HEAD`],
    ];
    const values = await Promise.all(commands.map((a) => this.git(p.repo_path, a)));
    return {
      head: values[0].trim(),
      baseline_head: baseline,
      branch: p.working_branch,
      status: values[1],
      files_changed: values[2],
      diff_stat: values[3],
      diff: values[4],
      untracked_files: values[5].split('\0').filter(Boolean),
      staged_stat: values[6],
      commits: values[7],
      untracked_content:
        'Not captured automatically; filenames and Codex file-change events retained.',
    };
  }
}
