import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { AppServerCodexAdapter } from '../src/adapters/codex/app-server-adapter.js';
import { fixture } from './helpers.js';
test('stdio adapter performs handshake, correlates RPC and handles completion before start response', async () => {
  const a = new AppServerCodexAdapter(1000, {
    file: process.execPath,
    prefix: [resolve('tests/fixtures/fake-app-server.mjs')],
  });
  const f = fixture();
  try {
    await a.connect();
    assert.deepEqual(await a.account(), { type: 'chatgpt' });
    const context = f.context();
    context.codex_thread_id = 'thread';
    let id = '';
    let submitted: any;
    const result = await a.execute(context, 'instruction', 'local-id', {
      onStarted: (x) => (id = x),
      onEvent: (method, params) => {
        if (method === 'bridge/test-request') submitted = params;
      },
      onApproval: () => false,
      shouldPause: () => false,
    });
    assert.equal(id, 'turn');
    assert.equal(result.status, 'completed');
    assert.equal(result.final_response, 'Streamed final');
    assert.equal(submitted.cwd, context.repo_path);
    assert.deepEqual(submitted.sandboxPolicy.writableRoots, [context.repo_path]);
    assert.equal(submitted.sandboxPolicy.networkAccess, false);
    await assert.rejects(() => a.request('invalid', {}), /Unknown method/);
  } finally {
    await a.close();
    f.store.close();
  }
});
