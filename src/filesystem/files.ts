import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function listMp3Files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp3"))
    .map((entry) => entry.name);
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!hasCode(error, "EXDEV")) {
      throw error;
    }
    await copyFile(from, to);
    await unlink(from);
  }
}

export async function commitFile(tempPath: string, finalPath: string): Promise<boolean> {
  if (await fileExists(finalPath)) {
    await removeIfExists(tempPath);
    return false;
  }
  await mkdir(dirname(finalPath), { recursive: true });
  await moveFile(tempPath, finalPath);
  return true;
}

export async function renameNoOverwrite(from: string, to: string): Promise<boolean> {
  const caseOnly = from.toLowerCase() === to.toLowerCase();
  if (!caseOnly && (await fileExists(to))) {
    return false;
  }
  if (caseOnly) {
    const bridge = `${from}.renaming`;
    await rename(from, bridge);
    await rename(bridge, to);
    return true;
  }
  await rename(from, to);
  return true;
}

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}

export async function writeIfChanged(path: string, content: string): Promise<boolean> {
  if ((await readTextIfExists(path)) === content) {
    return false;
  }
  await writeFileAtomic(path, content);
  return true;
}
