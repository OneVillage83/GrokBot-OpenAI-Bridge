import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, receipt, ready, FakeCodex, FakeGit } from './helpers.js';
import { SQLiteStore } from '../src/adapters/storage/sqlite-adapter.js';
import { BrowserChatGPTAdapter } from '../src/adapters/chatgpt/browser-adapter.js';
import { Orchestrator } from '../src/core/orchestrator.js';
test('successful controlled loop preserves raw instruction, evidence, decisions and durable thread', async () => {
  const f = fixture();
  try {
    const exact = 'Change only the fixture.\n\n  Keep this indentation.';
    let r = await ready(f, exact);
    assert.equal(r.state, 'READY_FOR_NEXT_CODEX_TURN');
    r = await f.engine.drive(f.p, r);
    assert.deepEqual(f.codex.calls, [exact]);
    assert.equal(
      f.store.workstream(f.p.project_id, f.workstream.workstream_id).codex_thread_id,
      'durable-thread',
    );
    assert.equal(r.state, 'WAITING_FOR_CHATGPT');
    const message = f.store.chat(r.pending_chatgpt_id!).message;
    assert.match(message, /npm test/);
    assert.match(message, /3 passed/);
    assert.match(message, /def456/);
    r = await f.engine.receive(f.p, r, receipt(f, r, 'TASK_COMPLETE'));
    assert.equal(r.state, 'COMPLETED');
    assert.equal(f.store.project(f.p.project_id).smoke_passed, true);
    assert.equal(f.store.project(f.p.project_id).autonomy_enabled, false);
    const kinds = f.store.artifacts(r.id).map((x) => x.kind);
    for (const k of [
      'chatgpt-message',
      'chatgpt-response',
      'codex-instruction',
      'codex-result',
      'test-and-command-output',
      'git-evidence',
    ])
      assert.ok(kinds.includes(k));
  } finally {
    f.store.close();
  }
});
test('ChatGPT continue at first review pauses before second development turn', async () => {
  const f = fixture();
  try {
    let r = await f.engine.drive(f.p, await ready(f));
    r = await f.engine.receive(f.p, r, receipt(f, r, 'CONTINUE_CODEX', 'Second task'));
    assert.equal(r.state, 'PAUSED');
    assert.equal(r.codex_turns, 1);
    await f.engine.drive(f.p, r);
    assert.equal(f.codex.calls.length, 1);
    assert.throws(() => f.engine.resume(f.p, r, 1), /Review the one-turn test/);
  } finally {
    f.store.close();
  }
});
test('explicit autonomy allows continue and reuses project thread, then enforces turn cap', async () => {
  const f = fixture();
  try {
    f.p.autonomy_enabled = true;
    f.p.max_codex_turns_per_run = 2;
    f.store.saveProject(f.p);
    let r = await f.engine.drive(f.p, await ready(f));
    r = await f.engine.receive(f.p, r, receipt(f, r, 'CONTINUE_CODEX', 'Second task'));
    assert.equal(r.state, 'READY_FOR_NEXT_CODEX_TURN');
    r = await f.engine.drive(f.p, r);
    r = await f.engine.receive(f.p, r, receipt(f, r, 'CONTINUE_CODEX', 'Third task'));
    assert.equal(r.state, 'PAUSED');
    assert.equal(f.codex.calls.length, 2);
    assert.equal(f.store.codexTurns(r.id)[1].thread_id, 'durable-thread');
    assert.throws(() => f.engine.resume(f.p, r), /additional-turns/);
  } finally {
    f.store.close();
  }
});
test('user decision stops with exact question; human response goes back to ChatGPT', async () => {
  const f = fixture();
  try {
    let r = await f.engine.start(f.p, 'Task');
    r = await f.engine.receive(f.p, r, receipt(f, r, 'USER_DECISION_REQUIRED'));
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.equal(r.reason, 'Choose A or B.');
    f.engine.resume(f.p, r, undefined, 'Choose A');
    r = f.store.run(r.id);
    assert.equal(r.state, 'WAITING_FOR_CHATGPT');
    assert.match(f.store.chat(r.pending_chatgpt_id!).message, /Choose A/);
    assert.equal(f.codex.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('failed tests are faithfully sent for architectural review, never marked passed', async () => {
  const f = fixture();
  try {
    f.codex.result = {
      status: 'completed',
      final_response: 'Tests failed.',
      items: [
        {
          type: 'commandExecution',
          id: 'c',
          command: 'npm test',
          exitCode: 1,
          aggregatedOutput: '1 failed',
        },
      ],
    };
    let r = await f.engine.drive(f.p, await ready(f));
    assert.equal(r.state, 'WAITING_FOR_CHATGPT');
    assert.match(f.store.chat(r.pending_chatgpt_id!).message, /1 failed/);
    r = await f.engine.receive(f.p, r, receipt(f, r, 'RETRY_CODEX', 'Fix failing assertion.'));
    assert.equal(r.state, 'PAUSED');
  } finally {
    f.store.close();
  }
});
test('Codex completed event with failed status goes to ChatGPT with error', async () => {
  const f = fixture();
  try {
    f.codex.result = {
      status: 'failed',
      final_response: '',
      items: [],
      error: { message: 'usage limit' },
    };
    const r = await f.engine.drive(f.p, await ready(f));
    assert.equal(r.state, 'WAITING_FOR_CHATGPT');
    assert.match(f.store.chat(r.pending_chatgpt_id!).message, /usage limit/);
  } finally {
    f.store.close();
  }
});
test('Codex crash halts without replaying an uncertain instruction', async () => {
  const f = fixture();
  try {
    f.codex.failure = 'CODEX_PROCESS_CRASH';
    let r = await f.engine.drive(f.p, await ready(f));
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.match(r.reason, /CODEX_PROCESS_CRASH/);
    r = await f.engine.drive(f.p, r);
    assert.equal(f.codex.calls.length, 1);
    assert.ok(r.pending_codex_id);
  } finally {
    f.store.close();
  }
});
test('Codex approval request persisted and requires human involvement', async () => {
  const f = fixture();
  try {
    f.codex.approval = true;
    const r = await f.engine.drive(f.p, await ready(f));
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.match(r.reason, /CODEX_APPROVAL_REQUIRED/);
    const row = f.store.db.prepare('SELECT data FROM approvals').get();
    assert.match(String(row?.data), /denied-pending-human/);
  } finally {
    f.store.close();
  }
});
test('API-key authentication is refused before instruction dispatch', async () => {
  const f = fixture();
  try {
    f.codex.auth = 'apiKey';
    const r = await f.engine.drive(f.p, await ready(f));
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.equal(f.codex.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('wrong browser thread retains rejected receipt and stops', async () => {
  const f = fixture();
  try {
    let r = await f.engine.start(f.p, 'Task');
    const rec = receipt(f, r);
    rec.observed_url = 'https://chatgpt.com/c/wrong';
    r = await f.engine.receive(f.p, r, rec);
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.match(r.reason, /WRONG_CHATGPT_THREAD/);
    assert.ok(f.store.artifacts(r.id).some((x) => x.kind === 'browser-receipt-raw'));
    assert.equal(f.codex.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('duplicate assistant response is rejected', async () => {
  const f = fixture();
  try {
    let r = await f.engine.start(f.p, 'Task');
    const first = receipt(f, r);
    r = await f.engine.receive(f.p, r, first);
    r = await f.engine.drive(f.p, r);
    const second = receipt(f, r);
    second.response_id = first.response_id;
    r = await f.engine.receive(f.p, r, second);
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.match(r.reason, /DUPLICATE_CHATGPT_RESPONSE/);
  } finally {
    f.store.close();
  }
});
test('duplicate instruction is not executed twice even with different response IDs', async () => {
  const f = fixture();
  try {
    f.p.autonomy_enabled = true;
    let r = await f.engine.drive(f.p, await ready(f, 'Same instruction'));
    r = await f.engine.receive(f.p, r, receipt(f, r, 'RETRY_CODEX', 'Same instruction'));
    r = await f.engine.drive(f.p, r);
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.match(r.reason, /DUPLICATE_CODEX_INSTRUCTION/);
    assert.equal(f.codex.calls.length, 1);
  } finally {
    f.store.close();
  }
});
test('dirty repository, wrong branch and conflict stop before any dispatch', async () => {
  for (const code of ['DIRTY_WORKING_TREE', 'WRONG_BRANCH', 'GIT_CONFLICT']) {
    const f = fixture();
    try {
      f.git.failure = code;
      const r = await f.engine.start(f.p, 'Task');
      assert.equal(r.state, 'WAITING_FOR_USER');
      assert.equal(r.pending_chatgpt_id, null);
      assert.equal(f.codex.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('duplicate active run is rejected including a paused run', async () => {
  const f = fixture();
  try {
    const r = await f.engine.start(f.p, 'Task');
    f.store.transition(r, 'PAUSED');
    await assert.rejects(() => f.engine.start(f.p, 'Again'), /Resume or cancel/);
  } finally {
    f.store.close();
  }
});
test('claimed browser send survives process restart and cannot be claimed again', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bridge-recovery-')), 'state.sqlite');
  const f = fixture(path);
  let r = await f.engine.start(f.p, 'Task');
  const t = f.store.chat(r.pending_chatgpt_id!);
  f.browser.claim(f.p, t, f.p.chatgpt_thread_url, f.p.chatgpt_thread_title, 'baseline');
  f.store.close();
  const store = new SQLiteStore(path);
  try {
    const browser = new BrowserChatGPTAdapter(store);
    const engine = new Orchestrator(store, browser, new FakeCodex(), new FakeGit());
    r = await engine.recover(f.p, store.run(r.id));
    assert.equal(r.pending_chatgpt_id, t.id);
    assert.throws(
      () =>
        browser.claim(
          f.p,
          store.chat(t.id),
          f.p.chatgpt_thread_url,
          f.p.chatgpt_thread_title,
          'baseline',
        ),
      /Do not resend/,
    );
  } finally {
    store.close();
  }
});
test('Codex recovery collects completed original turn without executing again', async () => {
  const f = fixture();
  try {
    f.codex.failure = 'CODEX_PROCESS_CRASH';
    let r = await f.engine.drive(f.p, await ready(f));
    f.codex.failure = undefined;
    r = await f.engine.recover(f.p, r);
    assert.equal(r.state, 'WAITING_FOR_CHATGPT');
    assert.equal(f.codex.calls.length, 1);
    assert.ok(f.store.artifacts(r.id).some((x) => x.kind === 'codex-result-recovered'));
  } finally {
    f.store.close();
  }
});
test('uncertain send without remote id requires manual reconciliation', async () => {
  const f = fixture();
  try {
    f.codex.failure = 'CODEX_PROCESS_CRASH';
    let r = await f.engine.drive(f.p, await ready(f));
    const t = f.store.codex(r.pending_codex_id!);
    t.remote_turn_id = null;
    f.store.saveCodex(t);
    r = await f.engine.recover(f.p, r);
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.match(r.reason, /UNCERTAIN_CODEX_SEND/);
    assert.equal(f.codex.calls.length, 1);
  } finally {
    f.store.close();
  }
});
test('malformed ChatGPT response is retained and human can request a correction', async () => {
  const f = fixture();
  try {
    let r = await f.engine.start(f.p, 'Task');
    const rec = receipt(f, r);
    rec.response = 'Do something sensible.';
    r = await f.engine.receive(f.p, r, rec);
    assert.equal(r.state, 'WAITING_FOR_USER');
    assert.equal(f.store.chat(r.pending_chatgpt_id!).response, rec.response);
    f.engine.resume(f.p, r, undefined, 'Please return the required footer.');
    assert.equal(f.store.run(r.id).state, 'WAITING_FOR_CHATGPT');
  } finally {
    f.store.close();
  }
});
test('live lock prevents duplicate controllers and transitions are audited', async () => {
  const f = fixture();
  try {
    const release = f.store.lock(f.p.project_id);
    assert.throws(() => f.store.lock(f.p.project_id), /Another process/);
    release();
    const r = await f.engine.start(f.p, 'Task');
    const logs = f.store.logs(r.id);
    assert.deepEqual(
      logs.filter((x) => x.event === 'transition').map((x) => x.data.to),
      ['PREPARING', 'SEND_TO_CHATGPT', 'WAITING_FOR_CHATGPT'],
    );
  } finally {
    f.store.close();
  }
});
