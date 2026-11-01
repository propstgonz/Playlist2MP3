const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(raw: string): number | undefined {
  const match = DURATION_PATTERN.exec(raw.trim());
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const value = Number(match[1]) * (UNIT_MS[match[2].toLowerCase()] ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function formatClock(totalSec: number): string {
  const rounded = Math.round(totalSec);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
