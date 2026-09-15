import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, threadIdentity, verifyThread } from '../src/core/protocol.js';
import { assertTransition } from '../src/core/state-machine.js';
import { mayApprove } from '../src/core/policy.js';
import { redact } from '../src/logging/redact.js';
import { fixture, receipt, response } from './helpers.js';
import { resolve } from 'node:path';
test('strict footer handles multiline exact instruction and every stop status', () => {
  const instruction = 'Fix x.\n\n  Keep literal $() and `code`.';
  assert.equal(
    parseDecision(response('r', 'CONTINUE_CODEX', instruction), 'r').instruction,
    instruction,
  );
  for (const s of [
    'USER_DECISION_REQUIRED',
    'TASK_COMPLETE',
    'PROJECT_PHASE_COMPLETE',
    'STOP_ERROR',
  ] as const)
    assert.equal(parseDecision(response('r', s), 'r').status, s);
});
test('ambiguous fields, stale correlation and contradictory user action are rejected', () => {
  for (const text of [
    response('old'),
    response('r') + '\nBRIDGE_STATUS: TASK_COMPLETE',
    response('r').replace('BRIDGE_USER_ACTION: NONE', 'BRIDGE_USER_ACTION: Approve spending'),
    response('r').replace('CONTINUE_CODEX', 'UNKNOWN'),
  ])
    assert.throws(() => parseDecision(text, 'r'));
});
test('thread identity rejects arbitrary hosts, new chats, query redirects and credentials', () => {
  for (const url of [
    'https://chatgpt.com/',
    'https://evil.test/c/1',
    'https://chatgpt.com.evil.test/c/1',
    'https://user@chatgpt.com/c/1',
    'https://chatgpt.com/c/1?x=y',
    'http://chatgpt.com/c/1',
  ])
    assert.throws(() => threadIdentity(url));
  assert.equal(
    threadIdentity('https://chatgpt.com/g/g-foo/c/abc/'),
    'https://chatgpt.com/g/g-foo/c/abc',
  );
});
test('pinned title adds a second mandatory thread identity check', () => {
  const f = fixture();
  try {
    assert.throws(() => verifyThread(f.p, f.p.chatgpt_thread_url, 'Different'));
  } finally {
    f.store.close();
  }
});
test('terminal states cannot restart and state graph prohibits skipping evidence', () => {
  assert.throws(() => assertTransition('COMPLETED', 'SEND_TO_CODEX'));
  assert.throws(() => assertTransition('WAITING_FOR_CODEX', 'SEND_TO_CHATGPT'));
  assertTransition('WAITING_FOR_CODEX', 'COLLECTING_EVIDENCE');
  assertTransition('WAITING_FOR_CODEX', 'WAITING_FOR_USER');
});
test('browser receipt rejects incomplete, stale and modified outbound messages', async () => {
  for (const change of [
    (r: any) => (r.response_complete = false),
    (r: any) => (r.response_follows_user_message = false),
    (r: any) => (r.observed_user_message += 'changed'),
    (r: any) => (r.captured_at = '2000-01-01T00:00:00Z'),
    (r: any) => (r.response_id = 'baseline'),
  ]) {
    const f = fixture();
    try {
      const run = await f.engine.start(f.p, 'Task');
      const rec = receipt(f, run);
      const t = f.store.chat(run.pending_chatgpt_id!);
      t.baseline_assistant_id = 'baseline';
      f.store.saveChat(t);
      change(rec);
      assert.throws(() => f.browser.accept(f.p, run, rec));
    } finally {
      f.store.close();
    }
  }
});
test('policy never accepts command, network or unknown requests', () => {
  const f = fixture();
  try {
    f.p.approval_policy = 'local-edits';
    for (const m of [
      'item/commandExecution/requestApproval',
      'item/permissions/requestApproval',
      'unknown',
    ])
      assert.equal(mayApprove(f.p, m, {}, new Map()), false);
  } finally {
    f.store.close();
  }
});
test('structured logs redact common secrets', () => {
  assert.deepEqual(
    redact({
      access_token: 'sensitive',
      message: 'Bearer token-secret',
      key: 'sk-abcdefghijklmnop',
    }),
    { access_token: '[REDACTED]', message: 'Bearer [REDACTED]', key: '[REDACTED]' },
  );
});
test('local edit approval rejects deletion, moves, dotgit and outside paths', () => {
  const f = fixture();
  try {
    f.p.approval_policy = 'local-edits';
    const items = new Map<string, any>();
    const approve = (path: string, kind: any) => {
      items.set('i', { type: 'fileChange', changes: [{ path, kind }] });
      return mayApprove(f.p, 'item/fileChange/requestApproval', { itemId: 'i' }, items);
    };
    assert.equal(approve(resolve('new-local-file.txt'), { type: 'add' }), true);
    assert.equal(approve(resolve('new-local-file.txt'), { type: 'delete' }), false);
    assert.equal(
      approve(resolve('new-local-file.txt'), { type: 'update', move_path: resolve('../outside') }),
      false,
    );
    assert.equal(approve(resolve('.git/config'), { type: 'update' }), false);
    assert.equal(approve(resolve('../outside'), { type: 'add' }), false);
  } finally {
    f.store.close();
  }
});
test('late browser handoff cannot be made fresh by replacing capture time', async () => {
  const f = fixture();
  try {
    const r = await f.engine.start(f.p, 'Task');
    const rec = receipt(f, r);
    const t = f.store.chat(r.pending_chatgpt_id!);
    t.claimed_at = new Date(Date.now() - f.p.timeout_ms - 1).toISOString();
    f.store.saveChat(t);
    assert.throws(() => f.browser.accept(f.p, r, rec), /deadline elapsed/);
  } finally {
    f.store.close();
  }
});
test('string completion flags and object response identities are rejected', async () => {
  for (const mutation of [
    (r: any) => (r.response_complete = 'true'),
    (r: any) => (r.response_id = { id: 'invented' }),
  ]) {
    const f = fixture();
    try {
      const run = await f.engine.start(f.p, 'Task');
      const rec = receipt(f, run);
      mutation(rec);
      assert.throws(() => f.browser.accept(f.p, run, rec));
    } finally {
      f.store.close();
    }
  }
});
