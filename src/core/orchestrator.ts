import { randomUUID } from 'node:crypto';
import {
  BridgeError,
  now,
  type Project,
  type Run,
  type ChatTurn,
  type CodexTurn,
  type CodexAdapter,
  type GitAdapter,
  type CodexResult,
} from './types.js';
import { envelope, hash, parseDecision } from './protocol.js';
import { mayApprove } from './policy.js';
import { BrowserChatGPTAdapter, type BrowserReceipt } from '../adapters/chatgpt/browser-adapter.js';
import { SQLiteStore } from '../adapters/storage/sqlite-adapter.js';
export class Orchestrator {
  constructor(
    public store: SQLiteStore,
    public browser: BrowserChatGPTAdapter,
    private codex: CodexAdapter,
    private git: GitAdapter,
  ) {}
  async start(p: Project, task: string) {
    const active = this.store.latest(p.project_id);
    if (active && !['COMPLETED', 'FAILED'].includes(active.state))
      throw new BridgeError(
        'DUPLICATE_RUN',
        'Resume or cancel the existing run; do not create another.',
      );
    const r: Run = {
      id: randomUUID(),
      project_id: p.project_id,
      state: 'IDLE',
      task,
      reason: '',
      codex_turns: 0,
      turn_limit: p.autonomy_enabled ? p.max_codex_turns_per_run : 1,
      controlled: !p.autonomy_enabled,
      smoke_reviewed: false,
      pending_instruction: null,
      pending_chatgpt_id: null,
      pending_codex_id: null,
      baseline_head: '',
      created_at: now(),
      updated_at: now(),
    };
    this.store.saveRun(r);
    this.store.transition(r, 'PREPARING');
    try {
      r.baseline_head = await this.git.prepare(p);
      if (this.store.run(r.id).state === 'PAUSED') return this.store.run(r.id);
      this.store.saveRun(r);
      this.queueChat(
        p,
        r,
        'task',
        `User task: ${task}\nDetermine the next precise Codex instruction using the existing architecture. ${r.controlled ? 'This is a controlled one-turn test: choose one small, safe local development task. The bridge will return evidence for review and stop before a second development turn.' : ''}`,
      );
    } catch (e) {
      this.halt(r, e);
    }
    return this.store.run(r.id);
  }
  queueChat(p: Project, r: Run, kind: ChatTurn['kind'], body: string) {
    this.store.tx(() => {
      this.store.transition(r, 'SEND_TO_CHATGPT');
      const id = randomUUID();
      const message = envelope(p, r, id, body);
      const t: ChatTurn = {
        id,
        run_id: r.id,
        project_id: p.project_id,
        kind,
        message,
        message_sha256: hash(message),
        status: 'pending',
        created_at: now(),
      };
      this.browser.enqueue(t);
      r.pending_chatgpt_id = id;
      if (kind === 'review') r.pending_codex_id = null;
      this.store.saveRun(r);
      this.store.artifact(r, 'chatgpt-message', message, id);
      this.store.transition(
        r,
        'WAITING_FOR_CHATGPT',
        'BROWSER_HANDOFF_REQUIRED: GrokBot must operate the configured existing thread.',
      );
    });
  }
  async receive(p: Project, r: Run, receipt: BrowserReceipt) {
    if (r.state !== 'WAITING_FOR_CHATGPT') throw new BridgeError('RUN_NOT_WAITING_FOR_CHATGPT');
    try {
      const t = this.browser.accept(p, r, receipt);
      this.store.transition(r, 'PARSING_CHATGPT_DECISION');
      this.decide(p, r, t);
    } catch (e) {
      this.halt(r, e);
    }
    return this.store.run(r.id);
  }
  private decide(p: Project, r: Run, t: ChatTurn) {
    const d = parseDecision(t.response!, t.id);
    this.store.tx(() => {
      t.decision = d;
      this.store.saveChat(t);
      this.store.artifact(r, 'chatgpt-decision', d, t.id);
      r.pending_chatgpt_id = null;
      if (t.kind === 'review' && r.controlled && r.codex_turns === 1 && d.status !== 'STOP_ERROR') {
        const last = this.store.codexTurns(r.id).at(-1);
        if (last?.result?.status === 'completed') {
          r.smoke_reviewed = true;
          p.smoke_passed = true;
          this.store.saveProject(p);
        }
      }
      this.store.saveRun(r);
      if (d.status === 'USER_DECISION_REQUIRED') {
        this.store.transition(r, 'WAITING_FOR_USER', d.user_action);
        return;
      }
      if (d.status === 'STOP_ERROR') {
        this.store.transition(r, 'FAILED', d.notes);
        return;
      }
      if (d.status === 'TASK_COMPLETE' || d.status === 'PROJECT_PHASE_COMPLETE') {
        p.last_completed_task = r.task;
        p.current_phase =
          d.status === 'PROJECT_PHASE_COMPLETE' ? 'phase-complete' : p.current_phase;
        this.store.saveProject(p);
        this.store.transition(r, 'COMPLETED', d.status + ': ' + d.notes);
        return;
      }
      r.pending_instruction = d.instruction;
      this.store.saveRun(r);
      if (r.codex_turns >= r.turn_limit) {
        this.store.transition(
          r,
          'PAUSED',
          r.controlled
            ? 'CONTROLLED_TEST_COMPLETE: review history before enabling autonomy.'
            : 'LOOP_LIMIT: explicit additional-turns required.',
        );
        return;
      }
      this.store.transition(r, 'READY_FOR_NEXT_CODEX_TURN');
    });
  }
  async drive(p: Project, r: Run) {
    if (r.state !== 'READY_FOR_NEXT_CODEX_TURN') return this.store.run(r.id);
    try {
      if (r.codex_turns >= r.turn_limit) {
        this.store.transition(r, 'PAUSED', 'LOOP_LIMIT');
        return r;
      }
      const instruction = r.pending_instruction;
      if (!instruction) throw new BridgeError('MISSING_INSTRUCTION');
      if (this.store.codexTurns(r.id).some((t) => t.instruction_sha256 === hash(instruction)))
        throw new BridgeError(
          'DUPLICATE_CODEX_INSTRUCTION',
          'Ask ChatGPT to provide an explicit corrected instruction; it will not be replayed automatically.',
        );
      await this.git.verify(p);
      await this.codex.connect();
      if ((await this.codex.account()).type !== 'chatgpt')
        throw new BridgeError('CODEX_CHATGPT_LOGIN_REQUIRED');
      p.codex_thread_id = await this.codex.ensureThread(p);
      this.store.saveProject(p);
      if (this.store.run(r.id).state === 'PAUSED') return this.store.run(r.id);
      this.store.transition(r, 'SEND_TO_CODEX');
      const t: CodexTurn = {
        id: randomUUID(),
        run_id: r.id,
        instruction,
        instruction_sha256: hash(instruction),
        thread_id: p.codex_thread_id,
        remote_turn_id: null,
        status: 'intent',
        created_at: now(),
      };
      this.store.tx(() => {
        this.store.saveCodex(t);
        r.pending_codex_id = t.id;
        r.pending_instruction = null;
        r.codex_turns++;
        this.store.saveRun(r);
        this.store.artifact(r, 'codex-instruction', instruction, t.id);
      });
      this.store.transition(r, 'WAITING_FOR_CODEX');
      const items = new Map<string, any>();
      const result = await this.codex.execute(p, instruction, t.id, {
        onStarted: (id) => {
          t.remote_turn_id = id;
          t.status = 'running';
          this.store.saveCodex(t);
        },
        onEvent: (method, params: any) => {
          this.store.artifact(r, 'codex-event', { method, params }, t.id);
          this.store.event(r, 'codex', method, {}, t.id);
          if (params?.item?.id) items.set(params.item.id, params.item);
        },
        onApproval: (method, params) => {
          const accepted = mayApprove(p, method, params, items);
          this.store.approval(r, {
            method,
            params,
            decision: accepted ? 'accept-local-edit' : 'denied-pending-human',
            turn_id: t.id,
          });
          return accepted;
        },
        shouldPause: () => this.store.run(r.id).state === 'PAUSED',
      });
      t.result = result;
      t.status =
        result.status === 'completed'
          ? 'completed'
          : result.status === 'interrupted'
            ? 'interrupted'
            : 'failed';
      this.store.saveCodex(t);
      this.store.artifact(r, 'codex-result', result, t.id);
      if (this.store.run(r.id).state === 'PAUSED') return this.store.run(r.id);
      await this.collect(p, r, t);
    } catch (e) {
      this.halt(this.store.run(r.id), e);
    } finally {
      await this.codex.close();
    }
    return this.store.run(r.id);
  }
  private async collect(p: Project, r: Run, t: CodexTurn) {
    this.store.transition(r, 'COLLECTING_EVIDENCE');
    const evidence = await this.git.evidence(p, r.baseline_head);
    this.store.artifact(r, 'git-evidence', evidence, t.id);
    const commands = (t.result?.items ?? []).filter((i: any) => i.type === 'commandExecution');
    this.store.artifact(r, 'test-and-command-output', commands, t.id);
    const body = `[GROKBOT OPENAI BRIDGE — CODEX RESULT]\nThe relayed instruction has finished with status ${t.result?.status}. A failed command or test is evidence requiring your review, not a success.\n\nCODEX RESULT (raw final message):\n${t.result?.final_response ?? ''}\n\nCOMMAND/TEST/BUILD/LINT/TYPECHECK EVIDENCE:\n${JSON.stringify(commands, null, 2)}\nOnly recorded command events establish which commands ran. Missing checks are NOT RUN / NOT OBSERVED. Codex narrative is a claim, not independently verified test evidence.\n\nCODEX ERROR:\n${JSON.stringify(t.result?.error ?? null)}\n\nGIT EVIDENCE:\n${JSON.stringify(evidence, null, 2)}\n\nReview against this conversation's established architecture. Return the next exact instruction or a stop decision. ${r.controlled ? 'The bridge will stop after this review before another Codex turn.' : ''}`;
    // Never silently truncate evidence or split one response into ambiguous messages.
    if (body.length > 100_000)
      throw new BridgeError(
        'EVIDENCE_TOO_LARGE',
        'Raw evidence saved. Human must review/transport the full artifact before proceeding.',
      );
    this.queueChat(p, r, 'review', body);
  }
  async recover(p: Project, r: Run) {
    try {
      if (['COMPLETED', 'FAILED'].includes(r.state)) return r;
      if (r.pending_codex_id && !r.pending_chatgpt_id) {
        const t = this.store.codex(r.pending_codex_id);
        if (!t.result) {
          if (!t.remote_turn_id)
            throw new BridgeError(
              'UNCERTAIN_CODEX_SEND',
              'Intent persisted without remote turn ID. Inspect Codex history manually; never replay this instruction.',
            );
          await this.codex.connect();
          const data = await this.codex.readThread(t.thread_id);
          if (data.thread.id !== t.thread_id) throw new BridgeError('WRONG_CODEX_THREAD');
          const remote = data.thread.turns?.find((x: any) => x.id === t.remote_turn_id);
          if (!remote || remote.status === 'inProgress')
            throw new BridgeError(
              'CODEX_RECONCILIATION_REQUIRED',
              'Turn is unavailable or still active. Inspect Codex; no new turn will start.',
            );
          const result: CodexResult = {
            status: remote.status,
            final_response: (remote.items ?? [])
              .filter((x: any) => x.type === 'agentMessage')
              .map((x: any) => x.text)
              .join('\n\n'),
            items: remote.items ?? [],
            error: remote.error,
          };
          t.result = result;
          t.status = result.status === 'completed' ? 'completed' : 'failed';
          this.store.saveCodex(t);
          this.store.artifact(r, 'codex-result-recovered', result, t.id);
        }
        if (
          !['WAITING_FOR_CODEX', 'WAITING_FOR_USER', 'PAUSED', 'COLLECTING_EVIDENCE'].includes(
            r.state,
          )
        )
          this.store.transition(r, 'WAITING_FOR_USER', 'RECONCILING_CODEX');
        await this.collect(p, r, t);
      } else if (r.pending_chatgpt_id) {
        const t = this.store.chat(r.pending_chatgpt_id);
        if (t.status === 'received') {
          if (r.state !== 'PARSING_CHATGPT_DECISION')
            this.store.transition(r, 'PARSING_CHATGPT_DECISION');
          this.decide(p, r, t);
        } else {
          if (r.state !== 'WAITING_FOR_CHATGPT')
            this.store.transition(
              r,
              'WAITING_FOR_CHATGPT',
              'Reconcile the existing handoff. A claimed message must not be sent twice.',
            );
        }
      } else if (r.state !== 'READY_FOR_NEXT_CODEX_TURN')
        throw new BridgeError(
          'MANUAL_RECOVERY_REQUIRED',
          'Inspect artifacts and pending instructions; no automatic replay.',
        );
    } catch (e) {
      this.halt(r, e);
    } finally {
      await this.codex.close();
    }
    return this.store.run(r.id);
  }
  resume(p: Project, r: Run, additional?: number, userDecision?: string) {
    if (r.pending_codex_id)
      throw new BridgeError(
        'RECOVER_REQUIRED',
        'Run bridge recover first to collect the original turn.',
      );
    if (
      r.pending_chatgpt_id &&
      !(userDecision && this.store.chat(r.pending_chatgpt_id).status === 'received')
    )
      throw new BridgeError(
        'RECOVER_REQUIRED',
        'Run bridge recover, then reconcile the original browser handoff.',
      );
    if (userDecision) {
      if (!['WAITING_FOR_USER', 'PAUSED'].includes(r.state))
        throw new BridgeError('NO_USER_DECISION_PENDING');
      r.pending_chatgpt_id = null;
      this.store.saveRun(r);
      this.store.artifact(r, 'human-decision', userDecision);
      this.queueChat(
        p,
        r,
        'user-decision',
        `Human response to the bridge stop (${r.reason}):\n${userDecision}\nUse this decision to formulate the next exact instruction. Do not treat it as authorization to bypass bridge approval boundaries.`,
      );
      return;
    }
    if (r.state !== 'PAUSED' || !r.pending_instruction)
      throw new BridgeError(
        'USER_DECISION_REQUIRED',
        'Supply --decision-file to send the human decision to ChatGPT.',
      );
    if (r.controlled && !p.autonomy_enabled)
      throw new BridgeError(
        'CONTROLLED_TEST_REVIEW_REQUIRED',
        'Review the one-turn test, then explicitly enable autonomy.',
      );
    if (r.codex_turns >= r.turn_limit) {
      if (!additional || !Number.isSafeInteger(additional) || additional < 1 || additional > 20)
        throw new BridgeError(
          'ADDITIONAL_TURN_LIMIT_REQUIRED',
          'Use --additional-turns 1..20 after reviewing the run.',
        );
      r.turn_limit += additional;
    }
    r.controlled = false;
    this.store.saveRun(r);
    this.store.transition(r, 'READY_FOR_NEXT_CODEX_TURN');
  }
  halt(r: Run, error: unknown) {
    const e =
      error instanceof BridgeError ? error : new BridgeError('UNEXPECTED_ERROR', String(error));
    this.store.event(r, 'bridge', 'error', { code: e.code, message: e.message });
    if (!['COMPLETED', 'FAILED'].includes(r.state))
      this.store.transition(
        r,
        e.code === 'USER_PAUSED' ? 'PAUSED' : 'WAITING_FOR_USER',
        `${e.code}: ${e.message}`,
      );
  }
}
