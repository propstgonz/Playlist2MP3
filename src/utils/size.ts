const UNIT_MULTIPLIERS: Record<string, number> = {
  "": 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};
const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*([KMGT]?)$/i;
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function parseSizeString(raw: string): number {
  const match = SIZE_PATTERN.exec(raw.trim());
  if (!match || match[1] === undefined) {
    throw new Error(`Invalid size string "${raw}"`);
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toUpperCase();
  return Math.round(value * (UNIT_MULTIPLIERS[unit] as number));
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}
