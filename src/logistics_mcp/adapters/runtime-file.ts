import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

export async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("The runtime file size limit is invalid.");
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) {
      throw new Error("The runtime file is unavailable.");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error("The runtime file is unavailable.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
