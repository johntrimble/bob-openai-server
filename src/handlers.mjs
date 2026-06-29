import { Readable } from "node:stream";

// GET {baseUrl}/inference/v1/model/info is the real, authoritative model
// catalog for this account - the same endpoint Bob's own CLI calls
// internally for an SSO-authenticated session (isAuthnBackend() routes
// getLiteLLMModels() to this exact path). The OpenRouter-shaped /v1/models
// and the non-/inference-prefixed /v1/model/info both 403 - only this one
// works. Cached briefly so a burst of /v1/models calls doesn't re-fetch
// every time, but short enough that entitlement changes show up promptly.
const MODEL_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
let modelListCache = null; // { models, expiresAt }

const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "content-encoding",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "authorization",
]);

export function createRequestHandler(config, broker) {
  return async function handleRequest(req, res) {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (!isAuthorized(req, config)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Missing or invalid Authorization header" } }));
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        await handleModels(res, broker);
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        await handleChatCompletions(req, res, config, broker);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no such path" } }));
    } catch (err) {
      console.error(`[bob-openai-server] error handling ${req.method} ${req.url}:`, err);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err?.message || err) } }));
      } else {
        res.destroy(err);
      }
    }
  };
}

function isAuthorized(req, config) {
  if (!config.apiKey) return true; // unauthenticated mode - warned about loudly at startup
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match) && match[1] === config.apiKey;
}

async function handleModels(res, broker) {
  const models = await getModelList(broker);
  const body = JSON.stringify({
    object: "list",
    data: models.map((id) => ({ id, object: "model", owned_by: "ibm-bob" })),
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}

async function getModelList(broker) {
  if (modelListCache && modelListCache.expiresAt > Date.now()) {
    return modelListCache.models;
  }
  const credentials = await broker.getCredentials();
  const res = await fetch(`${credentials.baseUrl}/inference/v1/model/info`, {
    headers: {
      authorization: `Bearer ${credentials.token}`,
      "x-instance-id": credentials.instanceId,
      "x-team-id": credentials.teamId,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch model list: HTTP ${res.status}`);
  }
  const json = await res.json();
  const models = (json.data || []).map((m) => m.model_name).filter(Boolean);
  modelListCache = { models, expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS };
  return models;
}

async function handleChatCompletions(req, res, config, broker) {
  const reqBodyBuffer = await readBody(req);

  let credentials = await broker.getCredentials();
  let upstreamRes = await forwardToUpstream(credentials, reqBodyBuffer);

  if (upstreamRes.status === 401) {
    broker.invalidate();
    credentials = await broker.getCredentials();
    upstreamRes = await forwardToUpstream(credentials, reqBodyBuffer);
  }

  const resHeaders = {};
  upstreamRes.headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key)) return;
    resHeaders[key] = value;
  });
  res.writeHead(upstreamRes.status, resHeaders);

  if (!upstreamRes.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstreamRes.body).pipe(res);
}

async function forwardToUpstream(credentials, reqBodyBuffer) {
  const url = `${credentials.baseUrl}/inference/v1/chat/completions`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credentials.token}`,
      "x-instance-id": credentials.instanceId,
      "x-team-id": credentials.teamId,
    },
    body: reqBodyBuffer,
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
