import { test } from "node:test";
import assert from "node:assert/strict";
import { configureLogger, isValidTimezone, rootLogger } from "../src/utils/logger.js";
import { logLines } from "./helpers.js";

test("lines carry timestamp, level and playlist scope, and respect the level", () => {
  configureLogger({ level: "info", timezone: "UTC" });
  try {
    logLines.length = 0;
    const logger = rootLogger.child("Rock");
    logger.debug("hidden");
    logger.info("Downloaded: A - B");
    logger.error("Failed");
    assert.equal(logLines.length, 2);
    assert.match(logLines[0] ?? "", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO  \[Rock\] Downloaded: A - B$/);
    assert.match(logLines[1] ?? "", /ERROR \[Rock\] Failed$/);
  } finally {
    configureLogger({ level: "debug", timezone: undefined });
  }
});

test("validates time zones", () => {
  assert.equal(isValidTimezone("Europe/Madrid"), true);
  assert.equal(isValidTimezone("Not/AZone"), false);
});
