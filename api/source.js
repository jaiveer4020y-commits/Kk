/**
 * Triple Video Source API - Castle + Modiplay + MovieBox
 * Fixes applied for Stranger Things S5 (Nested Castle IDs, MovieBox key matching, Modiplay JS unpacking)
 * Endpoint: /api/source?title=Stranger+Things&id=66732&type=tv&s=5&e=1&source=all
 */

console.log("API route /api/source module loaded");

const https = require('https');
const http = require('http');
const { URL } = require('url');

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
  key: process.env.CASTLE_KEY || "PUT_YOUR_CASTLE_KEY_HERE",
};

const DEFAULT_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

let movieBoxTokenCache = { token: null, expiresAt: 0 };

// ============================================================
// UTILITIES & DEPACKERS
// ============================================================

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
            reject(new Error(`HTTP ${res.statusCode}`));
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
  const pairs = Object.entries(headers)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return pairs ? `${url}|${pairs}` : url;
}

// Unpacks Dean Edwards packed JavaScript: eval(function(p,a,c,k,e,r)...)
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
// CASTLE API - DECRYPTION & FIXED EXTRACTOR
// ============================================================

function decryptCastle(cipherText, securityKey) {
  const crypto = require('crypto');
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

async function getCastleSecurityKey() {
  const url = `${CASTLE_API}/v0.1/system/getSecurityKey/1?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}`;
  const response = await fetchUrl(url, { headers: { "Accept": "application/json" } });
  const data = JSON.parse(response.data);
  if (!data.data) throw new Error("Castle security key not found");
  return data.data;
}

async function castleRequest(url, securityKey, options = {}) {
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

  const decrypted = decryptCastle(cipherText, securityKey);
  let result = JSON.parse(decrypted);
  return (result.data && typeof result.data === 'object') ? result.data : result;
}

async function castleSearch(title, securityKey) {
  const encoded = encodeURIComponent(title);
  const url = `${CASTLE_API}/film-api/v1.1.0/movie/searchByKeyword?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&keyword=${encoded}&lang=${CASTLE_CONFIG.lang}&mode=1&packageName=${CASTLE_CONFIG.packageName}&page=1&size=30`;

  const data = await castleRequest(url, securityKey);
  const rows = data.rows || data.list || [];
  if (!rows.length) throw new Error("Castle: No search results");

  let movieId = "";
  for (const row of rows) {
    const rowTitle = row.title || row.name || "";
    if (title.toLowerCase().includes(rowTitle.toLowerCase()) || rowTitle.toLowerCase().includes(title.toLowerCase())) {
      movieId = String(row.id || row.redirectId || row.redirectIdStr || "");
      if (movieId) break;
    }
  }

  if (!movieId && rows.length > 0) {
    movieId = String(rows[0].id || rows[0].redirectId || rows[0].redirectIdStr || "");
  }

  if (!movieId) throw new Error("Castle: Movie ID not found");
  return movieId;
}

async function castleGetDetails(movieId, securityKey) {
  const url = `${CASTLE_API}/film-api/v1.9.9/movie?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}&movieId=${movieId}&packageName=${CASTLE_CONFIG.packageName}`;
  return await castleRequest(url, securityKey);
}

async function castleGetVideo(targetMovieId, episodeId, securityKey, resolution = "2") {
  const url = `${CASTLE_API}/film-api/v2.0.1/movie/getVideo2?clientType=${CASTLE_CONFIG.clientType}&packageName=${CASTLE_CONFIG.packageName}&channel=${CASTLE_CONFIG.channel}&lang=${CASTLE_CONFIG.lang}`;
  
  const body = {
    mode: "1",
    appMarket: "GuanWang",
    clientType: CASTLE_CONFIG.clientType,
    woolUser: "false",
    apkSignKey: CASTLE_CONFIG.key,
    androidVersion: "13",
    movieId: String(targetMovieId),
    episodeId: String(episodeId),
    isNewUser: "true",
    resolution: resolution,
    packageName: CASTLE_CONFIG.packageName,
  };

  return await castleRequest(url, securityKey, { method: "POST", body });
}

async function extractCastle(title, season = null, episode = null) {
  try {
    const securityKey = await getCastleSecurityKey();
    const rootMovieId = await castleSearch(title, securityKey);
    let details = await castleGetDetails(rootMovieId, securityKey);
    
    let effectiveMovieId = rootMovieId;

    // Match season across multiple parameter representations
    if (season !== null && episode !== null) {
      const seasons = details.seasons || details.seasonList || details.seasonsList || [];
      if (seasons.length > 0) {
        const seasonData = seasons.find(s => {
          const sNum = s.number ?? s.seasonIndex ?? s.season ?? s.sort;
          return Number(sNum) === Number(season);
        });

        if (seasonData && seasonData.movieId) {
          effectiveMovieId = String(seasonData.movieId);
          try {
            details = await castleGetDetails(effectiveMovieId, securityKey);
          } catch (e) {}
        }
      }
    }

    // Collect all candidate episode lists
    let episodes = details.episodes || details.episodeList || details.list || [];
    if (!episodes.length && details.seasons) {
      for (const s of details.seasons) {
        const sNum = s.number ?? s.seasonIndex ?? s.season;
        if (Number(sNum) === Number(season) && (s.episodes || s.episodeList)) {
          episodes = s.episodes || s.episodeList;
          break;
        }
      }
    }

    if (!episodes.length) throw new Error("Castle: No episodes found for season");

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

    // Fallback Matrix: Try combination of effectiveMovieId vs rootMovieId + multiple resolutions
    let videoUrl = "";
    let videoData = {};

    const idCandidates = [effectiveMovieId, rootMovieId].filter((v, i, a) => v && a.indexOf(v) === i);
    const resCandidates = ["2", "1", "3", "auto"];

    for (const mid of idCandidates) {
      for (const resChoice of resCandidates) {
        try {
          videoData = await castleGetVideo(mid, episodeId, securityKey, resChoice);
          videoUrl = videoData.videoUrl || videoData.url || videoData.playUrl || videoData.m3u8Url || videoData.streamUrl || "";
          
          if (!videoUrl && Array.isArray(videoData.list) && videoData.list.length > 0) {
            videoUrl = videoData.list[0].url || videoData.list[0].videoUrl || videoData.list[0].playUrl || "";
          }

          if (videoUrl) break;
        } catch (e) {}
      }
      if (videoUrl) break;
    }

    if (!videoUrl) throw new Error("Castle: Stream URL unavailable for this episode");

    return {
      success: true,
      source: "castle",
      videoUrl: videoUrl,
      subtitles: videoData.subtitles || videoData.subtitleList || [],
      quality: "auto",
    };
  } catch (error) {
    return {
      success: false,
      source: "castle",
      error: error.message,
    };
  }
}

// ============================================================
// MODIPLAY - FIXED EXTRACTOR WITH UNPACKER
// ============================================================

async function extractModiplay(mediaId, mediaType = "tv", season = null, episode = null) {
  try {
    let embedUrl = (mediaType === "tv" && season && episode)
      ? `${MODIPLAY_API}/embed/tmdb/tv?id=${mediaId}&s=${season}&e=${episode}`
      : `${MODIPLAY_API}/embed/tmdb/${mediaType}?id=${mediaId}`;

    const embedResponse = await fetchUrl(embedUrl, {
      userAgent: DEFAULT_UA,
      headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });

    let playerUrl = "";
    const iframeMatch = embedResponse.data.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (iframeMatch) playerUrl = iframeMatch[1].trim();

    if (!playerUrl) throw new Error("Modiplay: Player iframe source not found");

    if (playerUrl.startsWith('/')) {
      const urlObj = new URL(embedUrl);
      playerUrl = `${urlObj.protocol}//${urlObj.host}${playerUrl}`;
    }

    const playerResponse = await fetchUrl(playerUrl, {
      userAgent: DEFAULT_UA,
      headers: { "Referer": embedUrl, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8" },
    });

    let html = playerResponse.data;
    
    // Unpack obfuscated JS if present
    if (html.includes("eval(function(p,a,c,k,e,")) {
      html = unpackJS(html);
    }

    let videoUrl = "";
    const regexList = [
      /var\s+directSrc\s*=\s*["']([^"']+)["']/,
      /var\s+src\s*=\s*["']([^"']+)["']/,
      /file\s*:\s*["']([^"']+)["']/,
      /source\s*:\s*["']([^"']+)["']/,
      /["']file["']\s*:\s*["']([^"']+)["']/,
      /src\s*:\s*["'](https?:\/\/[^"']+)["']/
    ];

    for (const reg of regexList) {
      const match = html.match(reg);
      if (match && match[1]) {
        videoUrl = match[1].trim();
        break;
      }
    }

    // Direct m3u8 scan fallback
    if (!videoUrl) {
      const streamMatch = html.match(/(https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)/i);
      if (streamMatch) videoUrl = streamMatch[1];
    }

    if (!videoUrl) throw new Error("Modiplay: Direct stream source not found");

    try { videoUrl = decodeURIComponent(videoUrl); } catch (e) {}

    if (videoUrl.startsWith('/')) {
      const urlObj = new URL(playerUrl);
      videoUrl = `${urlObj.protocol}//${urlObj.host}${videoUrl}`;
    }

    return {
      success: true,
      source: "modiplay",
      videoUrl: videoUrl,
      quality: "auto",
    };
  } catch (error) {
    return {
      success: false,
      source: "modiplay",
      error: error.message,
    };
  }
}

// ============================================================
// MOVIEBOX - FIXED EXTRACTOR WITH FLEXIBLE KEYS
// ============================================================

async function fetchMovieBoxBearerToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && movieBoxTokenCache.token && now < movieBoxTokenCache.expiresAt) {
    return movieBoxTokenCache.token;
  }

  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/app/get-latest-app-pkgs?app_name=moviebox`;
  const response = await fetchUrl(url, { userAgent: DEFAULT_UA, timeout: 8000 });

  const xUserHeader = response.headers["x-user"];
  if (!xUserHeader) throw new Error("MovieBox: Missing x-user header");

  const parsed = JSON.parse(xUserHeader);
  if (parsed && parsed.token) {
    movieBoxTokenCache = { token: parsed.token, expiresAt: now + 3600 * 1000 * 3 };
    return parsed.token;
  }

  throw new Error("MovieBox: Unable to obtain bearer token");
}

async function searchMovieBox(title, mediaType = "movie") {
  const token = await fetchMovieBoxBearerToken();
  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/search`;

  const response = await fetchUrl(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
      "Referer": MOVIEBOX_BASE_URL,
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

  return inner.items || inner.subjects || [];
}

async function getMovieBoxSubjectDetail(subjectId, token) {
  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/${subjectId}/detail`;
  try {
    const res = await fetchUrl(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: {},
    });
    return JSON.parse(res.data).data || {};
  } catch (e) {
    return {};
  }
}

async function fetchMovieBoxEpisodePlay(episodeId, languageId, token) {
  const url = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/episode/${episodeId}/play`;
  try {
    const res = await fetchUrl(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: { episodeId: episodeId, languageId: languageId || "", resolution: 1080, quality: "high" },
    });
    return JSON.parse(res.data).data?.sources || [];
  } catch (e) {
    return [];
  }
}

async function extractMovieBox(title, mediaType = "movie", season = 1, episode = 1, preferredLanguage = "english") {
  try {
    const token = await fetchMovieBoxBearerToken();
    const items = await searchMovieBox(title, mediaType);

    if (!items.length) throw new Error("MovieBox: Search returned no results");

    const matchedItem = items[0];
    const subjectId = String(matchedItem.subjectId || matchedItem.id || "");
    const detailPath = matchedItem.detailPath || "";

    if (!subjectId) throw new Error("MovieBox: Invalid subject ID");

    let candidateStreams = [];

    // STEP A: Detail tree parsing with flexible numeric season & episode key lookups
    const detailTree = await getMovieBoxSubjectDetail(subjectId, token);
    if (detailTree && detailTree.seasons) {
      const seasonsObj = detailTree.seasons;
      let matchedSeasonKey = Object.keys(seasonsObj).find(k => {
        const num = k.replace(/\D/g, '');
        return Number(num) === Number(season);
      });

      if (matchedSeasonKey) {
        const seasonData = seasonsObj[matchedSeasonKey] || {};
        let matchedEpKey = Object.keys(seasonData).find(k => {
          const num = k.replace(/\D/g, '');
          return Number(num) === Number(episode);
        });

        const episodeData = matchedEpKey ? seasonData[matchedEpKey] : null;
        const episodeId = episodeData?.id;

        if (episodeId) {
          const tracks = episodeData.tracks || [];
          let selectedLangId = "";

          for (const trk of tracks) {
            if ((trk.languageName || "").toLowerCase().includes(preferredLanguage.toLowerCase())) {
              selectedLangId = trk.languageId;
              break;
            }
          }
          if (!selectedLangId && tracks.length > 0) selectedLangId = tracks[0].languageId;

          const sources = await fetchMovieBoxEpisodePlay(episodeId, selectedLangId, token);
          for (const s of sources) {
            if (s.vipLocked) continue;
            let finalUrl = s.url || s.videoUrl || "";
            const signCookie = s.sign_cookie || s.signCookie;

            if (!finalUrl && signCookie) finalUrl = dashManifestFromPolicy(signCookie) || "";

            if (finalUrl) {
              candidateStreams.push({
                url: finalUrl,
                resolution: s.resolutions || s.resolution || s.quality || "1080p",
              });
            }
          }
        }
      }
    }

    // STEP B: Direct Play API Fallback
    if (!candidateStreams.length && detailPath) {
      const params = `subjectId=${subjectId}&detailPath=${encodeURIComponent(detailPath)}` + 
        (mediaType !== "movie" ? `&se=${season}&ep=${episode}` : "");
      
      const playUrl = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/play?${params}`;
      
      try {
        const playRes = await fetchUrl(playUrl, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/json",
            "Referer": `https://123moviesfree.club/movies/${detailPath}?id=${subjectId}&type=/movie/detail`,
          },
        });
        
        const pData = JSON.parse(playRes.data).data || {};
        const combined = [...(pData.streams || []), ...(pData.dash || [])];

        for (const s of combined) {
          if (s.vipLocked) continue;
          let finalUrl = s.url || s.videoUrl || "";
          const signCookie = s.sign_cookie || s.signCookie;

          if (!finalUrl && signCookie) finalUrl = dashManifestFromPolicy(signCookie) || "";

          if (finalUrl) {
            candidateStreams.push({
              url: finalUrl,
              resolution: s.resolutions || s.resolution || s.quality || "auto",
            });
          }
        }
      } catch (e) {}
    }

    if (!candidateStreams.length) throw new Error("MovieBox: Stream sources unavailable");

    const bestStream = candidateStreams[0];

    const primaryHeaders = {
      "Referer": `https://123moviesfree.club/movies/${detailPath}?id=${subjectId}&type=/movie/detail`,
      "Origin": "https://123moviesfree.club",
      "User-Agent": DEFAULT_UA,
      "Accept": "*/*",
      "Accept-Encoding": "gzip",
    };

    return {
      success: true,
      source: "moviebox",
      videoUrl: bestStream.url,
      urlWithHeaders: buildPipeUrl(bestStream.url, primaryHeaders),
      headers: primaryHeaders,
      quality: String(bestStream.resolution),
    };
  } catch (error) {
    return {
      success: false,
      source: "moviebox",
      error: error.message,
    };
  }
}

// ============================================================
// MAIN VERCEL HANDLER
// ============================================================

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { id, title, type = "tv", s, e, source = "all" } = req.query;

    if (!id && !title) {
      return res.status(400).json({
        success: false,
        error: "Missing required query parameters: 'id' or 'title'",
      });
    }

    const season = s ? parseInt(s, 10) : 1;
    const episode = e ? parseInt(e, 10) : 1;
    const mediaType = type.toLowerCase() === "movie" ? "movie" : "tv";

    const fetchTasks = [];

    if ((source === "all" || source === "moviebox") && title) {
      fetchTasks.push(extractMovieBox(title, mediaType, season, episode));
    }

    if ((source === "all" || source === "castle") && title) {
      fetchTasks.push(extractCastle(title, season, episode));
    }

    if ((source === "all" || source === "modiplay") && id) {
      fetchTasks.push(extractModiplay(id, mediaType, season, episode));
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
