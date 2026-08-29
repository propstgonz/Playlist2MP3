export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(scope: string): Logger;
}

function currentThreshold(): number {
  const configured = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
  if (configured in LEVEL_ORDER) {
    return LEVEL_ORDER[configured as LogLevel];
  }
  return LEVEL_ORDER.info;
}

function write(level: LogLevel, prefix: string, message: string): void {
  if (LEVEL_ORDER[level] < currentThreshold()) {
    return;
  }
  const line = `${prefix}${message}`;
  if (level === "error" || level === "warn") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
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
