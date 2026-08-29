import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry, NonRetryableError } from "../src/utils/retry.js";

test("retries a failing operation up to maxAttempts", async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("transient failure");
      }
      return "ok";
    },
    { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("gives up after maxAttempts and throws the last error", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw new Error(`failure ${attempts}`);
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    ),
    /failure 3/,
  );
  assert.equal(attempts, 3);
});

test("does not retry a NonRetryableError", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw new NonRetryableError("permanent failure");
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
    ),
    NonRetryableError,
  );
  assert.equal(attempts, 1);
});
