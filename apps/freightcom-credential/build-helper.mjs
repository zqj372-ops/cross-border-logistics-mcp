import { execFile } from "node:child_process";
import { access, chmod, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const source = fileURLToPath(new URL("./keychain-helper.swift", import.meta.url));
const helperDirectory = resolve(
  homedir(),
  "Library",
  "Application Support",
  "Codex",
  "Freightcom",
);
export const keychainHelperPath = resolve(
  helperDirectory,
  "freightcom-keychain-helper-v1",
);

export async function ensureKeychainHelper() {
  try {
    await access(keychainHelperPath, constants.X_OK);
    return keychainHelperPath;
  } catch {
    await mkdir(helperDirectory, { recursive: true, mode: 0o700 });
    await execFileAsync(
      "/usr/bin/xcrun",
      ["swiftc", source, "-o", keychainHelperPath],
      { timeout: 30_000, maxBuffer: 64 * 1024 },
    );
    await chmod(keychainHelperPath, 0o700);
    return keychainHelperPath;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureKeychainHelper();
}
