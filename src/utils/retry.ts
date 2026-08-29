export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_OPTIONS: Omit<RetryOptions, "signal"> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = capped * (0.5 + Math.random() * 0.5);
  return Math.round(jitter);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const resolved: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= resolved.maxAttempts; attempt += 1) {
    if (resolved.signal?.aborted) {
      throw new Error("Aborted before retry attempt started");
    }
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableError) {
        throw error;
      }
      if (attempt === resolved.maxAttempts) {
        break;
      }
      const delay = computeDelay(attempt, resolved.baseDelayMs, resolved.maxDelayMs);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("Aborted while waiting to retry"));
        };
        resolved.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  throw lastError;
}
