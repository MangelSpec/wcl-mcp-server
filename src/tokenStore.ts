/**
 * On-disk persistence for the *user* OAuth token (authorization-code flow).
 *
 * Why a file and not .env: the token is minted interactively by `npm run auth`
 * and later refreshed in-process, so it has to be writable at runtime. It is
 * also a live credential to the user's WCL account — strictly more sensitive
 * than the client secret — so it lives outside the repo, in the user's home
 * directory, with 0600 permissions. Nothing here is ever logged.
 *
 * Absence of this file is the signal that no user has authorized: auth.ts falls
 * back to client-credentials (public logs only) when it isn't present.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredToken {
  accessToken: string;
  /** WCL may or may not issue one; absent means re-auth is the only recovery. */
  refreshToken?: string;
  /** epoch ms at which the access token expires */
  expiresAt: number;
  /** epoch ms the token was granted — diagnostics only */
  obtainedAt: number;
}

/**
 * Override with WCL_TOKEN_FILE. Useful when the MCP client launches the server
 * under a different account than the one that ran `npm run auth`, or for tests.
 */
export function getTokenFilePath(): string {
  const override = process.env.WCL_TOKEN_FILE;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".wcl-mcp", "token.json");
}

export function readStoredToken(): StoredToken | null {
  const path = getTokenFilePath();
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read the WCL user token at ${path}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Fix the file permissions or delete it and re-run `npm run auth`.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `The WCL user token at ${path} is not valid JSON. Delete it and re-run \`npm run auth\`.`,
    );
  }

  if (!isStoredToken(parsed)) {
    throw new Error(
      `The WCL user token at ${path} is missing required fields. Delete it and re-run \`npm run auth\`.`,
    );
  }
  return parsed;
}

export function writeStoredToken(token: StoredToken): void {
  const path = getTokenFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  // Write-then-rename so a crash mid-write can't leave a half-written token
  // behind. The temp file is created 0600 from the start — it must never exist
  // in a world-readable state, even briefly.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/** Remove the stored token, reverting the server to client-credentials mode. Idempotent. */
export function deleteStoredToken(): boolean {
  const path = getTokenFilePath();
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    v.accessToken.length > 0 &&
    typeof v.expiresAt === "number" &&
    typeof v.obtainedAt === "number" &&
    (v.refreshToken === undefined || typeof v.refreshToken === "string")
  );
}
