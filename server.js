// Mori web server: dependency-free static hosting plus a constrained media gateway.
const path = require("node:path");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const port = Number.parseInt(process.env.PORT || "4173", 10);
const selectedRoot = process.argv.includes("--dist") ? "dist" : process.env.MORI_WEB_ROOT || "public";
const publicDir = path.resolve(__dirname, selectedRoot);
const maxApiBytes = 20 * 1024 * 1024;
const maxRequestBytes = 2 * 1024 * 1024;
const maxDownloadBytes = Number.parseInt(
  process.env.MORI_MAX_DOWNLOAD_BYTES || String(2 * 1024 * 1024 * 1024),
  10,
);

// Supported social platforms, scraper providers, and their common media CDNs.
const allowedHostSuffixes = new Set([
  "instagram.com", "cdninstagram.com", "fbcdn.net",
  "tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "muscdn.com", "ibytedtos.com", "byteoversea.com",
  "youtube.com", "youtu.be", "googlevideo.com", "ytimg.com",
  "twitter.com", "x.com", "twimg.com", "acxcdn.com",
  "spotify.com", "scdn.co", "spotifycdn.com",
  "apple.com", "mzstatic.com",
  "pinterest.com", "pin.it", "pinimg.com",
  "facebook.com", "fb.watch",
  "xiaohongshu.com", "rednote.com", "xhslink.com", "xhslink.cn", "xhscdn.com",
  "threads.com", "threads.net",
  "bilibili.com", "bilibili.tv", "b23.tv", "bili.im", "bilivideo.com", "bstarstatic.com", "hdslb.com", "akamaized.net",
  "pixiv.net", "pximg.net", "pixiv.re", "ugoira.com",
  "douyin.com", "iesdouyin.com", "snssdk.com", "douyinpic.com", "douyinvod.com", "amemv.com",
  "bandcamp.com", "bcbits.com", "bandcampdownloader.app",
  "reddit.com", "redd.it", "redditmedia.com", "redditstatic.com",
  "terabox.com", "teraboxapp.com", "teraboxlink.com", "1024tera.com", "nephobox.com", "4funbox.com", "mirrobox.com", "momerybox.com", "tibibox.com",
  "indown.net", "snapsave.app", "tikdownloader.io", "tiktokio.com",
  "twittervideodownloader.com", "savetwt.com", "fxtwitter.com",
  "ytmp3.gg", "ytmp3.mobi", "convert1s.com", "ymcdn.org", "lilillliiillliillii.shop",
  "spotidown.app", "spotimate.app", "soundloaders.app", "aplmate.com", "pindown.io",
  "snaptik.app", "snapcdn.app", "rapidcdn.app", "tweeload.com",
  "threadster.app", "rapidsave.com", "sechno.com", "sankavollerei.web.id",
]);

for (const host of (process.env.MORI_PROXY_HOSTS || "").split(",")) {
  const normalized = host.trim().toLowerCase().replace(/^\./, "");
  if (normalized) allowedHostSuffixes.add(normalized);
}

const outboundHeaderNames = new Set([
  "accept", "accept-language", "content-type", "cookie", "origin", "range",
  "referer", "user-agent", "x-requested-with",
]);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const requestBuckets = new Map();
setInterval(() => {
  const expiry = Date.now() - 120_000;
  for (const [key, bucket] of requestBuckets) {
    if (bucket.startedAt < expiry) requestBuckets.delete(key);
  }
}, 60_000).unref();

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function validateApiRequest(req, res, pathname) {
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    sendJson(res, 403, { error: "Cross-site gateway requests are not allowed." });
    return false;
  }
  if (pathname !== "/api/health" && req.headers["x-mori-web"] !== "1") {
    sendJson(res, 403, { error: "Missing Mori web request header." });
    return false;
  }

  const now = Date.now();
  const key = req.socket.remoteAddress || "unknown";
  const bucket = requestBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= 60_000) {
    requestBuckets.set(key, { count: 1, startedAt: now });
  } else if (++bucket.count > 120) {
    res.setHeader("Retry-After", "60");
    sendJson(res, 429, { error: "Too many requests. Try again shortly." });
    return false;
  }
  return true;
}

function hostnameAllowed(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const suffix of allowedHostSuffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

function isBlockedIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isBlockedAddress(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (net.isIPv4(normalized)) return isBlockedIpv4(normalized);
  if (!net.isIPv6(normalized)) return true;
  if (normalized.startsWith("::ffff:")) return isBlockedIpv4(normalized.slice(7));
  return (
    normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("2001:db8:")
  );
}

async function validateTarget(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("Invalid target URL."), { statusCode: 400 });
  }
  if (target.protocol !== "https:" || target.username || target.password || target.port) {
    throw Object.assign(new Error("Only standard HTTPS target URLs are allowed."), { statusCode: 400 });
  }
  if (!hostnameAllowed(target.hostname)) {
    throw Object.assign(new Error(`Host is not enabled for Mori Web: ${target.hostname}`), { statusCode: 403 });
  }

  const records = await dns.lookup(target.hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isBlockedAddress(record.address))) {
    throw Object.assign(new Error("Target resolved to a blocked network address."), { statusCode: 403 });
  }
  return target;
}

function filterHeaders(input = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input || {})) {
    const lower = name.toLowerCase();
    if (outboundHeaderNames.has(lower) && value != null) headers.set(lower, String(value));
  }
  return headers;
}

async function fetchWithSafeRedirects(rawUrl, init = {}) {
  let target = await validateTarget(rawUrl);
  let method = String(init.method || "GET").toUpperCase();
  let body = init.body;

  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const response = await fetch(target, {
      method,
      headers: init.headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: AbortSignal.timeout(180_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: target.href };

    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: target.href };
    if (redirectCount === 5) throw Object.assign(new Error("Too many upstream redirects."), { statusCode: 502 });
    target = await validateTarget(new URL(location, target).href);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
  throw Object.assign(new Error("Unable to resolve upstream request."), { statusCode: 502 });
}

async function readResponseText(response) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
  if (declaredLength > maxApiBytes) throw Object.assign(new Error("Upstream response is too large."), { statusCode: 413 });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxApiBytes) throw Object.assign(new Error("Upstream response is too large."), { statusCode: 413 });
  return bytes.toString("utf8");
}

function responseHeaders(response) {
  const headers = Object.fromEntries(response.headers.entries());
  if (typeof response.headers.getSetCookie === "function") {
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies;
  }
  return headers;
}

function normalizeAioPayload(payload, sourceUrl) {
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error("Server 3 returned an invalid response."), { statusCode: 502 });
  }
  if (payload.status === false || payload.success === false) {
    throw Object.assign(
      new Error(payload.message || payload.error || "Server 3 could not process this URL."),
      { statusCode: 502 },
    );
  }

  const root = payload.result ?? payload.data ?? payload;
  const metadata =
    (root && typeof root === "object" && !Array.isArray(root)
      ? root.metadata ?? root.videoMetadata ?? root.info ?? root
      : {}) || {};
  const downloads = [];
  const seen = new Set();

  const addDownload = (rawUrl, item = {}, hint = "") => {
    if (typeof rawUrl !== "string") return;
    let mediaUrl;
    try {
      mediaUrl = new URL(rawUrl);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(mediaUrl.protocol) || seen.has(mediaUrl.href)) return;
    seen.add(mediaUrl.href);

    const quality = String(
      item.quality ?? item.resolution ?? item.label ?? item.size ?? "",
    ).trim();
    const format = String(
      item.format ?? item.extension ?? item.ext ?? item.mimeType ?? item.mime ?? hint,
    ).trim();
    const descriptor = `${format} ${quality} ${mediaUrl.pathname}`.toLowerCase();
    let type;
    if (/audio|mp3|m4a|aac|wav|flac|ogg|opus/.test(descriptor)) {
      type = format && !format.includes("/") ? format.toUpperCase() : "MP3";
    } else if (/image|photo|jpe?g|png|webp|gif/.test(descriptor)) {
      type = "PHOTO";
    } else {
      const videoFormat =
        format && !format.includes("/") && !/^video$/i.test(format)
          ? format.toUpperCase()
          : "MP4";
      type = quality && !videoFormat.toLowerCase().includes(quality.toLowerCase())
        ? `${videoFormat} ${quality}`
        : videoFormat;
    }

    downloads.push({
      url: mediaUrl.href,
      type,
      ...(quality ? { quality } : {}),
      ...(typeof item.thumbnail === "string" ? { thumbnail: item.thumbnail } : {}),
      isMirror: Boolean(item.isMirror),
    });
  };

  const collect = (node, hint = "", depth = 0) => {
    if (node == null || depth > 4) return;
    if (typeof node === "string") {
      addDownload(node, {}, hint);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry) => collect(entry, hint, depth + 1));
      return;
    }
    if (typeof node !== "object") return;

    const directUrl =
      node.url ?? node.link ?? node.downloadUrl ?? node.download_url ??
      node.fileUrl ?? node.file_url ?? node.src;
    if (typeof directUrl === "string") addDownload(directUrl, node, hint);

    const variantKeys = [
      "video", "videoUrl", "video_url", "audio", "audioUrl", "audio_url",
      "hd", "sd", "download", "downloadLink", "download_link",
    ];
    for (const key of variantKeys) {
      const value = node[key];
      if (typeof value === "string") addDownload(value, node, key);
      else if (value && typeof value === "object") collect(value, key, depth + 1);
    }

    const containerKeys = [
      "downloads", "medias", "media", "links", "formats", "urls", "items",
    ];
    for (const key of containerKeys) {
      if (node[key] != null) collect(node[key], key, depth + 1);
    }
  };

  collect(root);
  if (root !== payload) collect(payload.downloads ?? payload.medias ?? payload.media);

  if (!downloads.length) {
    throw Object.assign(new Error("Server 3 returned no downloadable media."), { statusCode: 502 });
  }

  const categoryRank = (download) =>
    /mp4|video|\d+p/i.test(download.type) ? 0 :
      /photo|image|jpe?g|png|webp/i.test(download.type) ? 1 : 2;
  downloads.sort((a, b) => categoryRank(a) - categoryRank(b));

  const firstString = (...values) =>
    values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
  return {
    status: true,
    result: {
      title: firstString(metadata.title, root?.title, payload.title, "Media Download"),
      author: firstString(
        metadata.author,
        metadata.creator,
        metadata.uploader,
        root?.author,
        payload.author,
        "Creator",
      ),
      thumbnail: firstString(
        metadata.thumbnail,
        metadata.cover,
        metadata.image,
        root?.thumbnail,
        payload.thumbnail,
      ),
      downloads,
      sourceUrl,
    },
  };
}

async function readJsonBody(req) {
  // Vercel Node Functions pre-parse JSON into request.body. The local server
  // still exposes the original IncomingMessage stream, so support both forms.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      const serialized = JSON.stringify(req.body);
      if (Buffer.byteLength(serialized) > maxRequestBytes) {
        throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
      }
      return req.body;
    }

    const parsedBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : String(req.body);
    if (Buffer.byteLength(parsedBody) > maxRequestBytes) {
      throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    }
    try {
      return JSON.parse(parsedBody || "{}");
    } catch {
      throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
    }
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxRequestBytes) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

async function handleHttpGateway(req, res) {
  const { url, method = "GET", headers = {}, body } = await readJsonBody(req);
  if (!url) return sendJson(res, 400, { error: "A target URL is required." });
  const normalizedMethod = String(method).toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE", "HEAD"].includes(normalizedMethod)) {
    return sendJson(res, 405, { error: "Unsupported HTTP method." });
  }
  const result = await fetchWithSafeRedirects(url, {
    method: normalizedMethod,
    headers: filterHeaders(headers),
    body: typeof body === "string" ? body : body == null ? undefined : JSON.stringify(body),
  });
  const data = normalizedMethod === "HEAD" ? "" : await readResponseText(result.response);
  sendJson(res, 200, {
    status: result.response.status,
    headers: responseHeaders(result.response),
    data,
    url: result.finalUrl,
  });
}

async function handleAioGateway(req, res) {
  const { url } = await readJsonBody(req);
  if (!url) return sendJson(res, 400, { error: "A media URL is required." });

  let source;
  try {
    source = new URL(url);
  } catch {
    return sendJson(res, 400, { error: "Invalid media URL." });
  }
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
    return sendJson(res, 400, { error: "Only public HTTP(S) media URLs are supported." });
  }

  const apiKey = process.env.SANKAVOLLEREI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 503, {
      error: "Server 3 is not configured. Set SANKAVOLLEREI_API_KEY in Vercel.",
    });
  }

  const endpoint = new URL("https://www.sankavollerei.web.id/download/aio");
  endpoint.searchParams.set("apikey", apiKey);
  endpoint.searchParams.set("url", source.href);

  const upstream = await fetchWithSafeRedirects(endpoint.href, {
    method: "GET",
    headers: new Headers({
      Accept: "application/json",
      "User-Agent": "Rich-Downloader/1.0",
    }),
  });
  if (!upstream.response.ok) {
    return sendJson(res, 502, {
      error: `Server 3 returned HTTP ${upstream.response.status}.`,
    });
  }

  const responseText = await readResponseText(upstream.response);
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return sendJson(res, 502, { error: "Server 3 returned invalid JSON." });
  }

  sendJson(res, 200, normalizeAioPayload(payload, source.href));
}

function safeFilename(value) {
  return String(value || "mori-download")
    .replace(/[\r\n"\\/<>:*?|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180) || "mori-download";
}

async function handleDownloadGateway(req, res) {
  const { url, headers = {}, filename } = await readJsonBody(req);
  if (!url) return sendJson(res, 400, { error: "A media URL is required." });
  const result = await fetchWithSafeRedirects(url, {
    method: "GET",
    headers: filterHeaders(headers),
  });
  if (!result.response.ok && result.response.status !== 206) {
    const detail = (await readResponseText(result.response)).slice(0, 500);
    return sendJson(res, 502, { error: `Media server returned ${result.response.status}.`, detail });
  }

  const declaredLength = Number.parseInt(result.response.headers.get("content-length") || "0", 10);
  if (declaredLength > maxDownloadBytes) {
    return sendJson(res, 413, { error: "Media file exceeds the configured download limit." });
  }

  res.statusCode = result.response.status;
  res.setHeader("Content-Type", result.response.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(filename)}"`);
  res.setHeader("Cache-Control", "private, no-store");
  for (const header of ["content-length", "content-range", "accept-ranges"]) {
    const value = result.response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!result.response.body) return res.end();

  let streamedBytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      streamedBytes += chunk.length;
      if (streamedBytes > maxDownloadBytes) callback(new Error("Media file exceeds the configured download limit."));
      else callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(result.response.body), limiter, res);
}

function safeStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const resolved = path.resolve(publicDir, `.${decoded}`);
  return resolved === publicDir || resolved.startsWith(`${publicDir}${path.sep}`) ? resolved : null;
}

async function serveFile(req, res, filePath) {
  const info = await fsp.stat(filePath);
  if (!info.isFile()) return false;
  const extension = path.extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", mimeTypes[extension] || "application/octet-stream");
  res.setHeader("Content-Length", info.size);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Cache-Control",
    extension === ".html" || filePath.endsWith("service-worker.js")
      ? "no-cache"
      : "public, max-age=3600",
  );
  if (filePath.endsWith("service-worker.js")) res.setHeader("Service-Worker-Allowed", "./");
  if (req.method === "HEAD") return res.end(), true;
  await pipeline(fs.createReadStream(filePath), res);
  return true;
}

async function handleStatic(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  let filePath = safeStaticPath(pathname === "/" ? "/index.html" : pathname);
  if (filePath) {
    try {
      const info = await fsp.stat(filePath);
      if (info.isDirectory()) filePath = path.join(filePath, "index.html");
      if (await serveFile(req, res, filePath)) return;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }

  if ((req.headers.accept || "").includes("text/html")) {
    await serveFile(req, res, path.join(publicDir, "index.html"));
    return;
  }
  sendJson(res, 404, { error: "Not found." });
}

async function handleRequest(req, res) {
  try {
    const requestUrl = new URL(req.url, "http://localhost");
    const { pathname } = requestUrl;
    if (pathname.startsWith("/api/")) {
      if (!validateApiRequest(req, res, pathname)) return;
      if (pathname === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          service: "mori-web",
          allowedHosts: allowedHostSuffixes.size,
          server3Configured: Boolean(process.env.SANKAVOLLEREI_API_KEY),
        });
      }
      if (pathname === "/api/http" && req.method === "POST") return await handleHttpGateway(req, res);
      if (pathname === "/api/aio" && req.method === "POST") return await handleAioGateway(req, res);
      if (pathname === "/api/download" && req.method === "POST") return await handleDownloadGateway(req, res);
      return sendJson(res, 404, { error: "Unknown API endpoint." });
    }
    await handleStatic(req, res, pathname);
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) console.error("[Mori Web]", error);
    if (res.headersSent) {
      res.destroy(error);
    } else {
      const causeCode = error?.cause?.code;
      const message = error.message || "Gateway request failed.";
      sendJson(res, error.statusCode || 502, {
        error: causeCode ? `${message} (${causeCode})` : message,
      });
    }
  }
}

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Mori Web is available at http://localhost:${port}`);
  });
}

module.exports = handleRequest;
