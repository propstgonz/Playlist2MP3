const NOISE_PHRASES = [
  "official music video",
  "official video",
  "official audio",
  "official lyric video",
  "official visualizer",
  "lyric video",
  "lyrics video",
  "music video",
  "video oficial",
  "audio oficial",
  "videoclip oficial",
  "visualizer",
  "lyrics",
  "letra",
  "hd",
  "hq",
  "4k",
  "audio",
  "video",
  "explicit",
  "clean",
];

const REMASTER_PATTERN = /\b(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|\d{4}))*\b/g;
const FEATURING_PATTERN = /\b(?:feat|ft|featuring)\b\s+.*$/g;

export function normalizeText(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[，、]/g, ",")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripNoise(normalized: string): string {
  let result = ` ${normalized} `;
  for (const phrase of NOISE_PHRASES) {
    result = result.split(` ${phrase} `).join(" ");
  }
  return result.replace(/\s+/g, " ").trim();
}

export function coreTitle(raw: string, cutDashSuffix: boolean): string {
  let title = raw.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  if (cutDashSuffix) {
    title = title.split(/\s[-–—]\s/)[0] ?? title;
  }
  const normalized = normalizeText(title).replace(REMASTER_PATTERN, " ").replace(FEATURING_PATTERN, " ");
  return stripNoise(normalized.replace(/\s+/g, " ").trim());
}

export function normalizeArtist(raw: string): string {
  return normalizeText(raw).replace(/^the\s+/, "");
}

export function tokens(text: string): string[] {
  return text.split(" ").filter((token) => token !== "");
}

export function containsPhrase(haystack: string, phrase: string): boolean {
  return phrase !== "" && ` ${haystack} `.includes(` ${phrase} `);
}

export function titleSimilarity(expected: string, candidate: string): number {
  const a = tokens(expected);
  const b = tokens(candidate);
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const pool = [...b];
  let common = 0;
  for (const token of a) {
    const index = pool.indexOf(token);
    if (index !== -1) {
      common += 1;
      pool.splice(index, 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}
