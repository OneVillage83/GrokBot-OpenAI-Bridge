#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SQLiteStore } from '../adapters/storage/sqlite-adapter.js';
import { BrowserChatGPTAdapter } from '../adapters/chatgpt/browser-adapter.js';
import { AppServerCodexAdapter } from '../adapters/codex/app-server-adapter.js';
import { LocalGitAdapter } from '../adapters/git/git-adapter.js';
import { codexCommand, codexEnv } from '../adapters/codex/process.js';
import { Orchestrator } from '../core/orchestrator.js';
import { BridgeError, now, type Run } from '../core/types.js';
import { verifyThread, hash } from '../core/protocol.js';
import { projectFromConfig } from '../config/project.js';
import { redact } from '../logging/redact.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const help = `GrokBot OpenAI Bridge — browser courier + Codex App Server

bridge init
bridge project add --file daily-line.json
bridge project list | show <project>
bridge project enable-autonomy <project> --acknowledge
bridge repo prepare <project> [--clone]
bridge auth codex [--device-auth]
bridge verify-chatgpt <project> --observed-url URL --title TITLE
bridge start <project> [--task "Continue DL-Agent-1"]
bridge outbox <project> [--output DIRECTORY]
bridge browser claim <project> --observed-url URL --title TITLE --baseline ASSISTANT_ID
bridge browser sent <project> --observed-url URL --title TITLE --message-id USER_MESSAGE_ID
bridge browser receive <project> --file receipt.json
bridge fingerprint --file captured-message.txt
bridge continue <project>
bridge pause <project>
bridge resume <project> [--additional-turns N | --decision-file FILE]
bridge recover <project>
bridge cancel <project> --reason TEXT
bridge status <project> | history <project> | doctor [project]
bridge logs [--run RUN_ID]
bridge artifacts --run RUN_ID [--output DIRECTORY]

All commands accept --data-dir DIRECTORY (default: BRIDGE_HOME or ~/.grokbot-openai-bridge).
ChatGPT handoffs use GrokBot's existing browser. No ChatGPT API or automatic new conversation.
See docs/QUICKSTART.md and docs/CHATGPT_BROWSER_WORKFLOW.md.`;
const opt: any = {};
for (const k of [
  'file',
  'output',
  'observed-url',
  'title',
  'baseline',
  'message-id',
  'task',
  'additional-turns',
  'decision-file',
  'reason',
  'run',
  'data-dir',
])
  opt[k] = { type: 'string' };
for (const k of ['help', 'clone', 'device-auth', 'acknowledge']) opt[k] = { type: 'boolean' };
const parsedArgs = parseArgs({ options: opt, allowPositionals: true });
const v = parsedArgs.values as Record<string, string | boolean | undefined>;
const a = parsedArgs.positionals;
const out = (x: unknown) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const required = (k: string) => {
  const x = v[k];
  if (typeof x !== 'string' || !x.trim())
    throw new BridgeError('MISSING_ARGUMENT', `--${k} is required`);
  return x;
};
const readJSON = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
function atomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + `.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}
async function main() {
  if (v.help || !a.length) {
    out(help);
    return;
  }
  if (a[0] === 'fingerprint') {
    out('sha256:' + hash(readFileSync(required('file'), 'utf8')));
    return;
  }
  const data = resolve(
    typeof v['data-dir'] === 'string'
      ? v['data-dir']
      : (process.env.BRIDGE_HOME ?? join(homedir(), '.grokbot-openai-bridge')),
  );
  if (a[0] === 'auth') {
    if (a[1] !== 'codex') throw new BridgeError('UNKNOWN_AUTH_TARGET');
    const c = codexCommand();
    const result = await new Promise<number>((res) => {
      const child = spawn(
        c.file,
        [...c.prefix, 'login', ...(v['device-auth'] ? ['--device-auth'] : [])],
        { stdio: 'inherit', windowsHide: true, env: codexEnv() },
      );
      child.on('error', () => res(1));
      child.on('exit', (code) => res(code ?? 1));
    });
    if (result !== 0) throw new BridgeError('CODEX_LOGIN_FAILED');
    return;
  }
  const store = new SQLiteStore(join(data, 'bridge.sqlite'));
  let release: (() => unknown) | undefined;
  let codex: AppServerCodexAdapter | undefined;
  try {
    if (a[0] === 'init') {
      const dest = join(data, 'daily-line.example.json');
      if (!existsSync(dest))
        atomic(dest, readFileSync(join(root, 'config/daily-line.example.json'), 'utf8'));
      out({
        database: store.path,
        project_template: dest,
        next: 'Fill the example in a separate daily-line.json, then bridge project add --file <path>.',
      });
      return;
    }
    if (a[0] === 'project' && a[1] === 'list') {
      out(store.projects());
      return;
    }
    if (a[0] === 'project' && a[1] === 'add') {
      const p = projectFromConfig(readJSON(required('file')));
      if (store.projects().some((x) => x.project_id === p.project_id))
        throw new BridgeError(
          'PROJECT_EXISTS',
          'Existing project identity cannot be silently overwritten.',
        );
      if (store.projects().some((x) => resolve(x.repo_path) === resolve(p.repo_path)))
        throw new BridgeError(
          'REPOSITORY_ALREADY_REGISTERED',
          'Use a separate checkout for another project.',
        );
      store.saveProject(p);
      out(p);
      return;
    }
    if (a[0] === 'logs') {
      out(store.logs(typeof v.run === 'string' ? v.run : undefined));
      return;
    }
    if (a[0] === 'artifacts') {
      const id = required('run');
      store.run(id);
      const rows = store.artifacts(id);
      if (v.output) {
        const dest = resolve(required('output'));
        for (const row of rows) atomic(join(dest, `${row.id}.txt`), row.raw as string);
        atomic(
          join(dest, 'index.json'),
          JSON.stringify(
            rows.map(({ raw, ...r }) => r),
            null,
            2,
          ),
        );
        out({
          exported: rows.length,
          directory: dest,
          privacy: 'Raw private transcripts; inspect before sharing.',
        });
      } else out(rows.map(({ raw, ...r }) => ({ ...r, bytes: Buffer.byteLength(raw as string) })));
      return;
    }
    const id = ['project', 'repo', 'browser'].includes(a[0]) ? a[2] : a[1];
    if (a[0] === 'doctor') {
      const checks: Array<{ check: string; ok: boolean; detail: unknown }> = [];
      const check = async (name: string, f: () => unknown | Promise<unknown>) => {
        try {
          checks.push({ check: name, ok: true, detail: await f() });
        } catch (e: any) {
          checks.push({ check: name, ok: false, detail: e.message });
        }
      };
      await check('state-database', () => store.db.prepare('PRAGMA quick_check').get());
      await check('skill-files', () => {
        if (!existsSync(join(root, 'skills/grokbot-openai-bridge/SKILL.md')))
          throw Error('Missing SKILL.md');
        return 'present';
      });
      await check('codex-app-server', async () => {
        codex = new AppServerCodexAdapter();
        await codex.connect();
        return 'initialize + initialized + config/read succeeded';
      });
      await check('codex-chatgpt-auth', async () => {
        if (!codex) throw Error('App Server unavailable');
        const r = await codex.account();
        if (r.type !== 'chatgpt') throw Error('ChatGPT login required; API-key accounts refused');
        return r;
      });
      const projects = id ? [store.project(id)] : store.projects();
      if (projects.length === 0)
        checks.push({
          check: 'project-configuration',
          ok: false,
          detail: 'No project configured. Add exact conversation and repository first.',
        });
      for (const p of projects) {
        await check(`${p.project_id}:repo`, async () => {
          await new LocalGitAdapter().verify(p, true);
          return { path: p.repo_path, branch: p.working_branch, clean: true };
        });
        await check(`${p.project_id}:chatgpt-url`, () => {
          verifyThread(p, p.chatgpt_thread_url, p.chatgpt_thread_title);
          return p.chatgpt_thread_url;
        });
        checks.push({
          check: `${p.project_id}:browser-readiness`,
          ok: false,
          detail:
            'Requires live GrokBot browser verification; CLI cannot independently observe that browser. Run verify-chatgpt with current observed URL and visible title.',
        });
      }
      out({ checks, ready: checks.every((c) => c.ok) });
      if (checks.some((c) => !c.ok)) process.exitCode = 2;
      return;
    }
    if (!id) throw new BridgeError('PROJECT_ID_REQUIRED');
    const p = store.project(id);
    if (a[0] === 'project' && a[1] === 'show') {
      out(p);
      return;
    }
    if (a[0] === 'status') {
      const r = store.latest(id);
      const t = r?.pending_chatgpt_id ? store.chat(r.pending_chatgpt_id) : undefined;
      out({
        project: p,
        run: r,
        browser_timeout_detected:
          !!t?.claimed_at &&
          t.status !== 'received' &&
          Date.now() - Date.parse(t.claimed_at) > p.timeout_ms,
      });
      return;
    }
    if (a[0] === 'history') {
      out(store.history(id).map((r) => ({ ...r, codex: store.codexTurns(r.id) })));
      return;
    }
    const latest = () => {
      const r = store.latest(id);
      if (!r) throw new BridgeError('RUN_NOT_FOUND');
      return r;
    };
    if (a[0] === 'pause') {
      const r = latest();
      store.transition(
        r,
        'PAUSED',
        'USER_PAUSED: active Codex will be interrupted; run recover before further work.',
      );
      out(r);
      return;
    }
    release = store.lock(id);
    const browser = new BrowserChatGPTAdapter(store);
    if (a[0] === 'verify-chatgpt') {
      verifyThread(p, required('observed-url'), required('title'));
      store.event(store.latest(id) ?? null, 'browser', 'operator-verification', {
        project_id: id,
        url: p.chatgpt_thread_url,
        observed_at: now(),
      });
      out({ verified: 'operator-attested URL and title match', independently_observed: false });
      return;
    }
    if (a[0] === 'project' && a[1] === 'enable-autonomy') {
      if (!v.acknowledge || !p.smoke_passed)
        throw new BridgeError(
          'SMOKE_TEST_REQUIRED',
          'Requires a completed controlled Codex turn and ChatGPT review, then human --acknowledge.',
        );
      p.autonomy_enabled = true;
      store.saveProject(p);
      store.event(store.latest(id) ?? null, 'human', 'autonomy-enabled');
      out(p);
      return;
    }
    if (a[0] === 'repo' && a[1] === 'prepare') {
      const active = store.latest(id);
      if (active && !['COMPLETED', 'FAILED'].includes(active.state))
        throw new BridgeError('ACTIVE_RUN_EXISTS');
      await new LocalGitAdapter().setup(p, !!v.clone);
      out({ repo: p.repo_path, branch: p.working_branch });
      return;
    }
    if (a[0] === 'outbox') {
      const r = latest();
      if (!r.pending_chatgpt_id) throw new BridgeError('NO_PENDING_CHATGPT_HANDOFF');
      const t = store.chat(r.pending_chatgpt_id);
      const packet = {
        ...t,
        target_url: p.chatgpt_thread_url,
        target_title: p.chatgpt_thread_title,
        send_authorized: t.status === 'pending' && r.state === 'WAITING_FOR_CHATGPT',
        instruction:
          t.status === 'pending'
            ? 'Verify the exact URL and visible title, then claim before posting.'
            : 'DO NOT RESEND. Locate the existing request in the exact thread and reconcile it.',
      };
      if (v.output) {
        const dest = resolve(required('output'));
        atomic(join(dest, `${t.id}.message.txt`), t.message);
        atomic(join(dest, `${t.id}.handoff.json`), JSON.stringify(packet, null, 2));
        out({ directory: dest, request_id: t.id, status: t.status });
      } else out(packet);
      return;
    }
    if (a[0] === 'browser' && ['claim', 'sent'].includes(a[1])) {
      const r = latest();
      if (r.state !== 'WAITING_FOR_CHATGPT' || !r.pending_chatgpt_id)
        throw new BridgeError('NO_PENDING_CHATGPT_HANDOFF');
      const t = store.chat(r.pending_chatgpt_id);
      try {
        if (a[1] === 'claim')
          browser.claim(p, t, required('observed-url'), required('title'), required('baseline'));
        else
          browser.sent(p, t, required('observed-url'), required('title'), required('message-id'));
        store.event(r, 'browser', a[1], { request_id: t.id });
        out(t);
      } catch (e: any) {
        store.transition(r, 'WAITING_FOR_USER', e.code ?? e.message);
        throw e;
      }
      return;
    }
    if (a[0] === 'cancel') {
      const r = latest();
      store.transition(r, 'FAILED', 'HUMAN_CANCELLED: ' + required('reason'));
      out({
        run: r,
        note: 'Recorded state only. Inspect Codex and repository before starting new work.',
      });
      return;
    }
    codex = new AppServerCodexAdapter();
    const engine = new Orchestrator(store, browser, codex, new LocalGitAdapter());
    let r: Run;
    if (a[0] === 'start')
      r = await engine.start(p, typeof v.task === 'string' ? v.task : 'Continue DL-Agent-1.');
    else if (a[0] === 'browser' && a[1] === 'receive')
      r = await engine.receive(p, latest(), readJSON(required('file')));
    else if (a[0] === 'continue') r = await engine.drive(p, latest());
    else if (a[0] === 'recover') r = await engine.recover(p, latest());
    else if (a[0] === 'resume') {
      r = latest();
      engine.resume(
        p,
        r,
        typeof v['additional-turns'] === 'string' ? Number(v['additional-turns']) : undefined,
        typeof v['decision-file'] === 'string'
          ? readFileSync(v['decision-file'], 'utf8')
          : undefined,
      );
      r = store.run(r.id);
    } else throw new BridgeError('UNKNOWN_COMMAND', help);
    out(r);
    if (r.state === 'WAITING_FOR_USER' || r.state === 'FAILED') process.exitCode = 2;
  } finally {
    await codex?.close();
    release?.();
    store.close();
  }
}
main().catch((e) => {
  out({ error: e.code ?? 'BRIDGE_ERROR', message: redact(e.message) });
  process.exitCode = 1;
});
