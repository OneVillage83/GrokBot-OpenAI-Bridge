import { AppServerCodexAdapter } from '../src/adapters/codex/app-server-adapter.js';
const adapter = new AppServerCodexAdapter();
try {
  await adapter.connect();
  const account = await adapter.account();
  if (account.type !== 'chatgpt') throw Error('ChatGPT login required');
  console.log(
    JSON.stringify(
      {
        connected: true,
        transport: 'App Server stdio',
        authentication: account.type,
        checked: ['initialize', 'initialized', 'config/read', 'account/read'],
        development_turn_sent: false,
      },
      null,
      2,
    ),
  );
} finally {
  await adapter.close();
}
