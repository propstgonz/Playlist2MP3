export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be an integer >= 1, got ${limit}`);
    }
    this.available = limit;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error("Aborted before acquiring semaphore slot");
    }
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(grant);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
        reject(new Error("Aborted while waiting for semaphore slot"));
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(() => this.release());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}

export async function runWithLimit<T>(
  limit: number,
  items: readonly T[],
  task: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const semaphore = new Semaphore(limit);
  await Promise.all(
    items.map(async (item, index) => {
      const release = await semaphore.acquire(signal);
      try {
        await task(item, index);
      } finally {
        release();
      }
    }),
  );
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted before sleep started"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Sleep aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
