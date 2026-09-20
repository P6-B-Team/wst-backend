/**
 * Optional AI service adapter (WST-FR-14, acceptance scenario 8).
 *
 * The backend never depends on the model being up. If AI_SERVICE_URL is unset, unreachable, slow or
 * returns anything unexpected, the deterministic rule baseline is used and the response is marked
 * with `fallbackUsed: true` plus the reason, so the dashboard can show the fallback state instead of
 * silently presenting a different number.
 */
export type ModelOutcome<T> = { data: T; fallbackUsed: boolean; source: string; reason?: string };

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 1500);

export async function withModelFallback<T>(
  path: string,
  payload: unknown,
  baseline: () => Promise<T>
): Promise<ModelOutcome<T>> {
  const url = process.env.AI_SERVICE_URL;
  if (!url) return { data: await baseline(), fallbackUsed: true, source: 'RULE_BASELINE', reason: 'AI_SERVICE_URL not configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`model responded ${res.status}`);
    const json: any = await res.json();
    if (!json?.data) throw new Error('model response missing data');
    return { data: json.data as T, fallbackUsed: false, source: json.model?.version ? `MODEL:${json.model.version}` : 'MODEL' };
  } catch (e: any) {
    return { data: await baseline(), fallbackUsed: true, source: 'RULE_BASELINE', reason: e?.message ?? 'model unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
