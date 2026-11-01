import { readFile } from "node:fs/promises";
import type { AppConfig } from "../types/index.js";
import { ConfigError, parseConfig } from "./schema.js";
import { errorMessage } from "../utils/logger.js";

export interface RuntimePaths {
  readonly configFile: string;
  readonly musicDir: string;
  readonly tempDir: string;
}

export function runtimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  return {
    configFile: env["CONFIG_FILE"] ?? "/config/config.json",
    musicDir: env["MUSIC_DIR"] ?? "/music",
    tempDir: env["TEMP_DIR"] ?? "/tmp/playlist2mp3",
  };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Cannot read "${path}" (${errorMessage(error)}). Copy config/config.example.json to config/config.json and edit it.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new ConfigError(`"${path}" is not valid JSON: ${errorMessage(error)}`);
  }

  try {
    return parseConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`${path}: ${error.message}`);
    }
    throw error;
  }
}

export { ConfigError };
