import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError } from '../../core/types.js';
/** Capture stdout to disk without maxBuffer truncation. Return text only under its explicit budget. */
export async function captureGit(cwd: string, args: string[], archive: string, maxBytes: number) {
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const path = join(archive, `${randomUUID()}.git-output`);
  const output = await open(path, 'wx', 0o600);
  const child = spawn(
    'git',
    ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args],
    {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let failure: Error | undefined,
    stderr = '';
  child.stderr.on('data', (b) => {
    if (stderr.length < 4096) stderr += b.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (e) => {
      failure = e;
      resolve(null);
    });
    child.once('close', resolve);
  });
  const timeout = setTimeout(() => {
    failure = new BridgeError('GIT_TIMEOUT');
    child.kill();
  }, 30_000);
  const chunks: Buffer[] = [];
  let bytes = 0;
  const digest = createHash('sha256');
  try {
    for await (const chunk of child.stdout) {
      const b = Buffer.from(chunk);
      bytes += b.length;
      digest.update(b);
      await output.writeFile(b);
      if (bytes <= maxBytes) chunks.push(b);
      else chunks.length = 0;
    }
    const code = await exited;
    await output.sync();
    if (failure || code !== 0)
      throw new BridgeError(
        'GIT_CAPTURE_FAILED',
        `${failure?.message ?? stderr}; partial/full output at ${path}`,
      );
    let text: string | undefined, issue: string | undefined;
    if (bytes > maxBytes)
      issue = `GIT_EVIDENCE_TOO_LARGE: ${args.join(' ')} (${bytes} bytes); full output retained`;
    else {
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(chunks),
        );
      } catch {
        issue = 'NON_UTF8_GIT_EVIDENCE: full raw output retained';
      }
    }
    return { text, issue, snapshot_path: path, bytes, sha256: digest.digest('hex') };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await output.close();
  }
}
