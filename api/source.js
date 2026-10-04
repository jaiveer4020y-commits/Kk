/**
 * Triple Video Source API - Castle + Modiplay + MovieBox
 * Fixed: GZIP decompression in fetchUrl & Castle empty stream handling
 * Feature: Side-by-Side Dual Stream Extraction with Hindi Prioritization
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');
const crypto = require('crypto');

// ============================================================
// CONFIGURATION
// ============================================================

const CASTLE_API = "https://api.hlowb.com";
const MODIPLAY_API = "https://rozgarlelo.modiplay.xyz";
const MOVIEBOX_BASE_URL = "https://h5-api.aoneroom.com";
const MOVIEBOX_H5_WEB = "https://h5.aoneroom.com";

const CASTLE_CONFIG = {
  channel: "IndiaA",
  clientType: "1",
  lang: "en-US",
  packageName: "com.external.castle",
  key: process.env.CASTLE_KEY || "814238e2175a1334641887e21235338a",
};

const DEFAULT_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

let movieBoxTokenCache = { token: null, expiresAt: 0 };

// ============================================================
// UTILITIES & LOGGER
// ============================================================

function cleanVideoUrl(url) {
  if (!url) return "";
  let cleaned = String(url)
    .replaceAll('\\/', '/')
    .replaceAll('\\', '');
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch (e) {}
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
          } catch (e) {
            // Fall back to raw buffer if decompression fails
          }

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

/**
 * Pick one best (highest resolution) stream PER LANGUAGE so Original + Hindi
 * come back together. Order: Original first, then Hindi, then the rest.
 */
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
  const url = `${CASTLE_API}/v0.1/system/getSecurityKey/1?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}`;
  logger.log("CASTLE_KEY_REQ", "Fetching Castle security key", { url });

  const response = await fetchUrl(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const data = JSON.parse(response.data);
  const securityKey = data.data;

  if (!securityKey) {
    throw new Error("Castle security key not found");
  }
  logger.log("CASTLE_KEY_RES", "Security key obtained successfully");
  return securityKey;
}

async function castleRequest(url, securityKey, logger, options = {}) {
  const response = await fetchUrl(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": "okhttp/4.9.3",
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      ...(options.method === "POST" && { "Content-Type": "application/json" }),
    },
    body: options.body,
  });

  let cipherText = response.data;
  try {
    const temp = JSON.parse(response.data);
    if (temp.data && typeof temp.data === 'string') {
      cipherText = temp.data;
    }
  } catch (e) {}

  const decrypted = decrypt_castle(cipherText, securityKey);
  let result = JSON.parse(decrypted);

  if (result.data && typeof result.data === 'object') {
    return result.data;
  }

  return result;
}

async function castleSearch(keyword, securityKey, logger) {
  const encoded = encodeURIComponent(keyword);
  const url = `${CASTLE_API}/film-api/v1.1.0/movie/searchByKeyword?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&keyword=${encoded}&lang=${CASTLE_CONFIG.lang}&mode=1&packageName=${CASTLE_CONFIG.packageName}&page=1&size=30`;
  logger.log("CASTLE_SEARCH_REQ", "Searching Castle for keyword", { keyword, url });

  const data = await castleRequest(url, securityKey, logger);
  const rows = data.rows || [];
  logger.log("CASTLE_SEARCH_RES", `Search returned ${rows.length} results`);

  if (!rows.length) {
    throw new Error("Castle: No search results");
  }

  let movieId = "";
  for (const row of rows) {
    const rowTitle = row.title || row.name || "";
    if (keyword.toLowerCase().includes(rowTitle.toLowerCase()) || rowTitle.toLowerCase().includes(keyword.toLowerCase())) {
      movieId = String(row.id || row.redirectId || row.redirectIdStr || "");
      if (movieId) break;
    }
  }

  if (!movieId && rows.length > 0) {
    const first = rows[0];
    movieId = String(first.id || first.redirectId || first.redirectIdStr || "");
  }

  if (!movieId) {
    throw new Error("Castle: Movie ID not found");
  }

  logger.log("CASTLE_SEARCH_MATCH", `Selected Movie ID: ${movieId}`);
  return movieId;
}

async function castleGetDetails(movieId, securityKey, logger) {
  const url = `${CASTLE_API}/film-api/v1.9.9/movie?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}&movieId=${movieId}&packageName=${CASTLE_CONFIG.packageName}`;
  logger.log("CASTLE_DETAIL_REQ", `Fetching details v1.9.9`, { url });
  return await castleRequest(url, securityKey, logger);
}

async function castleGetVideo(movieId, episodeId, securityKey, logger) {
  const url = `${CASTLE_API}/film-api/v2.0.1/movie/getVideo2?clientType=${CASTLE_CONFIG.clientType}&packageName=${CASTLE_CONFIG.packageName}&channel=${CASTLE_CONFIG.channel}&lang=${CASTLE_CONFIG.lang}`;

  const body = {
    mode: "1",
    appMarket: "GuanWang",
    clientType: CASTLE_CONFIG.clientType,
    woolUser: "false",
    apkSignKey: CASTLE_CONFIG.key,
    androidVersion: "13",
    movieId: String(movieId),
    episodeId: String(episodeId),
    isNewUser: "true",
    resolution: "2",
    packageName: CASTLE_CONFIG.packageName,
  };

  logger.log("CASTLE_GETVIDEO_REQ", `Requesting video payload [movieId: ${movieId}, episodeId: ${episodeId}]`);
  return await castleRequest(url, securityKey, logger, { method: "POST", body });
}

async function extractCastle(title, season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  try {
    const securityKey = await getCastleSecurityKey(logger);
    let movieId = await castleSearch(title, securityKey, logger);
    let details = await castleGetDetails(movieId, securityKey, logger);
    let effectiveMovieId = movieId;

    if (season !== null && episode !== null) {
      const seasons = details.seasons || details.seasonList || details.seasonsList || [];
      let seasonData = null;

      if (seasons.length > 0) {
        seasonData = seasons.find(s => {
          const sNum = s.number ?? s.seasonIndex ?? s.season ?? s.seasonNumber;
          if (sNum !== undefined && Number(sNum) === Number(season)) return true;
          const sName = String(s.name || s.title || "").toLowerCase();
          return sName.includes(`season ${season}`) || sName === `s${season}`;
        });
      }

      if (seasonData && (seasonData.movieId || seasonData.id)) {
        const seasonMovieId = String(seasonData.movieId || seasonData.id);
        if (seasonMovieId !== String(movieId)) {
          logger.log("CASTLE_SEASON_SWITCH", `Switching to season ${season} movieId: ${seasonMovieId}`);
          details = await castleGetDetails(seasonMovieId, securityKey, logger);
          effectiveMovieId = seasonMovieId;
        }
      } else {
        const seasonQuery = `${title} Season ${season}`;
        logger.log("CASTLE_SEASON_FALLBACK", `Searching specific season keyword: ${seasonQuery}`);
        try {
          const fallbackMovieId = await castleSearch(seasonQuery, securityKey, logger);
          if (fallbackMovieId) {
            details = await castleGetDetails(fallbackMovieId, securityKey, logger);
            effectiveMovieId = fallbackMovieId;
          }
        } catch (e) {
          logger.log("CASTLE_SEASON_FALLBACK_ERR", e.message);
        }
      }
    }

    const episodes = details.episodes || details.episodeList || [];
    if (!episodes.length && season === null) {
      episodes.push({ id: effectiveMovieId, number: 1 });
    }

    if (!episodes.length) {
      throw new Error(`Castle: Season ${season} is not available`);
    }

    let episodeData = null;
    if (season !== null && episode !== null) {
      episodeData = episodes.find(ep => {
        const epNum = ep.number ?? ep.episodeIndex ?? ep.episode ?? ep.sort;
        return epNum !== undefined && Number(epNum) === Number(episode);
      });
    }

    if (!episodeData) {
      episodeData = episodes[Number(episode) - 1] || episodes[0];
    }

    const episodeId = episodeData.id || episodeData.episodeId || effectiveMovieId;
    logger.log("CASTLE_EPISODE_MATCHED", `Episode resolved ID: ${episodeId}`);

    const videoData = await castleGetVideo(effectiveMovieId, episodeId, securityKey, logger);
    const videoUrl = cleanVideoUrl(videoData.videoUrl || videoData.url || videoData.playUrl || "");

    if (!videoUrl) {
      throw new Error(`Castle: Season ${season} Episode ${episode} is unmapped or unavailable`);
    }

    const streamObj = {
      url: videoUrl,
      urlWithHeaders: videoUrl,
      headers: {},
      resolution: "auto",
      language: "Original"
    };

    return {
      success: true,
      source: "castle",
      topTwo: [streamObj],
      player1: streamObj,
      player2: null,
      videoUrl: videoUrl,
      subtitles: videoData.subtitles || [],
      quality: "auto",
      debugLogs: logger.getLogs(),
    };
  } catch (error) {
    logger.log("CASTLE_FATAL_ERROR", error.message);
    return {
      success: false,
      source: "castle",
      error: error.message,
      debugLogs: logger.getLogs(),
    };
  }
}

// ============================================================
// MODIPLAY API
// ============================================================

async function extractModiplay(mediaId, mediaType = "tv", season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  try {
    let embedUrl = (mediaType === "tv" && season && episode)
      ? `${MODIPLAY_API}/embed/tmdb/tv?id=${mediaId}&s=${season}&e=${episode}`
      : `${MODIPLAY_API}/embed/tmdb/${mediaType}?id=${mediaId}`;

    logger.log("MODIPLAY_EMBED_REQ", "Fetching embed page", { embedUrl });

    const embedResponse = await fetchUrl(embedUrl, {
      userAgent: DEFAULT_UA,
      headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });

    let playerUrl = "";
    const iframeMatch = embedResponse.data.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (iframeMatch) {
      playerUrl = decodeHtmlEntities(iframeMatch[1].trim());
    }

    if (!playerUrl) throw new Error("Modiplay: Player iframe source missing");

    if (playerUrl.startsWith('/')) {
      const urlObj = new URL(embedUrl);
      playerUrl = `${urlObj.protocol}//${urlObj.host}${playerUrl}`;
    }

    logger.log("MODIPLAY_PLAYER_REQ", "Fetching player script", { playerUrl });

    const playerResponse = await fetchUrl(playerUrl, {
      userAgent: DEFAULT_UA,
      headers: { "Referer": embedUrl, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8" },
    });

    let html = playerResponse.data;
    let videoUrl = "";

    const regexList = [
      /var\s+directSrc\s*=\s*["']([^"']+)["']/,
      /var\s+src\s*=\s*["']([^"']+)["']/,
      /file\s*:\s*["']([^"']+)["']/,
      /source\s*:\s*["']([^"']+)["']/,
      /["']file["']\s*:\s*["']([^"']+)["']/,
      /src\s*:\s*["'](https?:\/\/[^"']+)["']/
    ];

    for (let idx = 0; idx < regexList.length; idx++) {
      const match = html.match(regexList[idx]);
      if (match && match[1]) {
        videoUrl = cleanVideoUrl(match[1]);
        break;
      }
    }

    if (!videoUrl) throw new Error("Modiplay: Stream target missing");

    const streamObj = {
      url: videoUrl,
      urlWithHeaders: videoUrl,
      headers: {},
      resolution: "auto",
      language: "Original"
    };

    return {
      success: true,
      source: "modiplay",
      topTwo: [streamObj],
      player1: streamObj,
      player2: null,
      videoUrl: videoUrl,
      quality: "auto",
      debugLogs: logger.getLogs(),
    };
  } catch (error) {
    logger.log("MODIPLAY_FATAL_ERROR", error.message);
    return {
      success: false,
      source: "modiplay",
      error: error.message,
      debugLogs: logger.getLogs(),
    };
  }
}

// ============================================================
// MOVIEBOX API
// ============================================================

async function fetchMovieBoxBearerToken(logger, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && movieBoxTokenCache.token && now < movieBoxTokenCache.expiresAt) {
    return movieBoxTokenCache.token;
  }

  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/app/get-latest-app-pkgs?app_name=moviebox`;
  logger.log("MOVIEBOX_TOKEN_REQ", "Fetching new bearer token", { url });

  const response = await fetchUrl(url, { userAgent: DEFAULT_UA, timeout: 8000 });
  const xUserHeader = response.headers["x-user"];
  if (!xUserHeader) throw new Error("MovieBox: x-user header missing");

  const parsed = JSON.parse(xUserHeader);
  if (parsed && parsed.token) {
    movieBoxTokenCache = { token: parsed.token, expiresAt: now + 3600 * 1000 * 3 };
    logger.log("MOVIEBOX_TOKEN_SUCCESS", "Bearer token obtained");
    return parsed.token;
  }

  throw new Error("MovieBox: Bearer token parsing failed");
}

async function getMovieBoxDetailPath(subjectId, defaultPath = "", logger) {
  if (defaultPath && defaultPath.trim()) return defaultPath;
  const url = `${MOVIEBOX_H5_WEB}/wefeed-h5-bff/web/post/list/subject?id=${subjectId}`;
  try {
    const res = await fetchUrl(url, { timeout: 8000 });
    const parsed = JSON.parse(res.data || "{}");
    const items = parsed.data?.items || [];
    if (items.length > 0) {
      return items[0]?.subject?.detailPath || "";
    }
  } catch (e) {
    logger.log("MOVIEBOX_DETAIL_PATH_ERR", e.message);
  }
  return "";
}

async function getMovieBoxSubjectDetail(subjectId, token, logger) {
  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/${subjectId}/detail`;
  try {
    const res = await fetchUrl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": DEFAULT_UA,
        "Referer": MOVIEBOX_BASE_URL,
      },
      body: {},
      timeout: 10000,
    });
    const parsed = JSON.parse(res.data || "{}");
    return parsed.data || {};
  } catch (e) {
    logger.log("MOVIEBOX_TREE_DETAIL_ERR", e.message);
  }
  return {};
}

async function fetchMovieBoxEpisodePlay(episodeId, languageId, token, logger, resolution = 1080) {
  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/episode/${episodeId}/play`;
  try {
    const res = await fetchUrl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": DEFAULT_UA,
        "Referer": MOVIEBOX_BASE_URL,
      },
      body: {
        episodeId,
        languageId: languageId || "",
        resolution,
        quality: "high",
      },
      timeout: 10000,
    });
    const parsed = JSON.parse(res.data || "{}");
    return parsed.data?.sources || [];
  } catch (e) {
    logger.log("MOVIEBOX_EPISODE_PLAY_ERR", e.message);
  }
  return [];
}

// ------------------------------------------------------------
// MovieBox: CloudStream logic (one subject per dub) + region/rate-limit fallbacks
// ------------------------------------------------------------

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Same as the CloudStream provider: strips " S1-S5" / " S2" suffixes
const SEASON_SUFFIX_REGEX = /\sS\d+(?:-S?\d+)*$/i;

// Request identities tried in order for /subject/play and /subject/download.
// "invalid region" / empty replies on one identity -> fall through to the next.
const MOVIEBOX_PROFILES = [
  {
    name: "123movies",
    base: MOVIEBOX_BASE_URL,
    origin: "https://123moviesfree.club",
    referer: (dp, id) => `https://123moviesfree.club/movies/${dp}?id=${id}&type=/movie/detail`,
  },
  {
    name: "fmovies",
    base: MOVIEBOX_BASE_URL,
    origin: "https://fmoviesunblocked.net",
    referer: (dp, id) => `https://fmoviesunblocked.net/spa/videoPlayPage/movies/${dp}?id=${id}&type=/movie/detail`,
  },
  {
    // download only works through the site proxy on some IPs
    name: "movieboxonline-proxy",
    base: "https://movieboxonline.net",
    origin: "https://movieboxonline.net",
    referer: (dp) => `https://movieboxonline.net/play/${dp}`,
  },
];

// /subject/play is rate limited (~1 good call per IP every couple of minutes),
// so remember good results for a while.
const MOVIEBOX_CACHE_TTL_MS = 10 * 60 * 1000;
const movieBoxResultCache = new Map();

function normalizeLanguage(name) {
  let n = String(name || "").replace(/\s*(dub|dubbed|audio)\s*$/i, "").trim();
  if (!n) return "Original";
  if (n.toLowerCase() === "original") return "Original";
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function findDubs(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return [];
  if (Array.isArray(obj.dubs)) return obj.dubs;
  for (const k of Object.keys(obj)) {
    const r = findDubs(obj[k], depth + 1);
    if (r.length) return r;
  }
  return [];
}

// Fetch one endpoint trying each identity until it returns something playable
async function fetchMovieBoxEndpoint(kind, subjectId, detailPath, season, episode, baseHeaders, logger, label) {
  const params = new URLSearchParams({ subjectId });
  if (season !== null) {
    params.append("se", String(season));
    params.append("ep", String(episode ?? 1));
  }
  if (detailPath) params.append("detailPath", detailPath);

  const listKeys = kind === "download" ? ["downloads"] : ["streams", "dash"];

  for (const profile of MOVIEBOX_PROFILES) {
    const referer = profile.referer(detailPath, subjectId);
    try {
      const r = await fetchUrl(`${profile.base}/wefeed-h5api-bff/subject/${kind}?${params.toString()}`, {
        headers: { ...baseHeaders, "Referer": referer, "Origin": profile.origin },
        timeout: 12000,
      });
      const data = unwrapData(JSON.parse(r.data || "{}"));
      const hasItems = listKeys.some(k => Array.isArray(data[k]) && data[k].some(x => x && x.url && !x.vipLocked));
      if (hasItems) {
        logger.log("MOVIEBOX_ENDPOINT_OK", `${label} ${kind} via ${profile.name}`);
        return { data, referer, origin: profile.origin };
      }
      logger.log("MOVIEBOX_ENDPOINT_EMPTY", `${label} ${kind} via ${profile.name}: no playable items`);
    } catch (e) {
      logger.log("MOVIEBOX_ENDPOINT_ERR", `${label} ${kind} via ${profile.name}: ${e.message}`);
    }
  }
  return { data: {}, referer: null, origin: null };
}

async function extractMovieBox(title, mediaType = "movie", season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  const isTv = mediaType === "tv";
  const cacheKey = `${String(title).toLowerCase()}|${isTv ? `${season}x${episode}` : "movie"}`;

  const cached = movieBoxResultCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    logger.log("MOVIEBOX_CACHE_HIT", cacheKey);
    return { ...cached.value, cached: true, debugLogs: logger.getLogs() };
  }

  try {
    const token = await fetchMovieBoxBearerToken(logger);
    const subjectType = isTv ? 2 : 1;
    const effSeason = isTv ? (season ?? 1) : null;
    const effEpisode = isTv ? (episode ?? 1) : null;

    const baseHeaders = {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.5",
      "User-Agent": DEFAULT_UA,
      "X-Client-Info": JSON.stringify({ timezone: "Africa/Nairobi" }),
    };

    // ---- 1. Search: plain title + "<title> Hindi" so the dub subject shows up
    const searchOnce = async (keyword) => {
      try {
        const r = await fetchUrl(`${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/search`, {
          method: "POST",
          headers: { ...baseHeaders, "Content-Type": "application/json", "Referer": MOVIEBOX_BASE_URL },
          body: { keyword, page: 1, perPage: 24, subjectType },
        });
        return unwrapData(JSON.parse(r.data))?.items || [];
      } catch (e) {
        logger.log("MOVIEBOX_SEARCH_ERR", `${keyword}: ${e.message}`);
        return [];
      }
    };

    logger.log("MOVIEBOX_SEARCH_REQ", "Searching MovieBox", { title, subjectType });
    const [plain, hindi] = await Promise.all([searchOnce(title), searchOnce(`${title} Hindi`)]);

    const seen = new Set();
    const items = [];
    for (const it of [...plain, ...hindi]) {
      const id = String(it.subjectId || it.id || "");
      if (id && !seen.has(id)) { seen.add(id); items.push(it); }
    }
    logger.log("MOVIEBOX_SEARCH_RES", `Found ${items.length} subjects (${plain.length} + ${hindi.length})`);
    if (!items.length) throw new Error("MovieBox: Search returned 0 results");

    // ---- 2. Exact "Title" / "Title [Lang]" matches => language groups
    const titleMatchRegex = new RegExp(`^${escapeRegex(title)}(?:\\s+\\[([^\\]]+)\\])?$`, "i");
    const groups = new Map(); // language -> [{subjectId, detailPath, rawTitle}]
    const addToGroup = (language, entry) => {
      const lang = normalizeLanguage(language);
      if (!groups.has(lang)) groups.set(lang, []);
      const list = groups.get(lang);
      if (!list.find(x => x.subjectId === entry.subjectId)) list.push(entry);
    };

    for (const item of items) {
      const id = String(item.subjectId || item.id || "");
      const cleanTitle = String(item.title || "").replace(SEASON_SUFFIX_REGEX, "").trim();
      const m = cleanTitle.match(titleMatchRegex);
      if (!m) continue;
      addToGroup(m[1] || "Original", { subjectId: id, detailPath: item.detailPath || "", rawTitle: item.title || "" });
    }

    // loose fallback so odd titles still work
    if (!groups.size) {
      const target = cleanTitleString(title);
      for (const item of items) {
        const id = String(item.subjectId || item.id || "");
        const c = cleanTitleString(item.title || "");
        if (c === target || c.includes(target) || target.includes(c)) {
          addToGroup(extractLanguageTag(item.title || ""), { subjectId: id, detailPath: item.detailPath || "", rawTitle: item.title || "" });
        }
      }
    }
    if (!groups.size) {
      const first = items[0];
      addToGroup(extractLanguageTag(first.title || ""), {
        subjectId: String(first.subjectId || first.id), detailPath: first.detailPath || "", rawTitle: first.title || "",
      });
    }

    // ---- 3. Dub discovery from the detail "dubs" array (adds Hindi etc. if search missed it)
    try {
      const anchor = (groups.get("Original") || [...groups.values()][0])[0];
      const anchorPath = await getMovieBoxDetailPath(anchor.subjectId, anchor.detailPath, logger);
      if (anchorPath) {
        const dr = await fetchUrl(`${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(anchorPath)}`, {
          headers: { ...baseHeaders, "Referer": MOVIEBOX_BASE_URL }, timeout: 10000,
        });
        const dubs = findDubs(JSON.parse(dr.data || "{}"));
        logger.log("MOVIEBOX_DUBS", `Detail returned ${dubs.length} dub/sub entries`,
          dubs.map(d => ({ lanName: d.lanName, kind: d.kind, original: d.original, subjectId: d.subjectId })));
        for (const d of dubs) {
          if (!d || !d.subjectId) continue;
          if (d.kind === "subtitle" || d.type === 1) continue;
          addToGroup(d.original ? "Original" : (d.lanName || "Unknown"), {
            subjectId: String(d.subjectId), detailPath: d.detailPath || "", rawTitle: `${title} [${d.lanName || ""}]`,
          });
        }
      }
    } catch (e) {
      logger.log("MOVIEBOX_DUBS_ERR", e.message);
    }

    logger.log("MOVIEBOX_GROUPS", `Languages: ${[...groups.keys()].join(", ")}`,
      [...groups.entries()].map(([l, v]) => ({ language: l, subjects: v.map(x => x.subjectId) })));

    const subtitles = [];
    const subtitleSeen = new Set();
    const addCaptions = (list) => {
      for (const c of (list || [])) {
        if (!c || !c.url || subtitleSeen.has(c.url)) continue;
        subtitleSeen.add(c.url);
        subtitles.push({ url: cleanVideoUrl(c.url), language: c.lanName || c.lan || c.language || "English" });
      }
    };

    // ---- 4. Every language in parallel; inside a language try candidate subjects until one yields streams
    const perLanguage = await Promise.all([...groups.entries()].map(async ([language, entries]) => {
      for (const entry of entries) {
        const out = [];
        try {
          const detailPath = await getMovieBoxDetailPath(entry.subjectId, entry.detailPath, logger);
          const label = `${language}[${entry.subjectId}]`;

          // BOTH endpoints at the same time (CloudStream logic)
          const [dl, pl] = await Promise.all([
            fetchMovieBoxEndpoint("download", entry.subjectId, detailPath, effSeason, effEpisode, baseHeaders, logger, label),
            fetchMovieBoxEndpoint("play", entry.subjectId, detailPath, effSeason, effEpisode, baseHeaders, logger, label),
          ]);

          const downloadData = dl.data;
          const playData = pl.data;
          const refererUsed = pl.referer || dl.referer || MOVIEBOX_PLAY_FALLBACK_REFERER(detailPath, entry.subjectId);
          const originUsed = pl.origin || dl.origin || "https://123moviesfree.club";
          const playbackHeaders = { "Referer": refererUsed, "Origin": originUsed, "User-Agent": DEFAULT_UA, "Accept": "*/*" };

          const addedQualities = new Set();
          const push = (s, resolution, kind) => {
            let finalUrl = cleanVideoUrl(s.url || s.videoUrl || s.playUrl || "");
            const signCookie = s.sign_cookie || s.signCookie;
            const cookieVal = cloudfrontCookie(signCookie);
            if ((!finalUrl || finalUrl.includes(".mpd")) && signCookie) {
              const manifest = dashManifestFromPolicy(signCookie);
              if (manifest) finalUrl = manifest;
            }
            if (!finalUrl || finalUrl.includes("macdn.aoneroom.com/other/")) return;

            const itemHeaders = { ...playbackHeaders };
            if (cookieVal) itemHeaders["Cookie"] = cookieVal;

            out.push({
              rawTitle: entry.rawTitle,
              subjectId: entry.subjectId,
              url: finalUrl,
              urlWithHeaders: buildPipeUrl(finalUrl, itemHeaders),
              headers: itemHeaders,
              resolution: kind === "dash" ? "auto" : String(resolution || "auto"),
              type: kind,
              language,
            });
          };

          // 1) downloads
          for (const d of (downloadData.downloads || [])) {
            if (!d || d.vipLocked || !d.url) continue;
            const resolution = parseInt(d.resolution, 10) || 0;
            addedQualities.add(resolution);
            push(d, resolution, "mp4");
          }
          // 2) play streams (skip resolutions already added)
          for (const s of (playData.streams || [])) {
            if (!s || s.vipLocked || !s.url) continue;
            const resolution = parseInt(s.resolutions, 10) || parseInt(s.resolution, 10) || 0;
            if (addedQualities.has(resolution)) continue;
            addedQualities.add(resolution);
            push(s, resolution, "mp4");
          }
          // 3) DASH
          for (const d of (playData.dash || [])) {
            if (!d || d.vipLocked || !d.url) continue;
            push(d, 0, "dash");
          }

          addCaptions(downloadData.captions);
          addCaptions(playData.captions);

          logger.log("MOVIEBOX_SUBJECT_RES", `${label}: ${out.length} streams`, {
            downloads: (downloadData.downloads || []).length,
            streams: (playData.streams || []).length,
            dash: (playData.dash || []).length,
          });

          if (out.length) return out;
        } catch (e) {
          logger.log("MOVIEBOX_SUBJECT_ERR", `${language}[${entry.subjectId}]: ${e.message}`);
        }
      }
      return [];
    }));

    const candidateStreams = perLanguage.flat();
    if (!candidateStreams.length) {
      throw new Error("MovieBox: Stream sources unavailable (invalid region / rate limited - see debug logs)");
    }

    // One best non-DASH stream per language (Original first, then Hindi)
    const playable = candidateStreams.filter(s => s.type !== "dash");
    const topTwoStreams = selectTopTwoStreams(playable.length ? playable : candidateStreams);
    const primaryStream = topTwoStreams[0] || candidateStreams[0];

    const audioTracks = [];
    for (const st of candidateStreams) {
      if (audioTracks.find(t => t.language === st.language)) continue;
      const best = topTwoStreams.find(t => t.language === st.language)
        || selectTopTwoStreams(candidateStreams.filter(x => x.language === st.language && x.type !== "dash"))[0]
        || st;
      audioTracks.push({
        language: st.language,
        label: st.language.substring(0, 3).toUpperCase(),
        subjectId: st.subjectId,
        url: best.url,
        urlWithHeaders: best.urlWithHeaders,
        headers: best.headers,
        resolution: best.resolution,
      });
    }

    const result = {
      success: true,
      source: "moviebox",
      topTwo: topTwoStreams,
      player1: topTwoStreams[0] || null,
      player2: topTwoStreams[1] || null,
      videoUrl: primaryStream.url,
      urlWithHeaders: primaryStream.urlWithHeaders,
      headers: primaryStream.headers,
      quality: String(primaryStream.resolution),
      qualities: candidateStreams,
      audioTracks,
      subtitles,
    };

    movieBoxResultCache.set(cacheKey, { expires: Date.now() + MOVIEBOX_CACHE_TTL_MS, value: result });
    return { ...result, debugLogs: logger.getLogs() };
  } catch (error) {
    logger.log("MOVIEBOX_FATAL_ERROR", error.message);
    return { success: false, source: "moviebox", error: error.message, debugLogs: logger.getLogs() };
  }
}

function MOVIEBOX_PLAY_FALLBACK_REFERER(detailPath, subjectId) {
  return `https://123moviesfree.club/movies/${detailPath}?id=${subjectId}&type=/movie/detail`;
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
    const { id, title, type = "tv", s, e, source = "all", debug } = req.query;
    const isDebug = debug === "true" || debug === "1";

    if (!id && !title) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: 'id' or 'title'",
      });
    }

    const mediaType = type.toLowerCase() === "movie" ? "movie" : "tv";
    // Movies must NOT carry season/episode (it flips MovieBox/Castle into TV mode)
    const season = mediaType === "tv" ? (s ? parseInt(s, 10) : 1) : null;
    const episode = mediaType === "tv" ? (e ? parseInt(e, 10) : 1) : null;

    const fetchTasks = [];

    if ((source === "all" || source === "moviebox") && title) {
      fetchTasks.push(extractMovieBox(title, mediaType, season, episode, isDebug));
    }

    if ((source === "all" || source === "castle") && title) {
      fetchTasks.push(extractCastle(title, season, episode, isDebug));
    }

    if ((source === "all" || source === "modiplay") && id) {
      fetchTasks.push(extractModiplay(id, mediaType, season, episode, isDebug));
    }

    const results = await Promise.all(fetchTasks);

    // Priority: MovieBox (multi-audio) > Castle > Modiplay
    const priority = { moviebox: 0, castle: 1, modiplay: 2 };
    const successes = results.filter((r) => r.success).sort((a, b) => (priority[a.source] ?? 9) - (priority[b.source] ?? 9));
    const successfulResult = successes[0];

    if (successfulResult) {
      const topTwo = successfulResult.topTwo || [];
      const player1 = successfulResult.player1 || topTwo[0] || null;
      const player2 = successfulResult.player2 || topTwo[1] || null;

      return res.status(200).json({
        success: true,
        source: successfulResult.source,
        sideBySide: { player1, player2 },
        topTwoResults: topTwo,
        videoUrl: successfulResult.videoUrl,
        urlWithHeaders: successfulResult.urlWithHeaders || null,
        headers: successfulResult.headers || null,
        quality: successfulResult.quality || "auto",
        qualities: successfulResult.qualities || [],
        audioTracks: successfulResult.audioTracks || [],
        subtitles: successfulResult.subtitles || [],
        // every working source, so the player can fall back
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
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server extraction failure",
    });
  }
};
