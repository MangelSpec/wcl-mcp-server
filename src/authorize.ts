#!/usr/bin/env node
/**
 * One-time interactive OAuth setup: `npm run auth`.
 *
 * Runs the authorization-code flow against Warcraft Logs and writes the
 * resulting user token to disk (see tokenStore.ts). Once that file exists, the
 * MCP server automatically switches to `/api/v2/user` and can read private
 * reports owned by the authorizing account.
 *
 * This is deliberately a *separate* entry point rather than something the
 * server does lazily. The server speaks MCP over stdio: it cannot open a
 * browser and block a tool call for a minute while a human clicks Approve, and
 * anything it printed to stdout would corrupt the JSON-RPC stream.
 *
 * Flags:
 *   --status       print where the token lives and whether one is stored
 *   --logout       delete the stored token (server reverts to public-only mode)
 *   --no-browser   print the URL and wait, don't try to launch a browser
 *                  (headless boxes, SSH sessions, or when you want to paste the
 *                  URL into a specific browser profile)
 */

// Same .env anchoring rationale as index.ts: resolve relative to this script's
// own location, not the caller's cwd.
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: pathResolve(__dirname, "../.env") });

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  OAUTH_AUTHORIZE_ENDPOINT,
  getClientCredentials,
  getRedirectUri,
  postTokenRequest,
} from "./auth.js";
import {
  deleteStoredToken,
  getTokenFilePath,
  readStoredToken,
  writeStoredToken,
  type StoredToken,
} from "./tokenStore.js";

const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const USER_ENDPOINT = "https://www.warcraftlogs.com/api/v2/user";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--status")) return printStatus();
  if (args.includes("--logout")) {
    const removed = deleteStoredToken();
    console.log(
      removed
        ? `Removed ${getTokenFilePath()}. The server will use client credentials (public logs only).`
        : "No stored user token — nothing to remove.",
    );
    return;
  }

  // Fail fast on missing credentials before we open a browser window.
  const { clientId } = getClientCredentials();
  const redirectUri = getRedirectUri();
  const callback = parseRedirectUri(redirectUri);

  const state = randomBytes(24).toString("hex");
  const authorizeUrl = new URL(OAUTH_AUTHORIZE_ENDPOINT);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);

  const noBrowser = args.includes("--no-browser");
  console.log("Warcraft Logs — authorizing this MCP server against your account.\n");
  console.log(`Listening for the callback on ${redirectUri}`);
  console.log(
    noBrowser
      ? "Open this URL to authorize:\n"
      : "Opening your browser. If it doesn't open, paste this URL yourself:\n",
  );
  console.log(`  ${authorizeUrl.toString()}\n`);

  const code = await waitForAuthorizationCode(callback, state, () => {
    if (!noBrowser) openBrowser(authorizeUrl.toString());
  });

  console.log("Got the authorization code. Exchanging it for a token…");
  const token = await postTokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  );

  const stored: StoredToken = {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    obtainedAt: Date.now(),
    ...(token.refresh_token === undefined
      ? {}
      : { refreshToken: token.refresh_token }),
  };
  writeStoredToken(stored);
  console.log(`Saved to ${getTokenFilePath()} (mode 0600).`);
  if (!stored.refreshToken) {
    console.log(
      "Note: WCL did not issue a refresh token. When this one expires you'll need to re-run `npm run auth`.",
    );
  }

  const who = await fetchCurrentUser(stored.accessToken);
  if (who) {
    console.log(`\nAuthorized as: ${who.name} (user id ${who.id}).`);
  } else {
    console.log("\nToken saved, but the identity check came back empty — try a tool call to confirm.");
  }
  console.log("The MCP server will now use /api/v2/user and can read your private reports.");
  // An already-running server holds its resolved token in memory until that
  // token expires — which is roughly a year — so it will not notice this file
  // appearing. Restarting is the only thing that picks it up promptly.
  console.log("Restart your MCP client to pick this up: a server that's already running keeps");
  console.log("its current token until expiry and won't see this one.");
}

function printStatus(): void {
  const path = getTokenFilePath();
  const stored = readStoredToken();
  if (!stored) {
    console.log(`No user token stored (looked in ${path}).`);
    console.log("Mode: client credentials — public and unlisted reports only.");
    console.log("Run `npm run auth` to authorize private-log access.");
    return;
  }
  const expired = stored.expiresAt <= Date.now();
  console.log(`User token stored at ${path}`);
  console.log(`  obtained:      ${new Date(stored.obtainedAt).toISOString()}`);
  console.log(`  expires:       ${new Date(stored.expiresAt).toISOString()}${expired ? "  (EXPIRED)" : ""}`);
  console.log(`  refreshable:   ${stored.refreshToken ? "yes" : "no"}`);
  console.log("Mode: user — private reports owned by the authorizing account are readable.");
}

interface CallbackTarget {
  hostname: string;
  port: number;
  pathname: string;
}

function parseRedirectUri(uri: string): CallbackTarget {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`WCL_REDIRECT_URI is not a valid URL: ${uri}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(
      `WCL_REDIRECT_URI must be an http:// loopback URL for this flow (got ${parsed.protocol}//). ` +
        "This script can only listen for a plain-HTTP callback on your own machine.",
    );
  }
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(
      `WCL_REDIRECT_URI must point at localhost (got ${parsed.hostname}). ` +
        "The callback server only binds the loopback interface.",
    );
  }
  if (!parsed.port) {
    throw new Error(`WCL_REDIRECT_URI must include an explicit port, e.g. http://localhost:4477/callback`);
  }
  return {
    hostname: "127.0.0.1",
    port: Number(parsed.port),
    pathname: parsed.pathname || "/",
  };
}

/**
 * Stand up a loopback HTTP server, run `onReady` once it's listening (so the
 * browser can't beat us to the port), and resolve with the `code` query param
 * from the first matching callback request.
 */
function waitForAuthorizationCode(
  target: CallbackTarget,
  expectedState: string,
  onReady: () => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // close() only stops new connections — it waits for existing ones to end,
      // and browsers hold keep-alive sockets open (plus speculative ones for
      // /favicon.ico) long after we've replied. Without this the script sits
      // there until Node's 5s keep-alive timeout reaps them.
      //
      // Idle, not All: the socket we just answered on is left to finish
      // gracefully under the `Connection: close` header, so there's no chance
      // of truncating the page mid-flight. Only the speculative sockets — the
      // ones actually holding close() open — get destroyed.
      server.closeIdleConnections?.();
      server.close(() => fn());
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${target.hostname}:${target.port}`);
      if (url.pathname !== target.pathname) {
        res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" });
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? "";
        const detail = `${error}${description ? ` — ${description}` : ""}`;
        respondHtml(res, 400, "Authorization denied", detail, () =>
          finish(() => reject(new Error(`Warcraft Logs denied authorization: ${detail}`))),
        );
        return;
      }

      // CSRF guard: only accept a callback carrying the state we just minted.
      const state = url.searchParams.get("state");
      if (state !== expectedState) {
        respondHtml(
          res,
          400,
          "State mismatch",
          "This callback didn't come from the request we started. Nothing was saved.",
          () => finish(() => reject(new Error("OAuth state mismatch — aborting without saving a token."))),
        );
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        respondHtml(
          res,
          400,
          "Missing code",
          "Warcraft Logs redirected back without an authorization code.",
          () => finish(() => reject(new Error("Callback did not include an authorization code."))),
        );
        return;
      }

      respondHtml(res, 200, "Authorized", "You can close this tab and return to the terminal.", () =>
        finish(() => resolve(code)),
      );
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out after ${CALLBACK_TIMEOUT_MS / 60_000} minutes waiting for the callback.`)));
    }, CALLBACK_TIMEOUT_MS);

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finish(() =>
          reject(
            new Error(
              `Port ${target.port} is already in use. Close whatever is using it, or set WCL_REDIRECT_URI ` +
                "to a different port (and register that exact URI on your WCL client).",
            ),
          ),
        );
        return;
      }
      finish(() => reject(err));
    });

    server.listen(target.port, target.hostname, onReady);
  });
}

function respondHtml(
  res: ServerResponse,
  status: number,
  heading: string,
  detail: string,
  onFlushed: () => void,
): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(heading)}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">` +
      `<h1 style="font-size:1.25rem">${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p></body>`,
    // Tear the server down only once the bytes are on the wire, so the browser
    // always renders a complete page.
    onFlushed,
  );
}

/**
 * `detail` can carry `error` / `error_description` straight off the callback
 * query string. Anything that reaches this page is attacker-influenceable — the
 * listener answers any request to the callback path during its window, not just
 * WCL's redirect — so it gets escaped rather than interpolated raw.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface CurrentUser {
  id: number;
  name: string;
}

/** Confirm the token actually works, and report whose account it belongs to. */
async function fetchCurrentUser(accessToken: string): Promise<CurrentUser | null> {
  const res = await fetch(USER_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: "{ userData { currentUser { id name } } }" }),
  });
  if (!res.ok) {
    throw new Error(`Token saved, but the verification call failed: HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    data?: { userData?: { currentUser?: CurrentUser | null } | null };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(`Token saved, but verification returned GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data?.userData?.currentUser ?? null;
}

function openBrowser(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? // `start` is a cmd builtin, and its first quoted argument is treated as
          // the window title — hence the empty "". Verbatim args so cmd doesn't
          // split the URL on its `&` query separators.
          spawn(process.env.COMSPEC || "cmd.exe", ["/c", "start", '""', `"${url}"`], {
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
          })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          });
    // A missing `open`/`xdg-open` surfaces asynchronously; swallow it, the URL
    // is already printed above for manual use.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* printed URL is the fallback */
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  // Set the code and let the loop drain rather than process.exit(1). Exiting
  // hard here aborts libuv handles that are still closing — the callback
  // server's sockets, the detached browser process, an in-flight fetch — and on
  // Windows that surfaces as `Assertion failed: !(handle->flags &
  // UV_HANDLE_CLOSING)` instead of the error message we just printed. Every
  // path that reaches here has already closed the server, so nothing keeps the
  // process alive.
  process.exitCode = 1;
});
