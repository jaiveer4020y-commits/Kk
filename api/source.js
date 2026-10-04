/**
 * Triple Video Source API - Castle + Modiplay + MovieBox
 * Endpoint: /api/source?title=Stranger+Things&id=66732&type=tv&s=1&e=1&source=all&debug=true
 */

console.log("API route /api/source module loaded");

const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

// ============================================================
// CONFIGURATION
// ============================================================

const CASTLE_API = "https://api.hlowb.com";
const MODIPLAY_API = "https://rozgarlelo.modiplay.xyz";
const MOVIEBOX_BASE_URL = "https://h5-api.aoneroom.com";

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
  } catch (e) {
    // Return sanitized string if decodeURIComponent fails
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
          ...options.headers,
        },
        timeout: options.timeout || 20000,
      };

      const req = protocol.request(url, requestOptions, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
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

function unpackJS(packedCode) {
  try {
    const match = packedCode.match(/}\s*\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*)'\s*\.split\('\Vert{}'\)/);
    if (!match) return packedCode;

    let [_, p, a, c, k] = match;
    a = parseInt(a, 10);
    c = parseInt(c, 10);
    k = k.split('|');

    const base36 = (num) => num.toString(36);

    while (c--) {
      if (k[c]) {
        p = p.replace(new RegExp('\\b' + base36(c) + '\\b', 'g'), k[c]);
      }
    }
    return p;
  } catch (e) {
    return packedCode;
  }
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
  for (let item of signCookie.split(';')) {
    item = item.trim();
    if (item.startsWith("CloudFront-Policy=")) {
      policyPart = item.split("=")[1].trim().replace(/^"|"$/g, '');
      break;
    }
  }
  if (!policyPart) return null;

  try {
    let stdB64 = policyPart.replace(/-/g, "+").replace(/~/g, "/").replace(/_/g, "=");
    stdB64 = stdB64.replace(/\s+/g, "").replace(/=+$/, "");
    stdB64 += "=".repeat((4 - (stdB64.length % 4)) % 4);

    const policyJson = JSON.parse(Buffer.from(stdB64, 'base64').toString('utf-8'));
    const statements = policyJson.Statement || [];
    if (!statements.length) return null;

    let resource = (statements[0].Resource || "").trim().replace(/\*$/, '').replace(/\/$/, '');
    if (!resource.startsWith("http")) return null;

    return resource.toLowerCase().endsWith(".mpd") ? resource : `${resource}/index.mpd`;
  } catch (e) {
    return null;
  }
}

// ============================================================
// CASTLE API
// ============================================================

function decryptCastle(cipherText, securityKey) {
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
  const response = await fetchUrl(url, { headers: { "Accept": "application/json" } });
  const data = JSON.parse(response.data);
  const securityKey = data?.data?.securityKey || data?.data?.key || data?.data;
  if (!securityKey) throw new Error("Castle security key response empty");
  logger.log("CASTLE_KEY_RES", "Security key obtained successfully");
  return securityKey;
}

async function castleRequest(url, securityKey, logger, options = {}) {
  const response = await fetchUrl(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": "okhttp/4.9.3",
      "Accept": "application/json",
      "securityKey": securityKey,
      "sec-key": securityKey,
      ...(options.headers || {}),
      ...(options.method === "POST" && { "Content-Type": "application/json" }),
    },
    body: options.body,
  });

  let cipherText = response.data;
  try {
    const temp = JSON.parse(response.data);
    if (temp.data && typeof temp.data === 'string') cipherText = temp.data;
    else if (temp.data && typeof temp.data === 'object') return temp.data;
  } catch (e) {}

  try {
    const decrypted = decryptCastle(cipherText, securityKey);
    let result = JSON.parse(decrypted);
    return (result.data && typeof result.data === 'object') ? result.data : result;
  } catch (e) {
    try {
      return JSON.parse(cipherText);
    } catch (err) {
      throw new Error(`Castle parse error: ${e.message}`);
    }
  }
}

async function castleSearch(title, securityKey, logger) {
  const encoded = encodeURIComponent(title);
  const url = `${CASTLE_API}/film-api/v1.1.0/movie/searchByKeyword?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&keyword=${encoded}&lang=${CASTLE_CONFIG.lang}&mode=1&packageName=${CASTLE_CONFIG.packageName}&page=1&size=30`;
  logger.log("CASTLE_SEARCH_REQ", "Searching Castle for keyword", { title, url });

  const data = await castleRequest(url, securityKey, logger);
  const rows = data.rows || data.list || [];
  logger.log("CASTLE_SEARCH_RES", `Search returned ${rows.length} results`);

  if (!rows.length) throw new Error("Castle: No search results found");

  let movieId = "";
  let matchedItem = null;

  for (const row of rows) {
    const rowTitle = row.title || row.name || "";
    if (title.toLowerCase().includes(rowTitle.toLowerCase()) || rowTitle.toLowerCase().includes(title.toLowerCase())) {
      movieId = String(row.id || row.movieId || row.redirectId || row.redirectIdStr || "");
      matchedItem = row;
      if (movieId) break;
    }
  }

  if (!movieId && rows.length > 0) {
    movieId = String(rows[0].id || rows[0].movieId || rows[0].redirectId || rows[0].redirectIdStr || "");
    matchedItem = rows[0];
  }

  if (!movieId) throw new Error("Castle: Movie ID resolution failed");
  logger.log("CASTLE_SEARCH_MATCH", `Selected Movie ID: ${movieId}`);
  return { movieId, matchedItem };
}

async function castleGetDetails(movieId, securityKey, logger, isTvShow = false, season = 1) {
  let url = `${CASTLE_API}/film-api/v1.1.0/movie/detail?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}&movieId=${movieId}&packageName=${CASTLE_CONFIG.packageName}`;
  if (isTvShow) {
    url = `${CASTLE_API}/film-api/v1.1.0/tv/getEpisodeList?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}&tvId=${movieId}&seasonIndex=${season}&packageName=${CASTLE_CONFIG.packageName}`;
  }
  logger.log("CASTLE_DETAIL_REQ", `Fetching details [isTvShow: ${isTvShow}]`, { url });
  return await castleRequest(url, securityKey, logger);
}

async function castleGetVideo(targetMovieId, episodeId, securityKey, resolution, languageId, logger) {
  const langId = languageId || 1003;

  try {
    const queryParams = new URLSearchParams({
      channel: CASTLE_CONFIG.channel,
      clientType: CASTLE_CONFIG.clientType,
      lang: CASTLE_CONFIG.lang,
      packageName: CASTLE_CONFIG.packageName,
      movieId: String(targetMovieId),
      episodeId: String(episodeId),
      resolution: String(resolution),
      languageId: String(langId)
    });

    const getUrl = `${CASTLE_API}/film-api/v1.1.0/movie/getVideo2?${queryParams.toString()}`;
    logger.log("CASTLE_GETVIDEO_REQ", `Executing GET getVideo2 [movieId: ${targetMovieId}, episodeId: ${episodeId}, res: ${resolution}]`);
    
    const resData = await castleRequest(getUrl, securityKey, logger);
    const videoUrl = resData?.url || resData?.videoUrl || resData?.playUrl || resData?.streamUrl;
    
    if (videoUrl) {
      return { ...resData, videoUrl };
    }
  } catch (e) {
    logger.log("CASTLE_GETVIDEO_GET_ERR", `GET getVideo2 failed: ${e.message}`);
  }

  const postUrl = `${CASTLE_API}/film-api/v2.0.1/movie/getVideo2?clientType=${CASTLE_CONFIG.clientType}&packageName=${CASTLE_CONFIG.packageName}&channel=${CASTLE_CONFIG.channel}&lang=${CASTLE_CONFIG.lang}`;
  
  const body = {
    mode: "1",
    appMarket: "GuanWang",
    clientType: CASTLE_CONFIG.clientType,
    woolUser: false,
    apkSignKey: CASTLE_CONFIG.key,
    androidVersion: "13",
    movieId: String(targetMovieId),
    episodeId: String(episodeId),
    languageId: Number(langId),
    isNewUser: true,
    resolution: Number(resolution) || 2,
    packageName: CASTLE_CONFIG.packageName,
  };

  logger.log("CASTLE_GETVIDEO_POST_REQ", `Executing POST getVideo2 [movieId: ${targetMovieId}, episodeId: ${episodeId}]`);
  return await castleRequest(postUrl, securityKey, logger, { method: "POST", body });
}

async function extractCastle(title, season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  try {
    const securityKey = await getCastleSecurityKey(logger);
    const { movieId: rootMovieId, matchedItem } = await castleSearch(title, securityKey, logger);
    
    const isTvShow = season !== null || matchedItem?.type === 2 || matchedItem?.type === "tv";
    let details = {};
    
    try {
      details = await castleGetDetails(rootMovieId, securityKey, logger, isTvShow, season || 1);
    } catch (e) {
      logger.log("CASTLE_DETAIL_WARN", `Primary detail fetch failed, falling back to movie detail: ${e.message}`);
      details = await castleGetDetails(rootMovieId, securityKey, logger, false, season || 1);
    }

    let effectiveMovieId = rootMovieId;

    if (isTvShow && season !== null) {
      const seasons = details.seasons || details.seasonList || details.seasonsList || [];
      logger.log("CASTLE_SEASONS_PARSE", `Found ${seasons.length} season entries in details payload`);
      
      if (seasons.length > 0) {
        const seasonData = seasons.find(s => {
          const sNum = s.number ?? s.seasonIndex ?? s.season ?? s.seasonNumber ?? s.sort;
          return Number(sNum) === Number(season);
        });

        if (seasonData && (seasonData.movieId || seasonData.id || seasonData.tvId)) {
          effectiveMovieId = String(seasonData.movieId || seasonData.id || seasonData.tvId);
          logger.log("CASTLE_SEASON_MATCH", `Season ${season} matched. Switch to season movieId: ${effectiveMovieId}`);
        }
      }
    }

    let episodes = details.episodes || details.episodeList || details.list || [];
    if (!episodes.length && details.seasons) {
      for (const s of details.seasons) {
        const sNum = s.number ?? s.seasonIndex ?? s.season ?? s.seasonNumber;
        if (Number(sNum) === Number(season) && (s.episodes || s.episodeList)) {
          episodes = s.episodes || s.episodeList;
          break;
        }
      }
    }

    let episodeData = null;
    if (episodes.length > 0) {
      if (season !== null && episode !== null) {
        episodeData = episodes.find(ep => {
          const epNum = ep.number ?? ep.episodeIndex ?? ep.episode ?? ep.sort;
          return Number(epNum) === Number(episode);
        });
      }
      if (!episodeData) episodeData = episodes[0];
    } else {
      // Fallback for movies / missing episode structures
      episodeData = { id: effectiveMovieId, movieId: effectiveMovieId };
    }

    const episodeId = String(episodeData.id || episodeData.episodeId || episodeData.movieId || effectiveMovieId);
    const defaultTrack = episodeData.tracks?.find(t => t.isDefault) || episodeData.tracks?.[0];
    const languageId = defaultTrack?.languageId || 1003;

    logger.log("CASTLE_EPISODE_MATCH", `Matched episode payload`, { episodeId, episodeData });

    let videoUrl = "";
    let videoData = {};

    const idCandidates = [
      effectiveMovieId,
      rootMovieId,
      episodeData.movieId,
      episodeData.id
    ].filter((v, i, a) => v && a.indexOf(String(v)) === i);

    const resCandidates = ["2", "1", "3", "auto"];

    for (const mid of idCandidates) {
      for (const resChoice of resCandidates) {
        try {
          videoData = await castleGetVideo(mid, episodeId, securityKey, resChoice, languageId, logger);
          videoUrl = videoData.videoUrl || videoData.url || videoData.playUrl || videoData.m3u8Url || videoData.streamUrl || "";
          
          if (!videoUrl && Array.isArray(videoData.list) && videoData.list.length > 0) {
            videoUrl = videoData.list[0].url || videoData.list[0].videoUrl || videoData.list[0].playUrl || "";
          }

          if (videoUrl) {
            videoUrl = cleanVideoUrl(videoUrl);
            logger.log("CASTLE_STREAM_SUCCESS", `Stream URL retrieved!`, { mid, resChoice, videoUrl });
            break;
          }
        } catch (e) {
          logger.log("CASTLE_ATTEMPT_FAILED", `Attempt [mid: ${mid}, res: ${resChoice}] failed: ${e.message}`);
        }
      }
      if (videoUrl) break;
    }

    if (!videoUrl) throw new Error("Castle: Stream URL unavailable across all fallback attempts");

    return {
      success: true,
      source: "castle",
      videoUrl: videoUrl,
      qualities: episodeData.videos || [],
      audioTracks: episodeData.tracks || [],
      subtitles: episodeData.subtitles || videoData.subtitles || [],
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

    logger.log("MODIPLAY_IFRAME_PARSE", `Player iframe target: ${playerUrl || "NOT_FOUND"}`);

    if (!playerUrl) throw new Error("Modiplay: Player iframe source missing");

    if (playerUrl.startsWith('/')) {
      const urlObj = new URL(embedUrl);
      playerUrl = `${urlObj.protocol}//${urlObj.host}${playerUrl}`;
    }

    logger.log("MODIPLAY_PLAYER_REQ", "Fetching player page script", { playerUrl });

    const playerResponse = await fetchUrl(playerUrl, {
      userAgent: DEFAULT_UA,
      headers: { "Referer": embedUrl, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8" },
    });

    let html = playerResponse.data;
    const isPacked = html.includes("eval(function(p,a,c,k,e,");
    logger.log("MODIPLAY_OBFUSCATION_CHECK", `Is packed JS: ${isPacked}`);

    if (isPacked) {
      html = unpackJS(html);
      logger.log("MODIPLAY_UNPACKED_JS", `Unpacked code size: ${html.length} chars`);
    }

    let videoUrl = "";

    const regexList = [
      /var\s+directSrc\s*=\s*["']([^"']+)["']/,
      /var\s+src\s*=\s*["']([^"']+)["']/,
      /file\s*:\s*["']([^"']+)["']/,
      /source\s*:\s*["']([^"']+)["']/,
      /["']file["']\s*:\s*["']([^"']+)["']/,
      /src\s*:\s*["'](https?:\/\/[^"']+)["']/,
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/
    ];

    for (let idx = 0; idx < regexList.length; idx++) {
      const match = html.match(regexList[idx]);
      if (match && match[1]) {
        videoUrl = cleanVideoUrl(match[1]);
        logger.log("MODIPLAY_REGEX_MATCH", `Matched pattern index ${idx}`, { videoUrl });
        break;
      }
    }

    if (!videoUrl) {
      const streamMatch = html.match(/(https?:\\\/\\\/[^\s"',]+\.(?:m3u8|mp4)[^\s"',]*|https?:\/\/[^\s"',]+\.(?:m3u8|mp4)[^\s"',]*)/i);
      if (streamMatch) {
        videoUrl = cleanVideoUrl(streamMatch[1]);
        logger.log("MODIPLAY_STREAM_SCAN_MATCH", `Direct m3u8/mp4 scan matched`, { videoUrl });
      }
    }

    if (!videoUrl) {
      const b64Match = html.match(/atob\(["']([A-Za-z0-9+/=]+)["']\)/);
      if (b64Match) {
        try {
          const decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8');
          if (decoded.startsWith('http')) {
            videoUrl = cleanVideoUrl(decoded);
            logger.log("MODIPLAY_B64_MATCH", "Decoded Base64 video URL", { videoUrl });
          }
        } catch (e) {}
      }
    }

    if (!videoUrl) throw new Error("Modiplay: Video source not found in unpacked player payload");

    if (videoUrl.startsWith('/')) {
      const urlObj = new URL(playerUrl);
      videoUrl = `${urlObj.protocol}//${urlObj.host}${videoUrl}`;
    }

    videoUrl = cleanVideoUrl(videoUrl);

    return {
      success: true,
      source: "modiplay",
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
    logger.log("MOVIEBOX_TOKEN_CACHE", "Using cached bearer token");
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

async function extractMovieBox(title, mediaType = "movie", season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  
  const DEFAULT_HEADERS = {
    "Referer": "https://fmoviesunblocked.net/",
    "Origin": "https://fmoviesunblocked.net",
    "User-Agent": DEFAULT_UA,
    "Accept": "*/*",
    "Accept-Encoding": "gzip",
  };

  try {
    const token = await fetchMovieBoxBearerToken(logger);
    const subjectType = (mediaType === "tv" || season !== null) ? 2 : 1;

    logger.log("MOVIEBOX_SEARCH_REQ", "Searching MovieBox for keyword", { title, subjectType });

    const searchRes = await fetchUrl(`${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Client-Info": JSON.stringify({ timezone: "Africa/Nairobi" }),
        "Referer": MOVIEBOX_BASE_URL,
      },
      body: {
        keyword: title,
        page: 1,
        perPage: 24,
        subjectType
      }
    });

    const searchObj = JSON.parse(searchRes.data);
    const items = unwrapData(searchObj)?.items || [];
    logger.log("MOVIEBOX_SEARCH_RES", `Found ${items.length} subjects`);

    if (!items.length) throw new Error("MovieBox: Search returned 0 results");

    const targetTitleClean = cleanTitleString(title);
    const matchedSubjects = [];

    // Collect ALL matching subjects (Original + Hindi / Dubbed versions)
    for (const item of items) {
      const rawTitle = item.title || "";
      const subjectId = item.subjectId;
      if (!subjectId) continue;

      const itemCleanTitle = cleanTitleString(rawTitle);
      if (itemCleanTitle === targetTitleClean || itemCleanTitle.includes(targetTitleClean)) {
        const language = extractLanguageTag(rawTitle);
        matchedSubjects.push({ subjectId: String(subjectId), language, rawTitle });
      }
    }

    if (!matchedSubjects.length) {
      // Fallback: Use the very first subject if exact title string match failed
      const firstItem = items[0];
      const rawTitle = firstItem.title || "";
      matchedSubjects.push({
        subjectId: String(firstItem.subjectId || firstItem.id),
        language: extractLanguageTag(rawTitle),
        rawTitle
      });
    }

    logger.log("MOVIEBOX_MATCHED_SUBJECTS", `Matched ${matchedSubjects.length} target subject entries`, matchedSubjects);

    const candidateStreams = [];
    const subtitles = [];
    const addedQualityKeys = new Set();

    // Direct Play & Download requests for ALL matched subjects (skips failing /detail endpoint)
    for (const target of matchedSubjects) {
      logger.log("MOVIEBOX_SUBJECT_FETCH", `Fetching streams for ${target.rawTitle} [ID: ${target.subjectId}]`);

      const params = new URLSearchParams({ subjectId: target.subjectId });
      if (season !== null) params.append("se", String(season));
      if (episode !== null) params.append("ep", String(episode));

      const reqHeaders = {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        ...DEFAULT_HEADERS
      };

      const playUrl = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/play?${params.toString()}`;
      const downloadUrl = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/download?${params.toString()}`;

      const [playRes, downloadRes] = await Promise.all([
        fetchUrl(playUrl, { headers: reqHeaders }).catch(e => ({ data: "{}" })),
        fetchUrl(downloadUrl, { headers: reqHeaders }).catch(e => ({ data: "{}" }))
      ]);

      const playObj = JSON.parse(playRes.data || "{}");
      const downloadObj = JSON.parse(downloadRes.data || "{}");

      const playData = unwrapData(playObj);
      const downloadData = unwrapData(downloadObj);

      // Process Downloads
      const downloads = downloadData.downloads || [];
      for (const d of downloads) {
        let finalUrl = cleanVideoUrl(d.url || d.videoUrl || "");
        if (finalUrl && !d.vipLocked) {
          const resVal = String(d.resolution || "480");
          const key = `${target.language}-${resVal}`;
          if (!addedQualityKeys.has(key)) {
            addedQualityKeys.add(key);
            candidateStreams.push({
              url: finalUrl,
              resolution: resVal,
              language: target.language
            });
          }
        }
      }

      // Process Streams & DASH
      const streams = [...(playData.streams || []), ...(playData.dash || [])];
      for (const s of streams) {
        if (s.vipLocked) continue;
        let finalUrl = cleanVideoUrl(s.url || s.videoUrl || "");
        const signCookie = s.sign_cookie || s.signCookie;

        if (!finalUrl && signCookie) {
          finalUrl = cleanVideoUrl(dashManifestFromPolicy(signCookie) || "");
        }

        if (finalUrl) {
          const resVal = String(s.resolutions || s.resolution || "auto");
          const key = `${target.language}-${resVal}`;
          if (!addedQualityKeys.has(key)) {
            addedQualityKeys.add(key);
            candidateStreams.push({
              url: finalUrl,
              resolution: resVal,
              language: target.language
            });
          }
        }
      }

      // Captions / Subtitles
      const captions = downloadData.captions || playData.captions || [];
      for (const c of captions) {
        if (c.url) {
          subtitles.push({
            url: cleanVideoUrl(c.url),
            language: c.lanName || c.lan || "English"
          });
        }
      }
    }

    if (!candidateStreams.length) throw new Error("MovieBox: Stream sources unavailable");

    const bestStream = candidateStreams[0];

    return {
      success: true,
      source: "moviebox",
      videoUrl: bestStream.url,
      urlWithHeaders: buildPipeUrl(bestStream.url, DEFAULT_HEADERS),
      headers: DEFAULT_HEADERS,
      quality: String(bestStream.resolution),
      qualities: candidateStreams,
      audioTracks: [{ language: "Default", label: "DEF" }],
      subtitles: subtitles,
      debugLogs: logger.getLogs(),
    };
  } catch (error) {
    logger.log("MOVIEBOX_FATAL_ERROR", error.message);
    return {
      success: false,
      source: "moviebox",
      error: error.message,
      debugLogs: logger.getLogs(),
    };
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
    const { id, title, type = "tv", s, e, source = "all", debug } = req.query;
    const isDebug = debug === "true" || debug === "1";

    if (!id && !title) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: 'id' or 'title'",
      });
    }

    const season = s ? parseInt(s, 10) : 1;
    const episode = e ? parseInt(e, 10) : 1;
    const mediaType = type.toLowerCase() === "movie" ? "movie" : "tv";

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
    const successfulResult = results.find((r) => r.success);

    if (successfulResult) {
      return res.status(200).json({
        success: true,
        source: successfulResult.source,
        videoUrl: successfulResult.videoUrl,
        urlWithHeaders: successfulResult.urlWithHeaders || null,
        headers: successfulResult.headers || null,
        quality: successfulResult.quality || "auto",
        qualities: successfulResult.qualities || [],
        audioTracks: successfulResult.audioTracks || [],
        subtitles: successfulResult.subtitles || [],
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
