/**
 * Triple Video Source API - Castle + Modiplay + MovieBox
 * Fixed: GZIP decompression in fetchUrl & Castle empty stream handling
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

    return {
      success: true,
      source: "castle",
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

async function extractMovieBox(title, mediaType = "movie", season = null, episode = null, isDebug = false) {
  const logger = createLogger(isDebug);

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

    for (const item of items) {
      const rawTitle = item.title || "";
      const subjectId = item.subjectId || item.id;
      if (!subjectId) continue;

      const itemCleanTitle = cleanTitleString(rawTitle);
      if (itemCleanTitle === targetTitleClean || itemCleanTitle.includes(targetTitleClean) || targetTitleClean.includes(itemCleanTitle)) {
        matchedSubjects.push({
          subjectId: String(subjectId),
          language: extractLanguageTag(rawTitle),
          rawTitle,
          detailPath: item.detailPath || ""
        });
      }
    }

    if (!matchedSubjects.length && items.length > 0) {
      const first = items[0];
      matchedSubjects.push({
        subjectId: String(first.subjectId || first.id),
        language: extractLanguageTag(first.title || ""),
        rawTitle: first.title || "",
        detailPath: first.detailPath || ""
      });
    }

    logger.log("MOVIEBOX_MATCHED_SUBJECTS", `Matched ${matchedSubjects.length} subjects`, matchedSubjects);

    const candidateStreams = [];
    const subtitles = [];

    for (const target of matchedSubjects) {
      logger.log("MOVIEBOX_SUBJECT_FETCH", `Fetching stream for ${target.rawTitle} [ID: ${target.subjectId}]`);

      const detailPath = await getMovieBoxDetailPath(target.subjectId, target.detailPath, logger);

      const streamHeaders = {
        "Referer": `https://123moviesfree.club/movies/${detailPath}?id=${target.subjectId}&type=/movie/detail`,
        "Origin": "https://123moviesfree.club",
        "User-Agent": DEFAULT_UA,
        "Accept": "*/*",
      };

      let collectedSources = [];

      // STEP A: Try H5 Tree & Episode Play Endpoint
      const detailTree = await getMovieBoxSubjectDetail(target.subjectId, token, logger);
      if (detailTree && detailTree.seasons) {
        const seasonsObj = detailTree.seasons || {};
        const seasonKey = `Season ${season || 1}`;
        const seasonData = seasonsObj[seasonKey] || {};
        const episodeData = seasonData[`Episode ${episode || 1}`] || {};
        const episodeId = episodeData.id;

        if (episodeId) {
          const tracks = episodeData.tracks || [];
          let selectedLangId = tracks.length > 0 ? tracks[0].languageId : "";

          for (const trk of tracks) {
            if (String(trk.languageName || "").toLowerCase().includes("english")) {
              selectedLangId = trk.languageId;
              break;
            }
          }

          const epSources = await fetchMovieBoxEpisodePlay(episodeId, selectedLangId, token, logger);
          if (epSources.length > 0) {
            collectedSources = epSources;
            logger.log("MOVIEBOX_EPISODE_PLAY_SUCCESS", `Extracted ${epSources.length} streams from H5 Episode Play`);
          }
        }
      }

      // STEP B: Direct Download/Play Endpoint Fallback
      if (!collectedSources.length) {
        const params = new URLSearchParams({ subjectId: target.subjectId });
        if (season !== null) params.append("se", String(season));
        if (episode !== null) params.append("ep", String(episode));
        if (detailPath) params.append("detailPath", detailPath);

        const apiHeaders = {
          ...streamHeaders,
          "Authorization": `Bearer ${token}`,
          "X-Client-Info": JSON.stringify({ timezone: "Africa/Nairobi" }),
        };

        const endpoints = [
          `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/play?${params.toString()}`,
          `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/download?${params.toString()}`
        ];

        for (const epUrl of endpoints) {
          try {
            const res = await fetchUrl(epUrl, { headers: apiHeaders });
            const resObj = JSON.parse(res.data || "{}");
            const dataPayload = unwrapData(resObj);

            const rawStreamList = [
              ...(dataPayload.streams || []),
              ...(dataPayload.downloads || []),
              ...(dataPayload.playUrls || []),
              ...(dataPayload.list || []),
              ...(dataPayload.urls || [])
            ];

            if (dataPayload.url || dataPayload.videoUrl) {
              rawStreamList.push(dataPayload);
            }

            collectedSources.push(...rawStreamList);

            const captions = dataPayload.captions || dataPayload.subtitles || [];
            for (const c of captions) {
              if (c.url) {
                subtitles.push({
                  url: cleanVideoUrl(c.url),
                  language: c.lanName || c.lan || c.language || "English"
                });
              }
            }
          } catch (e) {
            logger.log("MOVIEBOX_EP_ERR", `Fetch failed for ${epUrl}: ${e.message}`);
          }
        }
      }

      // Process raw stream items without skipping/deduplication
      for (const s of collectedSources) {
        if (s.vipLocked) continue;

        let rawUrl = s.url || s.videoUrl || s.playUrl || s.src || s.link || "";
        const signCookie = s.sign_cookie || s.signCookie;
        const cookieVal = cloudfrontCookie(signCookie);

        let finalUrl = cleanVideoUrl(rawUrl);

        if ((!finalUrl || finalUrl.includes('.mpd')) && signCookie) {
          const manifest = dashManifestFromPolicy(signCookie);
          if (manifest) finalUrl = manifest;
        }

        if (finalUrl && !finalUrl.includes('macdn.aoneroom.com/other/')) {
          const resVal = String(s.resolution || s.resolutions || s.quality || s.definition || "auto");
          const itemHeaders = { ...streamHeaders };
          if (cookieVal) itemHeaders["Cookie"] = cookieVal;

          candidateStreams.push({
            url: finalUrl,
            urlWithHeaders: buildPipeUrl(finalUrl, itemHeaders),
            headers: itemHeaders,
            resolution: resVal,
            language: target.language
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
      urlWithHeaders: bestStream.urlWithHeaders,
      headers: bestStream.headers,
      quality: String(bestStream.resolution),
      qualities: candidateStreams,
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
