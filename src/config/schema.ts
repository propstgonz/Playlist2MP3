import type {
  AppConfig,
  LogLevel,
  MatchingSettings,
  PlaylistSettings,
  RandomSettings,
  SyncMode,
} from "../types/index.js";
import { parseDuration } from "../utils/duration.js";
import { isValidTimezone } from "../utils/logger.js";
import { sanitizeSegment, FILE_NAME_PLACEHOLDERS } from "../filesystem/paths.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type JsonObject = Record<string, unknown>;

const MODES: readonly SyncMode[] = ["mirror", "incremental"];
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 20 * 86_400_000;
const QUALITY_PATTERN = /^(best|(?:64|96|128|160|192|256|320)k)$/i;
const PLAYLIST_URL_PATTERN = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([a-zA-Z0-9]+)(?:[?#].*)?$/;
const PLAYLIST_URI_PATTERN = /^spotify:playlist:([a-zA-Z0-9]+)$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(parent: JsonObject, key: string, path: string): JsonObject {
  const value = parent[key];
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    throw new ConfigError(`"${path}" must be an object`);
  }
  return value;
}

function rejectUnknownKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const where = path === "" ? key : `${path}.${key}`;
      throw new ConfigError(`Unknown option "${where}". Allowed here: ${allowed.join(", ")}`);
    }
  }
}

function stringAt(parent: JsonObject, key: string, path: string, fallback: string): string {
  const value = parent[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`"${path}" must be a non-empty text value`);
  }
  return value.trim();
}

function booleanAt(parent: JsonObject, key: string, path: string, fallback: boolean): boolean {
  const value = parent[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ConfigError(`"${path}" must be true or false`);
  }
  return value;
}

function integerAt(
  parent: JsonObject,
  key: string,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = parent[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`"${path}" must be a whole number between ${min} and ${max}`);
  }
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], path: string): T {
  const found = allowed.find((option) => option === value.toLowerCase());
  if (found === undefined) {
    throw new ConfigError(`"${path}" must be one of: ${allowed.map((o) => `"${o}"`).join(", ")}`);
  }
  return found;
}

export function extractPlaylistId(url: string): string | undefined {
  const trimmed = url.trim();
  return PLAYLIST_URL_PATTERN.exec(trimmed)?.[1] ?? PLAYLIST_URI_PATTERN.exec(trimmed)?.[1];
}

function parseFileNameTemplate(template: string, path: string): string {
  if (!template.includes("{title}")) {
    throw new ConfigError(`"${path}" must contain {title}`);
  }
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    if (!FILE_NAME_PLACEHOLDERS.includes(match[1] ?? "")) {
      throw new ConfigError(
        `"${path}" uses unknown placeholder {${match[1]}}. Available: ${FILE_NAME_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`,
      );
    }
  }
  return template;
}

function parseMatching(root: JsonObject): MatchingSettings {
  const matching = objectAt(root, "matching", "matching");
  rejectUnknownKeys(matching, ["strict", "durationToleranceSec", "youtubeFallback"], "matching");
  return {
    strict: booleanAt(matching, "strict", "matching.strict", true),
    durationToleranceSec: integerAt(
      matching,
      "durationToleranceSec",
      "matching.durationToleranceSec",
      7,
      1,
      60,
    ),
    youtubeFallback: booleanAt(matching, "youtubeFallback", "matching.youtubeFallback", true),
  };
}

function parseRandom(root: JsonObject, defaultMode: SyncMode): RandomSettings {
  const random = objectAt(root, "random", "random");
  rejectUnknownKeys(random, ["enabled", "name", "maxTracks", "mode"], "random");
  return {
    enabled: booleanAt(random, "enabled", "random.enabled", false),
    name: stringAt(random, "name", "random.name", "Aleatoria"),
    maxTracks: integerAt(random, "maxTracks", "random.maxTracks", 50, 1, 1000),
    mode: oneOf(stringAt(random, "mode", "random.mode", defaultMode), MODES, "random.mode"),
  };
}

function parsePlaylists(root: JsonObject, defaultMode: SyncMode): PlaylistSettings[] {
  const raw = root["playlists"];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError(`"playlists" must be a list: [ { "name": "...", "url": "..." } ]`);
  }
  return raw.map((entry: unknown, index) => {
    const path = `playlists[${index}]`;
    if (!isObject(entry)) {
      throw new ConfigError(`"${path}" must be an object like { "name": "...", "url": "..." }`);
    }
    rejectUnknownKeys(entry, ["name", "url", "mode"], path);
    if (entry["name"] === undefined || entry["url"] === undefined) {
      throw new ConfigError(`"${path}" needs both "name" and "url"`);
    }
    const name = stringAt(entry, "name", `${path}.name`, "");
    const url = stringAt(entry, "url", `${path}.url`, "");
    const playlistId = extractPlaylistId(url);
    if (playlistId === undefined) {
      throw new ConfigError(
        `"${path}.url" is not a Spotify playlist link: "${url}". Expected https://open.spotify.com/playlist/...`,
      );
    }
    const mode = oneOf(stringAt(entry, "mode", `${path}.mode`, defaultMode), MODES, `${path}.mode`);
    return { name, url, playlistId, mode };
  });
}

function assertUniqueFolders(names: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const folder = sanitizeSegment(name).toLowerCase();
    const previous = seen.get(folder);
    if (previous !== undefined) {
      throw new ConfigError(
        `Playlists "${previous}" and "${name}" would share the same folder. Give each one a different name.`,
      );
    }
    seen.set(folder, name);
  }
}

export function parseConfig(raw: unknown): AppConfig {
  if (!isObject(raw)) {
    throw new ConfigError('The configuration must be a JSON object: { "playlists": [ ... ] }');
  }
  rejectUnknownKeys(
    raw,
    [
      "syncInterval",
      "concurrency",
      "logLevel",
      "timezone",
      "dryRun",
      "defaults",
      "audio",
      "matching",
      "random",
      "playlists",
    ],
    "",
  );

  const intervalText = stringAt(raw, "syncInterval", "syncInterval", "24h");
  const syncIntervalMs = parseDuration(intervalText);
  if (syncIntervalMs === undefined || syncIntervalMs < MIN_INTERVAL_MS || syncIntervalMs > MAX_INTERVAL_MS) {
    throw new ConfigError(
      `"syncInterval" must be a duration between 1m and 20d, like "30m", "6h" or "1d" (got "${intervalText}")`,
    );
  }

  const timezoneValue = raw["timezone"];
  const timezone =
    timezoneValue === undefined ? undefined : stringAt(raw, "timezone", "timezone", "");
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    throw new ConfigError(`"timezone" is not a valid time zone: "${timezone}" (example: "Europe/Madrid")`);
  }

  const defaults = objectAt(raw, "defaults", "defaults");
  rejectUnknownKeys(defaults, ["mode", "fileName"], "defaults");
  const defaultMode = oneOf(stringAt(defaults, "mode", "defaults.mode", "mirror"), MODES, "defaults.mode");

  const audio = objectAt(raw, "audio", "audio");
  rejectUnknownKeys(audio, ["quality"], "audio");
  const audioQuality = stringAt(audio, "quality", "audio.quality", "best").toLowerCase();
  if (!QUALITY_PATTERN.test(audioQuality)) {
    throw new ConfigError(`"audio.quality" must be "best" or a bitrate like "320k", "256k" or "192k"`);
  }

  const playlists = parsePlaylists(raw, defaultMode);
  const random = parseRandom(raw, defaultMode);
  if (playlists.length === 0 && !random.enabled) {
    throw new ConfigError(
      'No playlists configured. Add at least one { "name": "...", "url": "..." } entry to "playlists".',
    );
  }
  assertUniqueFolders([...playlists.map((p) => p.name), ...(random.enabled ? [random.name] : [])]);

  return {
    syncIntervalMs,
    concurrency: integerAt(raw, "concurrency", "concurrency", 2, 1, 16),
    logLevel: oneOf(stringAt(raw, "logLevel", "logLevel", "info"), LOG_LEVELS, "logLevel"),
    timezone,
    dryRun: booleanAt(raw, "dryRun", "dryRun", false),
    fileName: parseFileNameTemplate(
      stringAt(defaults, "fileName", "defaults.fileName", "{artists} - {title}"),
      "defaults.fileName",
    ),
    audioQuality,
    matching: parseMatching(raw),
    random,
    playlists,
  };
}
