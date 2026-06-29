// Run as a short-lived child process (see credentials.mjs for why: bob.js has
// zero exported entry points and runs its whole CLI unconditionally on
// import, calling process.exit() itself in several places - one process per
// credential fetch is far less fragile than fighting either of those).
//
// Lets bob.js run its own normal startup (which silently refreshes its
// bearer token via its own stored refresh token if needed - see
// docs/bob-authentication.md from the research this project grew out of,
// reproduced in this repo's README) and intercepts the first outbound
// chat-completions call just to read the Authorization/X-Instance-ID/X-Team-ID
// headers it already attached. Crucially, it fakes the response *before*
// forwarding, so capturing credentials never spends real tokens.
//
// Reads BOB_BUNDLE_PATH from the environment, prints exactly one JSON line to
// stdout: { token, instanceId, teamId, baseUrl, expiresAt } or { error }.
// Everything else (bob's own debug/progress output) goes to stderr only -
// bob's bootstrap reassigns console.log to console.error, so this uses
// process.stdout.write directly to avoid losing the result line to stderr.

const BOB_BUNDLE = process.env.BOB_BUNDLE_PATH;
if (!BOB_BUNDLE) {
  process.stdout.write(JSON.stringify({ error: "BOB_BUNDLE_PATH is required" }));
  process.exit(1);
}

function decodeJwtExpiry(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const { exp } = JSON.parse(json);
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

const realFetch = globalThis.fetch;
let intercepted = false;

globalThis.fetch = async (url, init) => {
  const urlStr = typeof url === "string" ? url : url.toString();
  if (!intercepted && init?.method === "POST" && urlStr.includes("/chat/completions")) {
    intercepted = true;
    const headers = {};
    for (const [k, v] of new Headers(init.headers).entries()) headers[k] = v;

    const token = headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
    const result = {
      token,
      instanceId: headers["x-instance-id"] ?? null,
      teamId: headers["x-team-id"] ?? null,
      baseUrl: new URL(urlStr).origin,
      expiresAt: token ? decodeJwtExpiry(token) : null,
    };

    if (!result.token || !result.instanceId || !result.teamId) {
      process.stdout.write(JSON.stringify({ error: `Incomplete credentials captured: ${JSON.stringify(headers)}` }));
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  }
  // Never actually forward - capturing credentials should never spend a real
  // token. Anything bob.js does that isn't the chat-completions call still
  // goes through (e.g. cached profile checks before the SSO refresh fires).
  if (!intercepted) return realFetch(url, init);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

process.argv = [process.argv[0], process.argv[1], "-p", "trigger", "-o", "text", "--hide-intermediary-output"];

try {
  await import(BOB_BUNDLE);
} catch (err) {
  process.stdout.write(JSON.stringify({ error: `bob.js startup failed: ${err?.message || err}` }));
  process.exit(1);
}
