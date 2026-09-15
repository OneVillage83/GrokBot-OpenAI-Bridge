import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { BridgeError } from '../../core/types.js';
export function codexCommand(): { file: string; prefix: string[] } {
  if (process.env.BRIDGE_CODEX_BIN) return { file: process.env.BRIDGE_CODEX_BIN, prefix: [] };
  try {
    return {
      file: process.execPath,
      prefix: [createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')],
    };
  } catch {}
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (existsSync(join(dir, 'codex.exe'))) return { file: join(dir, 'codex.exe'), prefix: [] };
      const js = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(js)) return { file: process.execPath, prefix: [js] };
    }
    throw new BridgeError(
      'CODEX_NOT_INSTALLED',
      'Install @openai/codex or set BRIDGE_CODEX_BIN to a native executable.',
    );
  }
  return { file: 'codex', prefix: [] };
}
export function codexEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/API_KEY|ACCESS_TOKEN|SECRET_ACCESS_KEY|SESSION_TOKEN/i.test(key)) delete env[key];
  if (env.BRIDGE_CODEX_HOME) env.CODEX_HOME = env.BRIDGE_CODEX_HOME;
  return env;
}
