import { randomUUID } from 'node:crypto';
import { SQLiteStore } from '../src/adapters/storage/sqlite-adapter.js';
import {
  BrowserChatGPTAdapter,
  type BrowserReceipt,
} from '../src/adapters/chatgpt/browser-adapter.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import {
  projectFromConfig,
  repositoryFromConfig,
  workstreamFromConfig,
} from '../src/config/project.js';
import {
  BridgeError,
  now,
  type CodexContext,
  type ProjectRepository,
  type Run,
  type CodexAdapter,
  type CodexHooks,
  type CodexResult,
  type GitAdapter,
  type DecisionStatus,
} from '../src/core/types.js';
export class FakeCodex implements CodexAdapter {
  calls: string[] = [];
  contexts: CodexContext[] = [];
  auth = 'chatgpt';
  failure?: string;
  approval = false;
  thread = 'durable-thread';
  result: CodexResult = {
    status: 'completed',
    final_response: 'Implemented a local fix. Tests: 3 passed.',
    items: [
      {
        id: 'cmd1',
        type: 'commandExecution',
        command: 'npm test',
        exitCode: 0,
        aggregatedOutput: '3 passed',
        status: 'completed',
      },
    ],
  };
  async connect() {}
  async close() {}
  async account() {
    return { type: this.auth };
  }
  async ensureThread(p: CodexContext) {
    return (
      p.codex_thread_id ??
      (p.workstream_id === 'main-work' ? this.thread : 'thread-' + p.workstream_id)
    );
  }
  async execute(_p: CodexContext, instruction: string, _id: string, h: CodexHooks) {
    this.contexts.push({ ..._p });
    this.calls.push(instruction);
    h.onStarted('remote-turn');
    h.onEvent('item/completed', { item: this.result.items[0] });
    if (this.approval) {
      h.onApproval('item/commandExecution/requestApproval', { command: 'deploy production' });
      throw new BridgeError('CODEX_APPROVAL_REQUIRED');
    }
    if (this.failure) throw new BridgeError(this.failure);
    return this.result;
  }
  async readThread() {
    return { thread: { id: this.thread, turns: [{ id: 'remote-turn', ...this.result }] } };
  }
}
export class FakeGit implements GitAdapter {
  failure?: string;
  async verify() {
    if (this.failure) throw new BridgeError(this.failure);
  }
  async prepare() {
    await this.verify();
    return 'abc123';
  }
  async evidence(p: ProjectRepository) {
    await this.verify();
    return {
      repository_id: p.repository_id,
      logical_name: p.logical_name,
      head: 'def456',
      baseline_head: 'abc123',
      branch: 'bridge/test',
      status: ' M src/app.ts',
      files_changed: 'M src/app.ts',
      diff_stat: '1 file changed',
      diff: '+ fixed',
      untracked_files: [],
      untracked_content: [],
      issues: [],
    };
  }
}
export function fixture(path = ':memory:', repoPath = process.cwd()) {
  const store = new SQLiteStore(path);
  const p = projectFromConfig({
    project_id: 'daily-line',
    project_name: 'The Daily Line',
    chatgpt_thread_url: 'https://chatgpt.com/c/existing-thread',
    chatgpt_thread_title: 'Architecture',
  });
  store.saveProject(p);
  const repo = repositoryFromConfig(p.project_id, {
    repository_id: 'daily-repo',
    logical_name: 'Daily test repository',
    repo_url: 'https://github.com/example/daily-line.git',
    repo_path: repoPath,
    default_branch: 'main',
    working_branch: 'bridge/test',
    role: 'test',
  });
  const workstream = workstreamFromConfig(p.project_id, {
    workstream_id: 'main-work',
    repository_id: repo.repository_id,
  });
  store.addRepository(repo);
  store.addWorkstream(workstream);
  const browser = new BrowserChatGPTAdapter(store),
    codex = new FakeCodex(),
    git = new FakeGit(),
    engine = new Orchestrator(store, browser, codex, git);
  const context = (): CodexContext => ({
    ...repo,
    ...store.workstream(p.project_id, workstream.workstream_id),
    timeout_ms: p.timeout_ms,
    approval_policy: p.approval_policy,
  });
  return { store, p, repo, workstream, context, browser, codex, git, engine };
}
export function response(
  id: string,
  status: DecisionStatus = 'CONTINUE_CODEX',
  instruction = 'Fix the local test.\nPreserve the established architecture.',
  repositoryId = 'daily-repo',
  workstreamId = 'main-work',
) {
  const continuing = ['CONTINUE_CODEX', 'RETRY_CODEX'].includes(status);
  return `Review complete.\nBRIDGE_REQUEST_ID: ${id}\nBRIDGE_STATUS: ${status}\nBRIDGE_TARGET_REPOS: ${JSON.stringify(continuing ? [repositoryId] : [])}\nBRIDGE_WORKSTREAM: ${continuing ? workstreamId : 'NONE'}\nBRIDGE_CODEX_INSTRUCTION: ${continuing ? instruction : 'NONE'}\nBRIDGE_USER_ACTION: ${status === 'USER_DECISION_REQUIRED' ? 'Choose A or B.' : 'NONE'}\nBRIDGE_NOTES: Reviewed.`;
}
export function receipt(
  f: ReturnType<typeof fixture>,
  r: Run,
  status: DecisionStatus = 'CONTINUE_CODEX',
  instruction?: string,
): BrowserReceipt {
  const t = f.store.chat(r.pending_chatgpt_id!);
  f.browser.claim(
    f.p,
    t,
    f.p.chatgpt_thread_url,
    f.p.chatgpt_thread_title,
    'previous-' + randomUUID(),
  );
  return {
    request_id: t.id,
    observed_url: f.p.chatgpt_thread_url,
    observed_title: f.p.chatgpt_thread_title,
    user_message_id: randomUUID(),
    observed_user_message: t.message,
    response_id: randomUUID(),
    response: response(t.id, status, instruction),
    captured_at: now(),
    response_complete: true,
    response_follows_user_message: true,
  };
}
export async function ready(f: ReturnType<typeof fixture>, instruction?: string) {
  let r = await f.engine.start(f.p, 'Continue DL-Agent-1.');
  r = await f.engine.receive(f.p, r, receipt(f, r, 'CONTINUE_CODEX', instruction));
  return r;
}
