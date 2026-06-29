#!/usr/bin/env node
import { startServer } from "../src/server.mjs";

try {
  startServer();
} catch (err) {
  console.error(`[bob-openai-server] failed to start: ${err.message}`);
  process.exit(1);
}
