/**
 * AI service adapter (WST-FR-14, acceptance scenario 8).
 *
 * The backend NEVER depends on the AI service being up:
 *  - AI_SERVICE_URL unset, service down, slow, wrong token or unexpected reply
 *    -> the deterministic rule baseline is returned and marked `fallbackUsed: true` with a reason.
 *  - Service healthy -> every baseline row gets an extra `ai` block with the AI service answer.
 *    The rule result is kept as-is: predictions are advisory, a human decides.
 *
 * Contract used (blueprint contract of the AI service, camelCase, header X-Internal-Token):
 *   POST /ai/predict-reorder  and  POST /ai/student-risk   (one part / one student per call)
 */
export type ModelOutcome<T> = { data: T; fallbackUsed: boolean; source: string; reason?: string };

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 1500);
const CONCURRENCY = 8;

type Mapping = { aiPath: string; toBody: (row: any) => Record<string, unknown> };

const contribution = (row: any, feature: string): number | undefined =>
  row?.explanation?.contributions?.find((c: any) => c.feature === feature)?.value;

const MAPPINGS: Record<string, Mapping> = {
  '/reorder': {
    aiPath: '/ai/predict-reorder',
    toBody: (row) => ({
      partId: String(row.partId),
      onHandQty: row.onHand,
      minLevel: row.minLevel,
      maxLevel: row.maxLevel,
      weeklyConsumption: row.averageWeeklyConsumption,
      reservedQty: row.reserved,
      openPoQty: row.onOrder,
    }),
  },
  '/training-risk': {
    aiPath: '/ai/student-risk',
    toBody: (row) => ({
      studentId: String(row.studentId),
      // NOTE: attendanceRate is sent as a 0..1 ratio. Ask the AI engineer to confirm (0..1 or 0..100).
      attendanceRate: contribution(row, 'attendanceRatio') ?? 1,
      missingAssessments: contribution(row, 'pendingSignatures') ?? 0,
      unmetCompetencies: Math.max((row.requiredTasks ?? 0) - (row.signedPassed ?? 0), 0),
    }),
  },
};

async function callAi(baseUrl: string, aiPath: string, body: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.AI_SERVICE_TOKEN) headers['X-Internal-Token'] = process.env.AI_SERVICE_TOKEN;
    const res = await fetch(`${baseUrl}${aiPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 401) throw new Error('AI service auth failed (check AI_SERVICE_TOKEN)');
    if (!res.ok) throw new Error(`AI service responded ${res.status}`);
    const json: any = await res.json();
    if (!json || typeof json !== 'object') throw new Error('AI service returned an unexpected body');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function withModelFallback<T>(
  path: string,
  _payload: unknown,
  baseline: () => Promise<T>
): Promise<ModelOutcome<T>> {
  // The rule baseline is always computed: it is the fallback AND the source of the AI inputs.
  const rows = await baseline();
  const rule = (reason: string): ModelOutcome<T> => ({ data: rows, fallbackUsed: true, source: 'RULE_BASELINE', reason });

  const baseUrl = process.env.AI_SERVICE_URL?.replace(/\/$/, '');
  if (!baseUrl) return rule('AI_SERVICE_URL not configured');

  const mapping = MAPPINGS[path];
  if (!mapping) return rule(`no AI mapping for ${path}`);
  if (!Array.isArray(rows)) return rule('unexpected baseline shape');
  if (rows.length === 0) return { data: rows, fallbackUsed: false, source: 'RULE_BASELINE', reason: 'no items to score' };

  try {
    const merged: any[] = new Array(rows.length);
    let failed: Error | null = null;
    let next = 0;
    const worker = async () => {
      while (!failed) {
        const i = next++;
        if (i >= rows.length) return;
        try {
          const ai = await callAi(baseUrl, mapping.aiPath, mapping.toBody(rows[i]));
          merged[i] = { ...(rows[i] as any), ai };
        } catch (e: any) {
          failed = e instanceof Error ? e : new Error(String(e));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    if (failed) return rule((failed as Error).message || 'AI service unavailable');
    return { data: merged as unknown as T, fallbackUsed: false, source: 'AI_SERVICE' };
  } catch (e: any) {
    return rule(e?.message ?? 'AI service unavailable');
  }
}
