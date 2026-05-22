import fs from "node:fs/promises";
import path from "node:path";

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;

  await fs.writeFile(tempFilePath, text, "utf8");
  await fs.rename(tempFilePath, filePath);
}
