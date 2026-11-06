export type UsageMetrics = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
export type UsageEvent = {
  usage?: UsageMetrics;
  limits?: Record<string, string>;
  httpStatus?: number;
  failureCode?: string;
};
export type UsageLog = {
  id: string;
  createdAt: string;
  model: string;
  status: 'running' | 'completed' | 'failed';
  usage: UsageMetrics | null;
  limits: Record<string, string>;
  httpStatus?: number;
  failureCode?: string;
  courseId?: string;
  questionId?: string;
  purpose?: 'grading' | 'tutoring' | 'authoring';
};
export type QuotaSnapshot = {
  remaining: number;
  observedAt: string;
  source: 'quota-report';
  note: string;
};
export function tokyoDate(value: string | Date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map((t) => parts.find((p) => p.type === t)!.value).join('-');
}
export function limitHeaders(headers: Headers) {
  const allowed = [
    'x-ratelimit-limit-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'retry-after',
  ];
  const result: Record<string, string> = {};
  for (const name of allowed) {
    const value = headers.get(name);
    if (value && value.length <= 100) result[name] = value;
  }
  return result;
}
export function usageSummary(logs: UsageLog[], quota: QuotaSnapshot | null) {
  const today = tokyoDate();
  const daily = logs.filter((x) => tokyoDate(x.createdAt) === today);
  const models = [...new Set(daily.map((x) => x.model))].map((model) => {
    const rows = daily.filter((x) => x.model === model);
    return {
      model,
      requests: rows.length,
      failed: rows.filter((x) => x.status === 'failed').length,
      reported: rows.filter((x) => x.usage?.totalTokens !== undefined).length,
      inputTokens: rows.reduce((s, x) => s + (x.usage?.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((s, x) => s + (x.usage?.outputTokens ?? 0), 0),
      totalTokens: rows.reduce((s, x) => s + (x.usage?.totalTokens ?? 0), 0),
    };
  });
  return {
    today,
    requests: daily.length,
    totalTokens: models.reduce((s, x) => s + x.totalTokens, 0),
    unreported: daily.filter((x) => x.usage?.totalTokens === undefined).length,
    models,
    quota: quota ? { ...quota, isToday: tokyoDate(quota.observedAt) === today } : null,
    lastLimits: logs.find((x) => Object.keys(x.limits).length > 0) ?? null,
  };
}
