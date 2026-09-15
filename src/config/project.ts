import { isAbsolute, resolve, relative, dirname, join, basename } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import {
  BridgeError,
  now,
  type Project,
  type ProjectRegistration,
  type ProjectRepository,
  type CodexWorkstream,
} from '../core/types.js';
import { threadIdentity } from '../core/protocol.js';
function required(c: any, keys: string[]) {
  for (const key of keys)
    if (typeof c?.[key] !== 'string' || !c[key].trim())
      throw new BridgeError('INVALID_CONFIG', `Missing ${key}`);
}
export function identifier(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value))
    throw new BridgeError('INVALID_IDENTIFIER', value);
}
export function canonicalPath(path: string) {
  let parent = resolve(path);
  const tail: string[] = [];
  while (!existsSync(parent)) {
    tail.unshift(basename(parent));
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const canonical = join(realpathSync(parent), ...tail);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
export function pathsOverlap(a: string, b: string) {
  const x = canonicalPath(a),
    y = canonicalPath(b);
  const child = (root: string, path: string) => {
    const r = relative(root, path);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  return child(x, y) || child(y, x);
}
export function projectFromConfig(c: any): Project {
  required(c, ['project_id', 'project_name', 'chatgpt_thread_url', 'chatgpt_thread_title']);
  identifier(c.project_id);
  const max = c.max_codex_turns_per_run ?? 5,
    timeout = c.timeout_ms ?? 900_000;
  if (
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 20 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1000 ||
    timeout > 7_200_000
  )
    throw new BridgeError('INVALID_LIMITS');
  if (c.chatgpt_mode && c.chatgpt_mode !== 'browser') throw new BridgeError('API_MODE_DISABLED');
  if (c.approval_policy && !['human', 'local-edits'].includes(c.approval_policy))
    throw new BridgeError('INVALID_APPROVAL_POLICY');
  return {
    project_id: c.project_id,
    project_name: c.project_name,
    chatgpt_thread_url: threadIdentity(c.chatgpt_thread_url),
    chatgpt_thread_title: c.chatgpt_thread_title,
    current_phase: 'initial',
    current_task: '',
    last_completed_task: '',
    run_status: 'IDLE',
    max_codex_turns_per_run: max,
    timeout_ms: timeout,
    approval_policy: c.approval_policy ?? 'human',
    smoke_passed: false,
    autonomy_enabled: false,
    created_at: now(),
    updated_at: now(),
  };
}
export function repositoryFromConfig(projectId: string, c: any): ProjectRepository {
  required(c, [
    'repository_id',
    'logical_name',
    'repo_url',
    'repo_path',
    'default_branch',
    'working_branch',
    'role',
  ]);
  identifier(c.repository_id);
  if (c.project_id && c.project_id !== projectId) throw new BridgeError('WRONG_PROJECT');
  if (!isAbsolute(c.repo_path)) throw new BridgeError('INVALID_REPO_PATH');
  if (
    c.repo_url.startsWith('-') ||
    /[\r\n]/.test(c.repo_url) ||
    /^https?:\/\/[^/]*@/.test(c.repo_url)
  )
    throw new BridgeError('INVALID_REPO_URL', 'Do not embed credentials in repository URLs.');
  for (const branch of [c.default_branch, c.working_branch])
    if (branch.startsWith('-') || /[\s~^:?*\[\\]/.test(branch) || branch.includes('..'))
      throw new BridgeError('INVALID_BRANCH');
  if (
    c.working_branch === c.default_branch ||
    /^(main|master|production|prod)$/i.test(c.working_branch)
  )
    throw new BridgeError('INVALID_WORKING_BRANCH');
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean')
    throw new BridgeError('INVALID_ENABLED_FLAG');
  return {
    project_id: projectId,
    repository_id: c.repository_id,
    logical_name: c.logical_name,
    repo_url: c.repo_url,
    repo_path: resolve(c.repo_path),
    default_branch: c.default_branch,
    working_branch: c.working_branch,
    role: c.role,
    enabled: c.enabled ?? true,
  };
}
export function workstreamFromConfig(projectId: string, c: any): CodexWorkstream {
  required(c, ['workstream_id', 'repository_id']);
  identifier(c.workstream_id);
  identifier(c.repository_id);
  if (c.project_id && c.project_id !== projectId) throw new BridgeError('WRONG_PROJECT');
  if (c.codex_thread_id) throw new BridgeError('THREAD_IMPORT_NOT_SUPPORTED');
  return {
    project_id: projectId,
    workstream_id: c.workstream_id,
    repository_id: c.repository_id,
    codex_thread_id: null,
    current_task: '',
    status: 'IDLE',
  };
}
export function registrationFromConfig(c: any): ProjectRegistration {
  const project = projectFromConfig(c);
  if (
    !Array.isArray(c.repositories) ||
    !c.repositories.length ||
    !Array.isArray(c.workstreams) ||
    !c.workstreams.length
  )
    throw new BridgeError(
      'REPOSITORY_REGISTRY_REQUIRED',
      'Use the v2 repositories and workstreams arrays; legacy single-repo JSON must be converted.',
    );
  return {
    project,
    repositories: c.repositories.map((r: any) => repositoryFromConfig(project.project_id, r)),
    workstreams: c.workstreams.map((w: any) => workstreamFromConfig(project.project_id, w)),
  };
}
