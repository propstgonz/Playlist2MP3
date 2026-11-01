import type { LogLevel } from "../types/index.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(scope: string): Logger;
}

export type LogSink = (line: string, level: LogLevel) => void;

const state: { level: LogLevel; format: Intl.DateTimeFormat; sink: LogSink } = {
  level: "info",
  format: buildFormat(undefined),
  sink: (line, level) => {
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
  },
};

function buildFormat(timezone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function configureLogger(options: {
  readonly level?: LogLevel;
  readonly timezone?: string | undefined;
  readonly sink?: LogSink;
}): void {
  if (options.level !== undefined) {
    state.level = options.level;
  }
  if ("timezone" in options) {
    state.format = buildFormat(options.timezone);
  }
  if (options.sink !== undefined) {
    state.sink = options.sink;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    buildFormat(timezone);
    return true;
  } catch (error) {
    return error === undefined;
  }
}

function write(level: LogLevel, prefix: string, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) {
    return;
  }
  const timestamp = state.format.format(new Date());
  state.sink(`${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix}${message}`, level);
}

function createLogger(prefix: string): Logger {
  return {
    debug: (message) => write("debug", prefix, message),
    info: (message) => write("info", prefix, message),
    warn: (message) => write("warn", prefix, message),
    error: (message) => write("error", prefix, message),
    child: (scope) => createLogger(`${prefix}[${scope}] `),
  };
}

export const rootLogger: Logger = createLogger("");

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
