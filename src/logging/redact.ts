export function redact(value: unknown): unknown {
  if (typeof value === 'string')
    return value
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}/g, '[REDACTED]')
      .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|cookie|authorization|access.?token|refresh.?token|api.?key|secret/i.test(k)
          ? '[REDACTED]'
          : redact(v),
      ]),
    );
  return value;
}
