import { BridgeError, type Project, type Run, type Decision, type CodexContext } from './types.js';
import type { SQLiteStore } from '../adapters/storage/sqlite-adapter.js';
import { pathsOverlap } from '../config/project.js';
import { dirname } from 'node:path';
export function resolveRoute(
  store: SQLiteStore,
  p: Project,
  r: Run,
  d: Pick<Decision, 'target_repos' | 'workstream_id'>,
): CodexContext {
  if (r.project_id !== p.project_id) throw new BridgeError('WRONG_PROJECT');
  if (d.target_repos.length !== 1)
    throw new BridgeError(
      'MULTI_REPO_TURN_UNSUPPORTED',
      'Select exactly one authorized repository per turn; the bridge will not split or broaden an instruction.',
    );
  const id = d.target_repos[0];
  if (!r.authorized_repository_ids.includes(id))
    throw new BridgeError('UNAUTHORIZED_REPOSITORY', id);
  const repository = store.repository(p.project_id, id);
  if (!repository.enabled) throw new BridgeError('REPOSITORY_DISABLED', id);
  for (const other of store.repositories())
    if (
      (other.project_id !== p.project_id || other.repository_id !== id) &&
      pathsOverlap(repository.repo_path, other.repo_path)
    )
      throw new BridgeError('REPOSITORY_PATH_OVERLAP');
  if (store.path !== ':memory:' && pathsOverlap(repository.repo_path, dirname(store.path)))
    throw new BridgeError('STATE_REPOSITORY_OVERLAP');
  if (!d.workstream_id) throw new BridgeError('WORKSTREAM_REQUIRED');
  const workstream = store.workstream(p.project_id, d.workstream_id);
  if (workstream.repository_id !== id)
    throw new BridgeError(
      'WRONG_WORKSTREAM',
      'The selected workstream belongs to another repository.',
    );
  return {
    ...repository,
    workstream_id: workstream.workstream_id,
    codex_thread_id: workstream.codex_thread_id,
    timeout_ms: p.timeout_ms,
    approval_policy: p.approval_policy,
  };
}
