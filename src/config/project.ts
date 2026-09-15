import { isAbsolute } from 'node:path';
import { BridgeError, now, type Project } from '../core/types.js';
import { threadIdentity } from '../core/protocol.js';
export function projectFromConfig(c: any): Project {
  for (const key of [
    'project_id',
    'project_name',
    'chatgpt_thread_url',
    'chatgpt_thread_title',
    'repo_url',
    'repo_path',
    'working_branch',
  ])
    if (typeof c[key] !== 'string' || !c[key].trim())
      throw new BridgeError('INVALID_CONFIG', `Missing ${key}`);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.project_id)) throw new BridgeError('INVALID_PROJECT_ID');
  threadIdentity(c.chatgpt_thread_url);
  if (!isAbsolute(c.repo_path))
    throw new BridgeError('INVALID_REPO_PATH', 'Use an absolute repository path.');
  if (
    c.repo_url.startsWith('-') ||
    /[\r\n]/.test(c.repo_url) ||
    /^https?:\/\/[^/]*@/.test(c.repo_url)
  )
    throw new BridgeError('INVALID_REPO_URL', 'Do not embed credentials in repository URLs.');
  if (
    /^(main|master|production|prod)$/i.test(c.working_branch) ||
    c.working_branch.startsWith('-') ||
    /[\s~^:?*\[\\]/.test(c.working_branch) ||
    c.working_branch.includes('..')
  )
    throw new BridgeError('INVALID_WORKING_BRANCH');
  const max = c.max_codex_turns_per_run ?? 5;
  const timeout = c.timeout_ms ?? 900_000;
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
    repo_url: c.repo_url,
    repo_path: c.repo_path,
    working_branch: c.working_branch,
    codex_thread_id: null,
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
