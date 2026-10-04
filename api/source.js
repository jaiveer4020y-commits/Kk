/**
 * Triple Video Source API v2 - FIXED
 * - MovieBox: Collect ALL audio tracks (English + Hindi + All)
 * - Castle: Fixed search & video extraction
 * - Modiplay: Working as-is
 * 
 * Endpoint: /api/source?title=Stranger+Things&id=66732&type=tv&s=5&e=1&source=all&debug=true
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

/**
 * Build pipe-delimited URL with headers
 * Format: url|header1=value1&header2=value2
 */
function buildPipeUrl(url, headers = {}) {
  if (!url) return "";
  const cleanedUrl = cleanVideoUrl(url);
  
  const pairs = Object.entries(headers)
    .filter(([_, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k, v]) => {
      const val = String(v);
      return `${encodeURIComponent(k)}=${encodeURIComponent(val)}`;
    })
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
// CASTLE API - FIXED
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
  
  try {
    const response = await fetchUrl(url, { headers: { "Accept": "application/json" } });
    const data = JSON.parse(response.data);
    const securityKey = data?.data?.securityKey || data?.data?.key || data?.data;
    if (!securityKey) throw new Error("Castle security key response empty");
    logger.log("CASTLE_KEY_RES", "Security key obtained successfully");
    return securityKey;
  } catch (e) {
    logger.log("CASTLE_KEY_ERR", e.message);
    throw e;
  }
}

async function castleRequest(url, securityKey, logger, options = {}) {
  const response = await fetchUrl(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": "okhttp/4.9.3",
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "Keep-Alive",
      "securityKey": securityKey,
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
  logger.log("CASTLE_SEARCH_REQ", "Searching Castle for keyword", { title });

  try {
    const data = await castleRequest(url, securityKey, logger);
    const rows = data.rows || data.list || [];
    logger.log("CASTLE_SEARCH_RES", `Search returned ${rows.length} results`);

    if (!rows.length) throw new Error("Castle: No search results found");

    let movieId = "";
    for (const row of rows) {
      const rowTitle = row.title || row.name || "";
      if (title.toLowerCase().includes(rowTitle.toLowerCase()) || rowTitle.toLowerCase().includes(title.toLowerCase())) {
        movieId = String(row.id || row.movieId || row.redirectId || row.redirectIdStr || "");
        if (movieId) break;
      }
    }

    if (!movieId && rows.length > 0) {
      movieId = String(rows[0].id || rows[0].movieId || rows[0].redirectId || rows[0].redirectIdStr || "");
    }

    if (!movieId) throw new Error("Castle: Movie ID resolution failed");
    logger.log("CASTLE_SEARCH_MATCH", `Selected Movie ID: ${movieId}`);
    return movieId;
  } catch (e) {
    logger.log("CASTLE_SEARCH_ERR", e.message);
    throw e;
  }
}

async function castleGetDetails(movieId, securityKey, logger) {
  const url = `${CASTLE_API}/film-api/v1.1.0/movie/detail?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}&movieId=${movieId}&packageName=${CASTLE_CONFIG.packageName}`;
  logger.log("CASTLE_DETAIL_REQ", `Fetching details for movieId: ${movieId}`);
  
  try {
    return await castleRequest(url, securityKey, logger);
  } catch (e) {
    logger.log("CASTLE_DETAIL_ERR", e.message);
    throw e;
  }
}

async function castleGetVideo(targetMovieId, episodeId, securityKey, resolution, languageId, logger) {
  const langId = languageId || 1003;

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

  logger.log("CASTLE_GETVIDEO_REQ", `POST getVideo2 [movieId: ${targetMovieId}, episodeId: ${episodeId}]`);
  
  try {
    return await castleRequest(postUrl, securityKey, logger, { method: "POST", body });
  } catch (e) {
    logger.log("CASTLE_GETVIDEO_ERR", e.message);
    throw e;
  }
}

async function extractCastle(title, season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);
  try {
    const securityKey = await getCastleSecurityKey(logger);
    const rootMovieId = await castleSearch(title, securityKey, logger);
    let details = await castleGetDetails(rootMovieId, securityKey, logger);
    
    let effectiveMovieId = rootMovieId;

    if (season !== null && episode !== null) {
      const seasons = details.seasons || details.seasonList || details.seasonsList || [];
      logger.log("CASTLE_SEASONS_PARSE", `Found ${seasons.length} season entries`);
      
      if (seasons.length > 0) {
        const seasonData = seasons.find(s => {
          const sNum = s.number ?? s.seasonIndex ?? s.season ?? s.seasonNumber ?? s.sort;
          return Number(sNum) === Number(season);
        });

        if (seasonData && (seasonData.movieId || seasonData.id)) {
          effectiveMovieId = String(seasonData.movieId || seasonData.id);
          logger.log("CASTLE_SEASON_MATCH", `Season ${season} matched. Switch movieId: ${effectiveMovieId}`);
          try {
            details = await castleGetDetails(effectiveMovieId, securityKey, logger);
          } catch (e) {
            logger.log("CASTLE_SEASON_DETAIL_ERR", e.message);
          }
        }
      }
    }

    let episodes = details.episodes || details.episodeList || details.list || [];
    logger.log("CASTLE_EPISODES_PARSE", `Total episodes: ${episodes.length}`);
    
    if (!episodes.length) throw new Error("Castle: Season episode list empty");

    let episodeData = null;
    if (season !== null && episode !== null) {
      episodeData = episodes.find(ep => {
        const epNum = ep.number ?? ep.episodeIndex ?? ep.episode ?? ep.sort;
        return Number(epNum) === Number(episode);
      });
    }
    if (!episodeData) episodeData = episodes[0];
    if (!episodeData) throw new Error("Castle: Episode data missing");

    const episodeId = String(episodeData.id || episodeData.episodeId || episodeData.movieId);
    const defaultTrack = episodeData.tracks?.find(t => t.isDefault) || episodeData.tracks?.[0];
    const languageId = defaultTrack?.languageId || 1003;

    logger.log("CASTLE_EPISODE_MATCH", `Episode ID: ${episodeId}, Language ID: ${languageId}`);

    let videoUrl = "";
    let videoData = {};

    const idCandidates = [effectiveMovieId, rootMovieId].filter((v, i, a) => v && a.indexOf(String(v)) === i);
    const resCandidates = ["2", "1", "3"];

    for (const mid of idCandidates) {
      for (const resChoice of resCandidates) {
        try {
          videoData = await castleGetVideo(mid, episodeId, securityKey, resChoice, languageId, logger);
          videoUrl = videoData.videoUrl || videoData.url || videoData.playUrl || videoData.m3u8Url || videoData.streamUrl || "";
          
          if (!videoUrl && Array.isArray(videoData.list) && videoData.list.length > 0) {
            videoUrl = videoData.list[0].url || videoData.list[0].videoUrl || "";
          }

          if (videoUrl) {
            videoUrl = cleanVideoUrl(videoUrl);
            logger.log("CASTLE_STREAM_SUCCESS", `Stream URL found!`, { mid, resChoice });
            break;
          }
        } catch (e) {
          logger.log("CASTLE_ATTEMPT_FAILED", `Attempt [mid: ${mid}, res: ${resChoice}]: ${e.message}`);
        }
      }
      if (videoUrl) break;
    }

    if (!videoUrl) throw new Error("Castle: Stream URL unavailable");

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

    logger.log("MODIPLAY_IFRAME_PARSE", `Player iframe: ${playerUrl || "NOT_FOUND"}`);

    if (!playerUrl) throw new Error("Modiplay: Player iframe source missing");

    if (playerUrl.startsWith('/')) {
      const urlObj = new URL(embedUrl);
      playerUrl = `${urlObj.protocol}//${urlObj.host}${playerUrl}`;
    }

    logger.log("MODIPLAY_PLAYER_REQ", "Fetching player page");

    const playerResponse = await fetchUrl(playerUrl, {
      userAgent: DEFAULT_UA,
      headers: { "Referer": embedUrl },
    });

    let html = playerResponse.data;
    const isPacked = html.includes("eval(function(p,a,c,k,e,");
    
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
      /(https?:\/\/[^\s"',]+\.(?:m3u8|mp4)[^\s"',]*)/
    ];

    for (let idx = 0; idx < regexList.length; idx++) {
      const match = html.match(regexList[idx]);
      if (match && match[1]) {
        videoUrl = cleanVideoUrl(match[1]);
        logger.log("MODIPLAY_REGEX_MATCH", `Pattern index ${idx} matched`);
        break;
      }
    }

    if (!videoUrl) throw new Error("Modiplay: Video source not found");

    if (videoUrl.startsWith('/')) {
      const urlObj = new URL(playerUrl);
      videoUrl = `${urlObj.protocol}//${urlObj.host}${videoUrl}`;
    }

    return {
      success: true,
      source: "modiplay",
      videoUrl: videoUrl,
      quality: "auto",
      audioTracks: [{ language: "English (Default)", label: "eng" }],
      subtitles: [],
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
// MOVIEBOX API - FIXED (Collect ALL Audio Tracks)
// ============================================================

async function fetchMovieBoxBearerToken(logger, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && movieBoxTokenCache.token && now < movieBoxTokenCache.expiresAt) {
    logger.log("MOVIEBOX_TOKEN_CACHE", "Using cached token");
    return movieBoxTokenCache.token;
  }

  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/app/get-latest-app-pkgs?app_name=moviebox`;
  logger.log("MOVIEBOX_TOKEN_REQ", "Fetching bearer token");
  
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

async function searchMovieBox(title, mediaType, logger) {
  const token = await fetchMovieBoxBearerToken(logger);
  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/search`;
  logger.log("MOVIEBOX_SEARCH_REQ", "Searching for", { title });

  const response = await fetchUrl(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
    },
    body: {
      keyword: title,
      page: 1,
      perPage: 24,
      subjectType: mediaType === "movie" ? 1 : 2,
    },
  });

  const bodyJson = JSON.parse(response.data);
  let inner = bodyJson.data || {};
  if (inner.data) inner = inner.data;

  const items = inner.items || inner.subjects || [];
  logger.log("MOVIEBOX_SEARCH_RES", `Found ${items.length} results`);
  return items;
}

async function getMovieBoxSubjectDetail(subjectId, token, logger) {
  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/detail`;
  logger.log("MOVIEBOX_DETAIL_REQ", `Fetching subject detail: ${subjectId}`);
  
  try {
    const res = await fetchUrl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Client-Info": '{"timezone":"Africa/Nairobi"}'
      },
      body: { subjectId: String(subjectId) },
    });
    return JSON.parse(res.data).data || {};
  } catch (e) {
    logger.log("MOVIEBOX_DETAIL_ERR", e.message);
    return {};
  }
}

/**
 * FIXED: Fetch ALL audio tracks for an episode
 * Collects both English, Hindi, and any other available languages
 */
async function fetchMovieBoxAllAudioTracks(episodeId, token, logger) {
  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/episode/${episodeId}/play`;
  logger.log("MOVIEBOX_AUDIO_REQ", `Fetching ALL audio tracks for episodeId: ${episodeId}`);
  
  try {
    // Request without specific languageId to get all options
    const res = await fetchUrl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: { episodeId: String(episodeId), languageId: "", resolution: 1080, quality: "high" },
    });
    
    const data = JSON.parse(res.data);
    const allSources = data.data?.sources || [];
    
    logger.log("MOVIEBOX_AUDIO_SUCCESS", `Retrieved ${allSources.length} audio tracks`);
    return allSources;
  } catch (e) {
    logger.log("MOVIEBOX_AUDIO_ERR", e.message);
    return [];
  }
}

async function extractMovieBox(title, mediaType = "movie", season = 1, episode = 1, isDebug = false) {
  const logger = createLogger(isDebug);
  try {
    const token = await fetchMovieBoxBearerToken(logger);
    const items = await searchMovieBox(title, mediaType, logger);

    if (!items.length) throw new Error("MovieBox: Search returned 0 results");

    const matchedItem = items[0];
    const subjectId = String(matchedItem.subjectId || matchedItem.id || "");
    const detailPath = matchedItem.detailPath || "";

    logger.log("MOVIEBOX_SUBJECT_MATCH", `Subject ID: ${subjectId}`);

    if (!subjectId) throw new Error("MovieBox: Subject ID missing");

    let allAudioTracks = [];  // Store ALL audio tracks
    let bestStream = null;
    let allQualities = [];

    const detailTree = await getMovieBoxSubjectDetail(subjectId, token, logger);
    
    if (detailTree && detailTree.seasons) {
      const seasonsObj = detailTree.seasons;
      let matchedSeasonKey = Object.keys(seasonsObj).find(k => Number(k.replace(/\D/g, '')) === Number(season));
      
      if (matchedSeasonKey) {
        const seasonData = seasonsObj[matchedSeasonKey] || {};
        let matchedEpKey = Object.keys(seasonData).find(k => Number(k.replace(/\D/g, '')) === Number(episode));
        const episodeData = matchedEpKey ? seasonData[matchedEpKey] : null;

        if (episodeData && episodeData.id) {
          const episodeId = episodeData.id;
          
          // ===== FIXED: Get ALL audio sources =====
          const allSources = await fetchMovieBoxAllAudioTracks(episodeId, token, logger);
          
          // Group by language and collect all
          const audioMap = {};
          
          for (const source of allSources) {
            if (source.vipLocked) continue;
            
            let finalUrl = cleanVideoUrl(source.url || source.videoUrl || "");
            const signCookie = source.sign_cookie || source.signCookie;

            if (!finalUrl && signCookie) {
              finalUrl = cleanVideoUrl(dashManifestFromPolicy(signCookie) || "");
            }

            if (!finalUrl) continue;

            const language = source.languageName || source.language || source.languageId || "Unknown";
            const resolution = source.resolution || source.resolutions || source.quality || "auto";
            
            // Store all qualities
            allQualities.push({
              url: finalUrl,
              resolution: resolution,
              language: language,
              languageId: source.languageId,
            });

            // Track first URL per language
            if (!audioMap[language]) {
              audioMap[language] = finalUrl;
              allAudioTracks.push({
                language: language,
                label: language.toUpperCase().substring(0, 3),
                languageId: source.languageId,
                resolution: resolution,
              });
            }

            // Set best stream (first valid one)
            if (!bestStream) {
              bestStream = {
                url: finalUrl,
                resolution: resolution,
                language: language,
              };
            }
          }

          logger.log("MOVIEBOX_AUDIO_COLLECTED", `Collected ${allAudioTracks.length} audio tracks`, {
            languages: allAudioTracks.map(t => t.language)
          });
        }
      }
    }

    // Fallback if no episode details found
    if (!bestStream && detailPath) {
      const params = `subjectId=${subjectId}&detailPath=${encodeURIComponent(detailPath)}` + 
        (mediaType !== "movie" ? `&se=${season}&ep=${episode}` : "");
      
      const playUrl = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/play?${params}`;
      logger.log("MOVIEBOX_FALLBACK_REQ", "Executing fallback play API");

      try {
        const playRes = await fetchUrl(playUrl, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/json",
          },
        });
        
        const pData = JSON.parse(playRes.data).data || {};
        const combined = [...(pData.streams || []), ...(pData.dash || [])];

        for (const s of combined) {
          if (s.vipLocked) continue;
          let finalUrl = cleanVideoUrl(s.url || s.videoUrl || "");
          const signCookie = s.sign_cookie || s.signCookie;

          if (!finalUrl && signCookie) {
            finalUrl = cleanVideoUrl(dashManifestFromPolicy(signCookie) || "");
          }

          if (finalUrl) {
            const language = s.languageName || "Default";
            allQualities.push({
              url: finalUrl,
              resolution: s.quality || "auto",
              language: language,
            });

            if (!bestStream) {
              bestStream = { url: finalUrl, resolution: s.quality, language };
            }

            if (!allAudioTracks.find(t => t.language === language)) {
              allAudioTracks.push({ language, label: "DEF" });
            }
          }
        }
      } catch (e) {
        logger.log("MOVIEBOX_FALLBACK_ERR", e.message);
      }
    }

    if (!bestStream) throw new Error("MovieBox: No stream sources available");

    const primaryHeaders = {
      "Referer": `https://123moviesfree.club/`,
      "Origin": "https://123moviesfree.club",
      "User-Agent": DEFAULT_UA,
      "Accept": "*/*",
    };

    return {
      success: true,
      source: "moviebox",
      videoUrl: bestStream.url,
      urlWithHeaders: buildPipeUrl(bestStream.url, primaryHeaders),
      headers: primaryHeaders,
      quality: String(bestStream.resolution),
      qualities: allQualities,
      audioTracks: allAudioTracks,  // ALL audio tracks!
      subtitles: [],
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
        audioTracks: successfulResult.audioTracks || [],  // All audio tracks!
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
