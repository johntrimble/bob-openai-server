import { locateBobBundle } from "./locate-bob.mjs";

export function loadConfig(env = process.env) {
  if (!env.BOB_SERVER_API_KEY) {
    console.warn(
      "[bob-openai-server] WARNING: BOB_SERVER_API_KEY is not set - this server is running with NO authentication of " +
        "its own. Anything that can reach it can make real, billed calls against your IBM Bob entitlement. Set " +
        "BOB_SERVER_API_KEY to require a bearer token from callers.",
    );
  }

  return {
    port: Number(env.BOB_SERVER_PORT || 8766),
    host: env.BOB_SERVER_HOST || "127.0.0.1",
    apiKey: env.BOB_SERVER_API_KEY || null,
    bobBundlePath: locateBobBundle(env),
  };
}
