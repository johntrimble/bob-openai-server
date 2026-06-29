import { Readable } from "node:stream";

// The real backend speaks standard OpenAI-shaped endpoints, just under
// /inference/v1/* instead of /v1/*. So callers hit this server's /v1/*,
// and (almost) everything is forwarded as-is to {baseUrl}/inference/v1/*
// with the right auth headers attached - no per-endpoint code needed for
// anything the backend already supports (chat/completions, model/info,
// whatever else shows up later).
//
// /v1/models is the one deliberate exception: it doesn't exist upstream
// at all (the real catalog is at /model/info, under a LiteLLM-specific
// shape: model_name/model_info/litellm_params, not the OpenAI
// {id,object,owned_by} list shape some clients expect), so it gets
// translated instead of forwarded.
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
    const { pathname, search } = new URL(req.url, "http://localhost");

    if (pathname === "/healthz") {
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
      if (req.method === "GET" && pathname === "/v1/models") {
        await handleModels(res, broker);
        return;
      }
      if (pathname.startsWith("/v1/")) {
        await handleProxiedRequest(req, res, broker, pathname.slice(3) + search);
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
  const upstreamRes = await forwardToUpstream(credentials, "GET", "/model/info", {}, null);
  if (!upstreamRes.ok) {
    throw new Error(`Failed to fetch model list: HTTP ${upstreamRes.status}`);
  }
  const json = await upstreamRes.json();
  const models = (json.data || []).map((m) => m.model_name).filter(Boolean);
  modelListCache = { models, expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS };
  return models;
}

async function handleProxiedRequest(req, res, broker, upstreamPath) {
  const reqBodyBuffer = await readBody(req);

  let credentials = await broker.getCredentials();
  let upstreamRes = await forwardToUpstream(credentials, req.method, upstreamPath, req.headers, reqBodyBuffer);

  if (upstreamRes.status === 401) {
    broker.invalidate();
    credentials = await broker.getCredentials();
    upstreamRes = await forwardToUpstream(credentials, req.method, upstreamPath, req.headers, reqBodyBuffer);
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

async function forwardToUpstream(credentials, method, upstreamPath, reqHeaders, bodyBuffer) {
  const url = `${credentials.baseUrl}/inference/v1${upstreamPath}`;
  const headers = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    headers[key] = value;
  }
  headers.authorization = `Bearer ${credentials.token}`;
  headers["x-instance-id"] = credentials.instanceId;
  headers["x-team-id"] = credentials.teamId;

  return fetch(url, {
    method,
    headers,
    body: bodyBuffer && bodyBuffer.length > 0 ? bodyBuffer : undefined,
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
