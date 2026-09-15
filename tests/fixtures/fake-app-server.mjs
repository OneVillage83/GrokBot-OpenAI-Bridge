import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'config/read')
    send({ id: m.id, result: { config: { mcp_servers: { external: { enabled: true } } } } });
  else if (m.method === 'account/read')
    send({ id: m.id, result: { account: { type: 'chatgpt' } } });
  else if (m.method === 'turn/start') {
    send({ method: 'bridge/test-request', params: m.params });
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: { id: 'final', type: 'agentMessage', text: 'Streamed final' },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'unrelated-thread', turn: { id: 'other', status: 'failed' } },
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } },
    });
    send({ id: m.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
  } else send({ id: m.id, error: { code: -32601, message: 'Unknown method' } });
});
