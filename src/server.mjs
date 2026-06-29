import http from "node:http";
import { loadConfig } from "./config.mjs";
import { createCredentialBroker } from "./credentials.mjs";
import { createRequestHandler } from "./handlers.mjs";
import { bobshellVersion } from "./locate-bob.mjs";

export function startServer(env = process.env) {
  const config = loadConfig(env);
  const broker = createCredentialBroker(config.bobBundlePath);
  const server = http.createServer(createRequestHandler(config, broker));

  server.listen(config.port, config.host, () => {
    console.log(`[bob-openai-server] listening on http://${config.host}:${config.port}`);
    console.log(`[bob-openai-server] using bobshell ${bobshellVersion(config.bobBundlePath)} at ${config.bobBundlePath}`);
    console.log(
      config.apiKey
        ? "[bob-openai-server] callers must send Authorization: Bearer <BOB_SERVER_API_KEY>"
        : "[bob-openai-server] running WITHOUT authentication - see the warning above",
    );
  });

  return server;
}
