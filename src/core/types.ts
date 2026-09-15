export const states = [
  'IDLE',
  'PREPARING',
  'SEND_TO_CODEX',
  'WAITING_FOR_CODEX',
  'COLLECTING_EVIDENCE',
  'SEND_TO_CHATGPT',
  'WAITING_FOR_CHATGPT',
  'PARSING_CHATGPT_DECISION',
  'READY_FOR_NEXT_CODEX_TURN',
  'WAITING_FOR_USER',
  'COMPLETED',
  'FAILED',
  'PAUSED',
] as const;
export type State = (typeof states)[number];
export const statuses = [
  'CONTINUE_CODEX',
  'RETRY_CODEX',
  'USER_DECISION_REQUIRED',
  'TASK_COMPLETE',
  'PROJECT_PHASE_COMPLETE',
  'STOP_ERROR',
] as const;
export type DecisionStatus = (typeof statuses)[number];
export interface Decision {
  status: DecisionStatus;
  instruction: string;
  user_action: string;
  notes: string;
  request_id: string;
  target_repos: string[];
  workstream_id: string | null;
}
export interface Project {
  project_id: string;
  project_name: string;
  chatgpt_thread_url: string;
  chatgpt_thread_title: string;
  current_phase: string;
  current_task: string;
  last_completed_task: string;
  run_status: State;
  max_codex_turns_per_run: number;
  timeout_ms: number;
  approval_policy: 'human' | 'local-edits';
  smoke_passed: boolean;
  autonomy_enabled: boolean;
  created_at: string;
  updated_at: string;
}
export interface ProjectRepository {
  repository_id: string;
  project_id: string;
  logical_name: string;
  repo_url: string;
  repo_path: string;
  default_branch: string;
  working_branch: string;
  role: string;
  enabled: boolean;
}
export interface CodexWorkstream {
  workstream_id: string;
  project_id: string;
  repository_id: string;
  codex_thread_id: string | null;
  current_task: string;
  status: State;
}
/** Exactly one explicitly routed repository is writable in this release. */
export type CodexContext = ProjectRepository & {
  workstream_id: string;
  codex_thread_id: string | null;
  timeout_ms: number;
  approval_policy: Project['approval_policy'];
};
export interface ProjectRegistration {
  project: Project;
  repositories: ProjectRepository[];
  workstreams: CodexWorkstream[];
}
export interface Run {
  id: string;
  project_id: string;
  state: State;
  task: string;
  reason: string;
  codex_turns: number;
  turn_limit: number;
  controlled: boolean;
  smoke_reviewed: boolean;
  pending_instruction: string | null;
  pending_chatgpt_id: string | null;
  pending_codex_id: string | null;
  repository_baselines: Record<string, string>;
  authorized_repository_ids: string[];
  pending_repository_ids: string[];
  pending_workstream_id: string | null;
  migration_review_required?: boolean;
  created_at: string;
  updated_at: string;
}
export interface ChatTurn {
  id: string;
  run_id: string;
  project_id: string;
  kind: 'task' | 'review' | 'user-decision';
  message: string;
  message_sha256: string;
  status: 'pending' | 'claimed' | 'sent' | 'received';
  claimed_at?: string;
  baseline_assistant_id?: string;
  user_message_id?: string;
  response?: string;
  response_id?: string;
  decision?: Decision;
  created_at: string;
}
export interface CodexTurn {
  id: string;
  run_id: string;
  instruction: string;
  instruction_sha256: string;
  thread_id: string;
  repository_id: string;
  workstream_id: string;
  remote_turn_id: string | null;
  status: 'intent' | 'running' | 'completed' | 'failed' | 'interrupted';
  result?: CodexResult;
  created_at: string;
}
export interface CodexResult {
  status: string;
  final_response: string;
  items: unknown[];
  error?: unknown;
}
export interface GitEvidence {
  repository_id: string;
  logical_name: string;
  head: string;
  baseline_head: string;
  branch: string;
  status: string;
  files_changed: string;
  diff_stat: string;
  diff: string;
  untracked_files: string[];
  untracked_content: FileEvidence[];
  issues: string[];
  [key: string]: unknown;
}
export interface FileEvidence {
  path: string;
  kind: 'text' | 'binary' | 'unsafe' | 'unavailable';
  bytes?: number;
  sha256?: string;
  snapshot_path?: string;
  content?: string;
  omitted_reason?: string;
}
export interface GitAdapter {
  prepare(p: ProjectRepository): Promise<string>;
  verify(p: ProjectRepository, clean?: boolean): Promise<void>;
  evidence(p: ProjectRepository, baseline: string, archiveDirectory: string): Promise<GitEvidence>;
}
export interface CodexAdapter {
  connect(): Promise<void>;
  account(): Promise<{ type: string | null }>;
  ensureThread(p: CodexContext): Promise<string>;
  execute(
    p: CodexContext,
    instruction: string,
    turnId: string,
    hooks: CodexHooks,
  ): Promise<CodexResult>;
  readThread(threadId: string): Promise<any>;
  close(): Promise<void>;
}
export interface CodexHooks {
  onStarted(id: string): void;
  onEvent(method: string, params: unknown): void;
  onApproval(method: string, params: any): boolean;
  shouldPause(): boolean;
}
export class BridgeError extends Error {
  constructor(
    public code: string,
    message = code,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}
export const now = () => new Date().toISOString();
