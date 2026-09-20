/**
 * Structured logging (common-pack observability NFR: "Request IDs, errors, security events").
 * One JSON object per line so any log shipper can parse it without a regex.
 *
 * Passwords, tokens and authorization headers are never logged — the common pack requires that
 * critical events are recorded "without storing passwords, tokens, or unnecessary sensitive
 * payloads", so redaction happens here rather than being left to each call site.
 */
const SENSITIVE = /^(password|passwordhash|password_hash|token|accesstoken|refreshtoken|refresh_token|authorization|secret|apikey|api_key|cookie)$/i;

export const LOG_LEVEL = (process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'error' : 'info')).toLowerCase();
const ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function redact(value: any, depth = 0): any {
  if (value === null || value === undefined || depth > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  return out;
}

function emit(level: string, event: string, fields: Record<string, any> = {}) {
  if ((ORDER[level] ?? 20) < (ORDER[LOG_LEVEL] ?? 20)) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields) });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logDebug = (event: string, fields?: Record<string, any>) => emit('debug', event, fields);
export const logInfo = (event: string, fields?: Record<string, any>) => emit('info', event, fields);
export const logWarn = (event: string, fields?: Record<string, any>) => emit('warn', event, fields);
export const logError = (event: string, fields?: Record<string, any>) => emit('error', event, fields);

/** Security-relevant events get their own channel so they can be alerted on separately. */
export const logSecurity = (event: string, fields?: Record<string, any>) => emit('warn', event, { ...fields, security: true });
