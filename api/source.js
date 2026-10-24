/**
 * Triple + ReelsDownload Video Source API - Castle + Modiplay + MovieBox + ReelsDownload (CinemaOS NDJSON)
 * Fixed: GZIP decompression, Modiplay relative URL handling, and NDJSON DASH extraction with subtitles.
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');
const crypto = require('crypto');

// ============================================================
// CONFIGURATION & PROXY LOGIC
// ============================================================

const CASTLE_API = "https://api.hlowb.com";
const MODIPLAY_API = "https://rozgarlelo.modiplay.xyz";
const MOVIEBOX_BASE_URL = "https://h5-api.aoneroom.com";
const MOVIEBOX_H5_WEB = "https://h5.aoneroom.com";
const REELSDOWNLOAD_API = "https://embed.reelsdownload.online/api/cinemaos-extract";

const MOVIEBOX_REFERER = "https://movieboxonline.net/";
const PROXY_BASE = "https://workingg.vercel.app/api/proxy";

const DEFAULT_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

let movieBoxTokenCache = { token: null, expiresAt: 0 };

// ============================================================
// UTILITIES & PROXY PROBING
// ============================================================

function cleanVideoUrl(url, decode = true) {
  if (!url) return "";
  let cleaned = String(url)
    .replaceAll('\\/', '/')
    .replaceAll('\\', '');
  
  if (decode) {
    try {
      if (!cleaned.includes('stream_proxy.php?url=')) {
        cleaned = decodeURIComponent(cleaned);
      }
    } catch (e) {}
  }
  return cleaned.trim();
}

function createLogger(isDebug) {
  const logs = [];
  return {
    log: (step, message, details = null) => {
      if (isDebug) {
        logs.push({
          time: new Date().toISOString(),
          step,
          message,
          ...(details !== null && details !== undefined ? { details } : {})
        });
      }
    },
    getLogs: () => logs
  };
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

function fetchUrl(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlString);
      const protocol = url.protocol === "https:" ? https : http;

      const requestOptions = {
        method: options.method || "GET",
        headers: {
          "User-Agent": options.userAgent || DEFAULT_UA,
          "Accept-Encoding": "gzip, deflate, br",
          ...options.headers,
        },
        timeout: options.timeout || 20000,
      };

      const req = protocol.request(url, requestOptions, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let buffer = Buffer.concat(chunks);
          const encoding = res.headers["content-encoding"];

          try {
            if (encoding === "gzip") {
              buffer = zlib.gunzipSync(buffer);
            } else if (encoding === "deflate") {
              buffer = zlib.inflateSync(buffer);
            } else if (encoding === "br") {
              buffer = zlib.brotliDecompressSync(buffer);
            }
          } catch (e) {}

          const data = buffer.toString("utf-8");
          if (res.statusCode >= 200 && res.statusCode < 400) {
            resolve({ data, statusCode: res.statusCode, headers: res.headers });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 150)}`));
          }
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      if (options.body) {
        req.write(typeof options.body === 'object' ? JSON.stringify(options.body) : options.body);
      }

      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

function buildPipeUrl(url, headers = {}) {
  if (!url) return "";
  const cleanedUrl = cleanVideoUrl(url);
  const pairs = Object.entries(headers)
    .filter(([_, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return pairs ? `${cleanedUrl}|${pairs}` : cleanedUrl;
}

function buildProxyUrl(streamUrl, headers = {}, proxyBase = PROXY_BASE, mode = null) {
  const combined = buildPipeUrl(streamUrl, headers);
  let url = `${proxyBase}?url=${encodeURIComponent(combined)}`;
  if (mode) url += `&mode=${mode}`;
  return url;
}

function proxyHeaderVariants(finalHeaders = {}) {
  const cookie = finalHeaders["Cookie"] || finalHeaders["cookie"];
  const ua = finalHeaders["User-Agent"] || DEFAULT_UA;
  const referer = finalHeaders["Referer"] || MOVIEBOX_REFERER;
  const origin = finalHeaders["Origin"] || "https://movieboxonline.net";

  const withCookie = (h) => {
    if (cookie) h["Cookie"] = cookie;
    return h;
  };

  const variants = [
    ["full", { ...finalHeaders }],
    ["full + accept-encoding", { ...finalHeaders, "Accept-Encoding": "gzip, deflate" }],
    ["referer + origin + ua", withCookie({ "Referer": referer, "Origin": origin, "User-Agent": ua })],
    ["referer + ua", withCookie({ "Referer": referer, "User-Agent": ua })],
    ["ua only", withCookie({ "User-Agent": ua })],
    ["no headers", withCookie({})],
  ];

  const seen = new Set();
  const unique = [];
  for (const [name, hdrs] of variants) {
    const key = JSON.stringify(hdrs, Object.keys(hdrs).sort());
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ name, hdrs });
  }
  return unique;
}

async function probeViaProxy(proxyUrl, timeout = 12000) {
  try {
    const res = await fetchUrl(proxyUrl, {
      headers: { "Range": "bytes=0-1", "Accept": "*/*" },
      timeout,
    });
    return { status: res.statusCode, upstream: res.headers["x-upstream-status"] || "" };
  } catch (e) {
    return { status: null, upstream: e.message.substring(0, 80) };
  }
}

async function findWorkingProxyVariant(streamUrl, finalHeaders, proxyBase = PROXY_BASE, logger, mode = null) {
  const variants = proxyHeaderVariants(finalHeaders);
  const attempts = [];

  for (const { name, hdrs } of variants) {
    const proxyUrl = buildProxyUrl(streamUrl, hdrs, proxyBase, mode);
    const { status, upstream } = await probeViaProxy(proxyUrl);

    attempts.push({ variant: name, status, upstream });
    const mark = (status === 200 || status === 206) ? "✔" : "✘";
    const extra = upstream ? ` (upstream ${upstream})` : "";
    logger.log("PROXY_PROBE", `proxy variant '${name}': HTTP ${status} ${mark}${extra}`);

    if (status === 200 || status === 206) {
      return {
        ok: true,
        variant: name,
        headers: hdrs,
        proxy_url: proxyUrl,
        attempts,
      };
    }
  }

  return {
    ok: false,
    variant: null,
    headers: finalHeaders,
    proxy_url: buildProxyUrl(streamUrl, finalHeaders, proxyBase, mode),
    attempts,
  };
}

function unwrapData(json) {
  if (!json || typeof json !== 'object') return {};
  const data = json.data || json;
  return data.data || data;
}

function cleanTitleString(title) {
  if (!title) return '';
  return title
    .replace(/\[.*?\]/g, '')
    .replace(/\s*S\d+(?:-S?\d+)*$/i, '')
    .replace(/\s*Season\s*\d+/i, '')
    .trim()
    .toLowerCase();
}

function extractLanguageTag(title) {
  const match = title.match(/\[(.*?)\]/);
  return match ? match[1].trim() : 'Original';
}

function dashManifestFromPolicy(signCookie) {
  if (!signCookie || typeof signCookie !== 'string') return null;
  let policyPart = null;
  for (const item of signCookie.split(';')) {
    const trimmed = item.trim();
    if (trimmed.startsWith('CloudFront-Policy=')) {
      policyPart = trimmed.split('=')[1].trim().replace(/^"|"$/g, '');
      break;
    }
  }
  if (!policyPart) return null;

  try {
    let stdB64 = policyPart.replace(/-/g, '+').replace(/~/g, '/').replace(/_/g, '=');
    stdB64 = stdB64.replace(/\s+/g, '').replace(/=+$/, '');
    stdB64 += '='.repeat((4 - (stdB64.length % 4)) % 4);

    const decoded = Buffer.from(stdB64, 'base64').toString('utf-8');
    const policyJson = JSON.parse(decoded);
    const statements = policyJson.Statement || [];
    if (!statements.length) return null;

    let resource = (statements[0].Resource || '').trim();
    let baseResource = resource.replace(/\*+$/, '').replace(/\/+$/, '');
    if (!baseResource || !baseResource.startsWith('http')) return null;

    if (baseResource.toLowerCase().endsWith('.mpd')) {
      return baseResource;
    }
    return baseResource + '/index.mpd';
  } catch (e) {
    return null;
  }
}

function cloudfrontCookie(signCookie) {
  if (!signCookie || typeof signCookie !== 'string') return null;
  const parts = [];
  for (let p of signCookie.split(';')) {
    p = p.trim().replace(/^"|"$/g, '');
    if (p.includes('=')) {
      const [key, ...vArr] = p.split('=');
      const val = vArr.join('=').trim().replace(/^"|"$/g, '');
      if (val) parts.push(`${key}=${val}`);
    }
  }
  return parts.length ? parts.join('; ') : null;
}

function resNum(r) {
  const n = parseInt(String(r || '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function selectTopTwoStreams(streams) {
  if (!streams || !streams.length) return [];
  const bestByLang = new Map();
  for (const item of streams) {
    const lang = String(item.language || 'Original');
    const cur = bestByLang.get(lang);
    if (!cur || resNum(item.resolution) > resNum(cur.resolution)) bestByLang.set(lang, item);
  }

  const rank = (lang) => {
    const l = lang.toLowerCase();
    if (l === 'original') return 0;
    if (l.includes('hindi')) return 1;
    return 2;
  };

  return [...bestByLang.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([, v]) => v)
    .slice(0, 2);
}

// ============================================================
// REELSDOWNLOAD / CINEMAOS API (NDJSON Extractor)
// ============================================================

async function extractReelsDownload(title, mediaType = "movie", tmdbId = "", imdbId = "", year = "", season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  try {
    let apiUrl = `${REELSDOWNLOAD_API}?type=${mediaType}`;
    if (tmdbId) apiUrl += `&tmdb_id=${tmdbId}`;
    if (imdbId) apiUrl += `&imdb_id=${imdbId}`;
    if (title) apiUrl += `&title=${encodeURIComponent(title)}`;
    if (year) apiUrl += `&year=${year}`;
    if (mediaType === "tv" && season && episode) {
      apiUrl += `&season=${season}&episode=${episode}`;
    }

    logger.log("REELSDOWNLOAD_REQ", "Fetching ReelsDownload NDJSON extract", { apiUrl });
    const response = await fetchUrl(apiUrl, { userAgent: DEFAULT_UA, timeout: 15000 });
    
    const lines = response.data.split('\n');
    const sources = [];
    const subtitles = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line.trim());
        const srcObj = json.source || json;
        
        // We want ONLY DASH urls as requested
        if (srcObj && srcObj.type === 'dash' && srcObj.url) {
          const langTag = srcObj.label || 'Original';
          const quality = srcObj.quality || 'auto';
          
          sources.push({
            id: srcObj.id || 'reelsdownload',
            source: 'reelsdownload',
            label: langTag,
            language: langTag.includes('-') ? langTag.split('-')[1].trim() : langTag,
            quality: quality,
            resolution: quality,
            type: 'dash',
            url: srcObj.url,
            urlWithHeaders: srcObj.url,
            headers: {},
            proxy_url: srcObj.url,
            proxy_verified: true
          });

          // Collect tracks/subtitles if available
          if (Array.isArray(srcObj.tracks)) {
            for (const tr of srcObj.tracks) {
              if (tr.url && !subtitles.find(s => s.url === tr.url)) {
                let subUrl = tr.url;
                if (subUrl.startsWith('/')) {
                  subUrl = `https://embed.reelsdownload.online${subUrl}`;
                }
                subtitles.push({
                  language: tr.label || tr.lang || 'English',
                  url: subUrl,
                  abbreviate: tr.lang || 'en'
                });
              }
            }
          }
        }
      } catch (e) {}
    }

    if (!sources.length) {
      throw new Error("ReelsDownload: No DASH streams found in NDJSON response");
    }

    logger.log("REELSDOWNLOAD_SUCCESS", `Extracted ${sources.length} DASH streams and ${subtitles.length} subtitles`);

    const primary = sources[0];
    return {
      success: true,
      source: "reelsdownload",
      topTwo: sources.slice(0, 2),
      player1: primary,
      player2: sources[1] || null,
      videoUrl: primary.url,
      urlWithHeaders: primary.url,
      headers: {},
      quality: primary.quality,
      qualities: sources,
      audioTracks: sources.map(s => ({ language: s.language, url: s.url })),
      subtitles: subtitles,
      debugLogs: logger.getLogs()
    };
  } catch (error) {
    logger.log("REELSDOWNLOAD_FATAL_ERROR", error.message);
    return {
      success: false,
      source: "reelsdownload",
      error: error.message,
      debugLogs: logger.getLogs()
    };
  }
}

// ============================================================
// CASTLE API
// ============================================================

function decrypt_castle(cipherText, securityKey) {
  const pepper = Buffer.from("T!BgJB");
  const keyWords = Buffer.from(securityKey, 'base64');
  const combined = Buffer.concat([keyWords, pepper]);
  const keyMaterial = combined.slice(0, 16);

  const cipherBytes = Buffer.from(cipherText, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyMaterial, keyMaterial);

  let decrypted = decipher.update(cipherBytes);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  const padding = decrypted[decrypted.length - 1];
  if (padding >= 1 && padding <= 16) {
    decrypted = decrypted.slice(0, decrypted.length - padding);
  }

  return decrypted.toString('utf-8');
}

async function getCastleSecurityKey(logger) {
  const url = `${CASTLE_API}/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en-US`;
  const response = await fetchUrl(url, { headers: { "Accept": "application/json" } });
  const data = JSON.parse(response.data);
  if (!data.data) throw new Error("Castle security key not found");
  return data.data;
}

async function castleRequest(url, securityKey, logger, options = {}) {
  const response = await fetchUrl(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": "okhttp/4.9.3",
      "Accept": "application/json",
      ...(options.method === "POST" && { "Content-Type": "application/json" }),
    },
    body: options.body,
  });
  let cipherText = response.data;
  try {
    const temp = JSON.parse(response.data);
    if (temp.data && typeof temp.data === 'string') cipherText = temp.data;
  } catch (e) {}
  const decrypted = decrypt_castle(cipherText, securityKey);
  let result = JSON.parse(decrypted);
  return result.data && typeof result.data === 'object' ? result.data : result;
}

async function extractCastle(title, season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  try {
    const securityKey = await getCastleSecurityKey(logger);
    const encoded = encodeURIComponent(title);
    const searchUrl = `${CASTLE_API}/film-api/v1.1.0/movie/searchByKeyword?channel=IndiaA&clientType=1&keyword=${encoded}&lang=en-US&mode=1&packageName=com.external.castle&page=1&size=30`;
    const searchData = await castleRequest(searchUrl, securityKey, logger);
    const rows = searchData.rows || [];
    if (!rows.length) throw new Error("Castle: No search results");

    let movieId = String(rows[0].id || rows[0].redirectId || "");
    const detailUrl = `${CASTLE_API}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&lang=en-US&movieId=${movieId}&packageName=com.external.castle`;
    let details = await castleRequest(detailUrl, securityKey, logger);

    const episodes = details.episodes || details.episodeList || [];
    let episodeData = episodes[Number(episode || 1) - 1] || episodes[0];
    const episodeId = episodeData?.id || movieId;

    const videoUrlPayload = `${CASTLE_API}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=com.external.castle&channel=IndiaA&lang=en-US`;
    const body = {
      mode: "1", appMarket: "GuanWang", clientType: "1", woolUser: "false",
      apkSignKey: process.env.CASTLE_KEY || "814238e2175a1334641887e21235338a",
      androidVersion: "13", movieId: String(movieId), episodeId: String(episodeId),
      isNewUser: "true", resolution: "2", packageName: "com.external.castle"
    };

    const videoData = await castleRequest(videoUrlPayload, securityKey, logger, { method: "POST", body });
    const videoUrl = cleanVideoUrl(videoData.videoUrl || videoData.url || "");
    if (!videoUrl) throw new Error("Castle: Stream URL missing");

    const proxyRes = await findWorkingProxyVariant(videoUrl, {}, PROXY_BASE, logger, "master");
    const streamObj = {
      url: videoUrl,
      urlWithHeaders: proxyRes.proxy_url,
      headers: proxyRes.headers,
      proxy_url: proxyRes.proxy_url,
      resolution: "auto",
      language: "Original"
    };

    return {
      success: true, source: "castle", topTwo: [streamObj], player1: streamObj,
      videoUrl, urlWithHeaders: proxyRes.proxy_url, subtitles: videoData.subtitles || [],
      debugLogs: logger.getLogs()
    };
  } catch (error) {
    logger.log("CASTLE_FATAL_ERROR", error.message);
    return { success: false, source: "castle", error: error.message, debugLogs: logger.getLogs() };
  }
}

// ============================================================
// MODIPLAY API (FIXED RELATIVE URL & PROXY)
// ============================================================

async function extractModiplay(mediaId, mediaType = "tv", season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  try {
    let embedUrl = (mediaType === "tv" && season && episode)
      ? `${MODIPLAY_API}/embed/tmdb/tv?id=${mediaId}&s=${season}&e=${episode}`
      : `${MODIPLAY_API}/embed/tmdb/${mediaType}?id=${mediaId}`;

    logger.log("MODIPLAY_EMBED_REQ", "Fetching embed page", { embedUrl });
    const embedResponse = await fetchUrl(embedUrl, { userAgent: DEFAULT_UA });

    let playerUrl = "";
    const iframeMatch = embedResponse.data.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (iframeMatch) playerUrl = decodeHtmlEntities(iframeMatch[1].trim());
    if (!playerUrl) throw new Error("Modiplay: Player iframe source missing");

    if (playerUrl.startsWith('/')) {
      const urlObj = new URL(embedUrl);
      playerUrl = `${urlObj.protocol}//${urlObj.host}${playerUrl}`;
    }

    logger.log("MODIPLAY_PLAYER_REQ", "Fetching player script", { playerUrl });
    const playerResponse = await fetchUrl(playerUrl, { userAgent: DEFAULT_UA, headers: { "Referer": embedUrl } });

    let html = playerResponse.data;
    let videoUrl = "";
    let directVideoUrl = "";

    const srcMatch = html.match(/var\s+src\s*=\s*["']([^"']+)["']/);
    if (srcMatch && srcMatch[1]) videoUrl = cleanVideoUrl(srcMatch[1], false);

    const directSrcMatch = html.match(/var\s+directSrc\s*=\s*["']([^"']+)["']/);
    if (directSrcMatch && directSrcMatch[1]) directVideoUrl = cleanVideoUrl(directSrcMatch[1]);

    let finalVideoUrl = videoUrl || directVideoUrl;
    
    // FIX: If var src starts with /, prepend rozgarlelo.modiplay.xyz domain correctly
    if (finalVideoUrl.startsWith('/')) {
      finalVideoUrl = `${MODIPLAY_API}${finalVideoUrl}`;
    }

    if (!finalVideoUrl) throw new Error("Modiplay: Stream target missing");

    const proxyRes = await findWorkingProxyVariant(finalVideoUrl, {}, PROXY_BASE, logger);
    const streamObj = {
      url: finalVideoUrl,
      urlWithHeaders: proxyRes.proxy_url,
      headers: proxyRes.headers,
      proxy_url: proxyRes.proxy_url,
      resolution: "auto",
      language: "Original"
    };

    return {
      success: true, source: "modiplay", topTwo: [streamObj], player1: streamObj,
      videoUrl: finalVideoUrl, urlWithHeaders: proxyRes.proxy_url, debugLogs: logger.getLogs()
    };
  } catch (error) {
    logger.log("MODIPLAY_FATAL_ERROR", error.message);
    return { success: false, source: "modiplay", error: error.message, debugLogs: logger.getLogs() };
  }
}

// ============================================================
// MOVIEBOX API
// ============================================================

async function fetchMovieBoxBearerToken(logger) {
  const now = Date.now();
  if (movieBoxTokenCache.token && now < movieBoxTokenCache.expiresAt) return movieBoxTokenCache.token;
  const res = await fetchUrl(`${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/app/get-latest-app-pkgs?app_name=moviebox`, { userAgent: DEFAULT_UA });
  const xUser = JSON.parse(res.headers["x-user"] || "{}");
  if (xUser.token) {
    movieBoxTokenCache = { token: xUser.token, expiresAt: now + 3600 * 1000 * 3 };
    return xUser.token;
  }
  throw new Error("MovieBox: Bearer token parsing failed");
}

async function extractMovieBox(title, mediaType = "movie", season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  try {
    const token = await fetchMovieBoxBearerToken(logger);
    const subjectType = mediaType === "tv" ? 2 : 1;
    const baseHeaders = { "Authorization": `Bearer ${token}`, "User-Agent": DEFAULT_UA };

    const searchRes = await fetchUrl(`${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/search`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: { keyword: title, page: 1, perPage: 12, subjectType }
    });

    const items = unwrapData(JSON.parse(searchRes.data))?.items || [];
    if (!items.length) throw new Error("MovieBox: No search results");

    const subjectId = String(items[0].subjectId || items[0].id);
    const detailPath = items[0].detailPath || "";

    const params = new URLSearchParams({ subjectId });
    if (mediaType === "tv") {
      params.append("se", String(season ?? 1));
      params.append("ep", String(episode ?? 1));
    }
    if (detailPath) params.append("detailPath", detailPath);

    const playRes = await fetchUrl(`${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/play?${params.toString()}`, {
      headers: { ...baseHeaders, "Referer": "https://movieboxonline.net/" }
    });

    const playData = unwrapData(JSON.parse(playRes.data || "{}"));
    const streams = playData.streams || playData.dash || [];
    if (!streams.length) throw new Error("MovieBox: Streams unavailable");

    const primary = streams[0];
    const streamUrl = cleanVideoUrl(primary.url);

    return {
      success: true, source: "moviebox", topTwo: [primary], player1: primary,
      videoUrl: streamUrl, urlWithHeaders: streamUrl, subtitles: playData.captions || [],
      debugLogs: logger.getLogs()
    };
  } catch (error) {
    logger.log("MOVIEBOX_FATAL_ERROR", error.message);
    return { success: false, source: "moviebox", error: error.message, debugLogs: logger.getLogs() };
  }
}

// ============================================================
// MAIN HANDLER
// ============================================================

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { id, title, type = "tv", s, e, tmdb_id, imdb_id, year, source = "all", debug } = req.query;
    const isDebug = debug === "true" || debug === "1";

    if (!id && !title && !tmdb_id && !imdb_id) {
      return res.status(400).json({ success: false, error: "Missing required parameter: 'id', 'title', 'tmdb_id', or 'imdb_id'" });
    }

    const mediaType = type.toLowerCase() === "movie" ? "movie" : "tv";
    const season = mediaType === "tv" ? (s ? parseInt(s, 10) : 1) : null;
    const episode = mediaType === "tv" ? (e ? parseInt(e, 10) : 1) : null;

    const fetchTasks = [];

    // Prioritize ReelsDownload / CinemaOS Extractor API if requested or in 'all'
    if (source === "all" || source === "reelsdownload" || source === "cinemaos") {
      fetchTasks.push(extractReelsDownload(title || "", mediaType, tmdb_id || id || "", imdb_id || "", year || "", season, episode, isDebug));
    }
    if ((source === "all" || source === "moviebox") && title) {
      fetchTasks.push(extractMovieBox(title, mediaType, season, episode, isDebug));
    }
    if ((source === "all" || source === "castle") && title) {
      fetchTasks.push(extractCastle(title, season, episode, isDebug));
    }
    if ((source === "all" || source === "modiplay") && (id || tmdb_id)) {
      fetchTasks.push(extractModiplay(tmdb_id || id, mediaType, season, episode, isDebug));
    }

    const results = await Promise.all(fetchTasks);
    const successes = results.filter((r) => r.success);
    const successfulResult = successes[0];

    if (successfulResult) {
      return res.status(200).json({
        success: true,
        source: successfulResult.source,
        sideBySide: { player1: successfulResult.player1, player2: successfulResult.player2 },
        topTwoResults: successfulResult.topTwo || [],
        videoUrl: successfulResult.videoUrl,
        urlWithHeaders: successfulResult.urlWithHeaders || null,
        headers: successfulResult.headers || null,
        quality: successfulResult.quality || "auto",
        qualities: successfulResult.qualities || [],
        audioTracks: successfulResult.audioTracks || [],
        subtitles: successfulResult.subtitles || [],
        sources: successes.map((r) => ({
          source: r.source,
          videoUrl: r.videoUrl,
          urlWithHeaders: r.urlWithHeaders || null,
          audioTracks: r.audioTracks || [],
        })),
        allResults: results,
      });
    }

    return res.status(200).json({
      success: false,
      error: "All requested video sources failed",
      allResults: results,
    });

  } catch (error) {
    console.error("[HANDLER ERROR]", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server extraction failure" });
  }
};
