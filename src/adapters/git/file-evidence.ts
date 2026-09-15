import { constants } from 'node:fs';
import { lstat, open, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FileEvidence } from '../../core/types.js';
export const EVIDENCE_LIMITS = {
  perFileBytes: 32 * 1024,
  totalTextBytes: 64 * 1024,
  gitOutputBytes: 128 * 1024,
  packetBytes: 100_000,
};
const nonText = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** Stream a complete private snapshot; only bounded, strict UTF-8 text enters the review packet. */
export async function snapshotUntracked(
  root: string,
  paths: string[],
  archive: string,
  limits = EVIDENCE_LIMITS,
) {
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const files: FileEvidence[] = [],
    issues: string[] = [];
  let total = 0;
  const canonicalRoot = await realpath(root);
  for (const path of paths) {
    const entry: FileEvidence = { path, kind: 'unavailable' };
    files.push(entry);
    let input: Awaited<ReturnType<typeof open>> | undefined,
      output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const full = resolve(root, path),
        rel = relative(root, full);
      if (isAbsolute(path) || rel.startsWith('..') || isAbsolute(rel) || !rel)
        throw Error('Path escapes repository');
      let parent = root;
      for (const segment of rel.split(/[\\/]/)) {
        parent = join(parent, segment);
        const info = await lstat(parent);
        if (info.isSymbolicLink()) throw Error('Symbolic links are not followed');
      }
      const actual = await realpath(full),
        actualRel = relative(canonicalRoot, actual);
      if (actualRel.startsWith('..') || isAbsolute(actualRel))
        throw Error('Resolved path escapes repository');
      const before = await lstat(full);
      if (!before.isFile()) throw Error('Only regular files are captured');
      input = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await input.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile())
        throw Error('File identity changed before capture');
      const snapshot = join(archive, `${randomUUID()}.raw`);
      output = await open(snapshot, 'wx', 0o600);
      entry.snapshot_path = snapshot;
      const digest = createHash('sha256'),
        decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const chunk = Buffer.alloc(64 * 1024);
      let bytes = 0,
        text = '',
        binary = false;
      while (true) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        const data = chunk.subarray(0, bytesRead);
        await output.writeFile(data);
        digest.update(data);
        bytes += bytesRead;
        if (!binary) {
          try {
            const decoded = decoder.decode(data, { stream: true });
            if (nonText.test(decoded)) binary = true;
            else if (bytes <= limits.perFileBytes) text += decoded;
          } catch {
            binary = true;
          }
        }
      }
      if (!binary) {
        try {
          const tail = decoder.decode();
          if (nonText.test(tail)) binary = true;
          else if (bytes <= limits.perFileBytes) text += tail;
        } catch {
          binary = true;
        }
      }
      await output.sync();
      entry.bytes = bytes;
      entry.sha256 = digest.digest('hex');
      entry.kind = binary ? 'binary' : 'text';
      const after = await input.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes !== before.size) {
        entry.omitted_reason = 'File changed during capture';
        issues.push(`UNSTABLE_FILE: ${path}`);
        continue;
      }
      if (binary) {
        entry.omitted_reason =
          'Binary or invalid UTF-8: metadata only; complete bytes retained in private snapshot';
        continue;
      }
      if (bytes > limits.perFileBytes) {
        entry.omitted_reason = `Per-file text limit exceeded (${limits.perFileBytes} bytes); full snapshot retained`;
        issues.push(`FILE_EVIDENCE_TOO_LARGE: ${path}`);
        continue;
      }
      if (total + bytes > limits.totalTextBytes) {
        entry.omitted_reason = `Total text limit exceeded (${limits.totalTextBytes} bytes); full snapshot retained`;
        issues.push(`TOTAL_EVIDENCE_TOO_LARGE: ${path}`);
        continue;
      }
      entry.content = text;
      total += bytes;
    } catch (e: any) {
      entry.kind = entry.snapshot_path ? 'unavailable' : 'unsafe';
      entry.omitted_reason = e.message;
      issues.push(`FILE_CAPTURE_FAILED: ${path}: ${e.message}`);
    } finally {
      await input?.close();
      await output?.close();
    }
  }
  return { files, issues, text_bytes: total };
}
