import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithLimit, runWithSemaphore, Semaphore } from "../src/utils/concurrency.js";

test("never exceeds the configured concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);

  await runWithLimit(3, items, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });

  assert.equal(maxActive <= 3, true);
});

test("runs every item exactly once", async () => {
  const seen: number[] = [];
  await runWithLimit(2, [1, 2, 3, 4, 5], async (item) => {
    seen.push(item);
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("stops granting new work once the signal aborts", async () => {
  const controller = new AbortController();
  let started = 0;

  const run = runWithLimit(
    1,
    [1, 2, 3],
    async () => {
      started += 1;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    controller.signal,
  );

  await assert.rejects(run);
  assert.equal(started, 1);
});

test("runWithSemaphore shares one limit across multiple independent calls", async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let maxActive = 0;

  const track = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  };

  await Promise.all([
    runWithSemaphore(semaphore, [1, 2, 3], track),
    runWithSemaphore(semaphore, [1, 2, 3], track),
  ]);

  assert.equal(maxActive <= 2, true);
});
