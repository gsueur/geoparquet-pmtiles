// geoparquet-demo.geomermaids.com: static assets, plus /data/* served from R2 with HTTP Range
// support (single ranges, including suffix ranges "bytes=-N"), the way the demo reads its file.
const PREFIX = "geoparquet-demo/";
const FILES = new Set(["massgis-parcels.parquet", "clc-2018.parquet"]);
const TYPES = { parquet: "application/vnd.apache.parquet", pmtiles: "application/vnd.pmtiles" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/data/")) return env.ASSETS.fetch(request);
    const name = url.pathname.slice(6);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors({ "Access-Control-Allow-Headers": "Range, If-None-Match", "Access-Control-Max-Age": "86400" }) });
    if (!FILES.has(name)) return new Response("Not Found", { status: 404, headers: cors() });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: cors() });
    return serve(PREFIX + name, name, request, env);
  },
};

async function serve(key, name, request, env) {
  const type = TYPES[name.split(".").pop()];
  if (request.method === "HEAD") {
    const head = await env.DATA.head(key);
    if (!head) return new Response("Not Found", { status: 404, headers: cors() });
    return new Response(null, { status: 200, headers: headers(head, type, { "Content-Length": String(head.size) }) });
  }
  const range = parseRange(request.headers.get("range"));
  const opts = {};
  if (range) opts.range = range;
  if (request.headers.has("if-none-match")) opts.onlyIf = request.headers;
  const obj = await env.DATA.get(key, opts);
  if (!obj) return new Response("Not Found", { status: 404, headers: cors() });
  if (!("body" in obj) || obj.body === null) return new Response(null, { status: 304, headers: headers(obj, type) });
  if (range) {
    const { offset, length } = bounds(range, obj.size);
    if (length <= 0) return new Response(null, { status: 416, headers: cors({ "Content-Range": `bytes */${obj.size}` }) });
    return new Response(obj.body, { status: 206, headers: headers(obj, type, { "Content-Range": `bytes ${offset}-${offset + length - 1}/${obj.size}`, "Content-Length": String(length) }) });
  }
  return new Response(obj.body, { status: 200, headers: headers(obj, type, { "Content-Length": String(obj.size) }) });
}

function headers(obj, type, extra = {}) {
  return cors({ "Content-Type": type, "Accept-Ranges": "bytes", "ETag": obj.httpEtag, "Cache-Control": "public, max-age=3600", ...extra });
}

function cors(extra = {}) {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag", ...extra };
}

function parseRange(h) {
  const m = h && /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  return m[2] === "" ? { offset } : { offset, length: Number(m[2]) - offset + 1 };
}

function bounds(r, size) {
  if ("suffix" in r) { const length = Math.min(r.suffix, size); return { offset: size - length, length }; }
  return { offset: r.offset, length: Math.min(r.length ?? size - r.offset, size - r.offset) };
}
