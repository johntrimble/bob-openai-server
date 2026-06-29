import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./credentials-worker.mjs", import.meta.url));

// Refresh this long before the token's real expiry so an in-flight request
// never races a token that just expired mid-call.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function createCredentialBroker(bobBundlePath) {
  let cached = null; // { token, instanceId, teamId, baseUrl, expiresAt }
  let inFlight = null;

  function isFresh() {
    return cached && (cached.expiresAt == null || cached.expiresAt - Date.now() > REFRESH_MARGIN_MS);
  }

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = runWorker(bobBundlePath)
      .then((result) => {
        cached = result;
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    async getCredentials() {
      if (isFresh()) return cached;
      return refresh();
    },
    // Call after a request comes back 401 against the real backend - the
    // cached token may have been revoked earlier than its own exp claim
    // suggested. Forces the next getCredentials() call to refresh.
    invalidate() {
      cached = null;
    },
  };
}

function runWorker(bobBundlePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      env: { ...process.env, BOB_BUNDLE_PATH: bobBundlePath },
      timeout: 60_000,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));

    child.on("error", reject);
    child.on("close", (code) => {
      const lastLine = stdout.trim().split("\n").pop() ?? "";
      let parsed;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        reject(new Error(`Credential worker exited (code ${code}) with unparseable output.\nstderr: ${stderr}`));
        return;
      }
      if (parsed.error) reject(new Error(`Credential worker error: ${parsed.error}`));
      else resolve(parsed);
    });
  });
}
