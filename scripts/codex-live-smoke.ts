import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppServerCodexAdapter } from '../src/adapters/codex/app-server-adapter.js';
import { projectFromConfig } from '../src/config/project.js';
const dir = resolve('.local/codex-live-smoke');
mkdirSync(dir, { recursive: true });
const p = projectFromConfig({
  project_id: 'adapter-smoke',
  project_name: 'Adapter smoke (no project architecture)',
  chatgpt_thread_url: 'https://chatgpt.com/c/not-used',
  chatgpt_thread_title: 'not-used',
  repo_url: 'https://example.invalid/not-used.git',
  repo_path: dir,
  working_branch: 'bridge/smoke',
  timeout_ms: 120000,
});
const adapter = new AppServerCodexAdapter();
const events: unknown[] = [];
try {
  await adapter.connect();
  p.codex_thread_id = await adapter.ensureThread(p);
  const result = await adapter.execute(
    p,
    'Connection test only. Reply with exactly BRIDGE_CODEX_SMOKE_OK. Do not use tools, inspect files, change files, or do development work.',
    randomUUID(),
    {
      onStarted: (id) => events.push({ started: id }),
      onEvent: (method, params) => events.push({ method, params }),
      onApproval: () => false,
      shouldPause: () => false,
    },
  );
  if (result.status !== 'completed' || result.final_response.trim() !== 'BRIDGE_CODEX_SMOKE_OK')
    throw Error(JSON.stringify(result));
  const resumed = await adapter.ensureThread(p);
  if (resumed !== p.codex_thread_id) throw Error('Thread resume mismatch');
  const report = {
    checked_at: new Date().toISOString(),
    connected: true,
    authentication: (await adapter.account()).type,
    thread_id: p.codex_thread_id,
    resumed_same_thread: true,
    status: result.status,
    final_response: result.final_response,
    event_count: events.length,
    chatgpt_browser_tested: false,
  };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(resolve(dir, 'events.json'), JSON.stringify(events, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await adapter.close();
}
