/**
 * Triple Video Source API - Castle + Modiplay + MovieBox
 * Endpoint: /api/source?title=Stranger+Things&id=66732&type=tv&s=1&e=1&source=all
 * Usage: Place in api/ folder of your Vercel project
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
const MOVIEBOX_H5_WEB = "https://h5.aoneroom.com";

const CASTLE_CONFIG = {
  channel: "IndiaA",
  clientType: "1",
  lang: "en-US",
  packageName: "com.external.castle",
  key: process.env.CASTLE_KEY || "PUT_YOUR_CASTLE_KEY_HERE",
};

const DEFAULT_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

// Cache for MovieBox bearer token
let movieBoxTokenCache = { token: null, expiresAt: 0 };

// ============================================================
// UTILITIES
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
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 100)}`));
          }
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      if (options.body) {
        if (typeof options.body === 'object') {
          req.write(JSON.stringify(options.body));
        } else {
          req.write(options.body);
        }
      }

      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Helper to construct Header pipe string: url|Header1=Value1&Header2=Value2
function buildPipeUrl(url, headers = {}) {
  const pairs = Object.entries(headers)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return pairs ? `${url}|${pairs}` : url;
}

// Helper to decode CloudFront policy into MPD manifest URL
function dashManifestFromPolicy(signCookie) {
  if (!signCookie || typeof signCookie !== 'string') return null;

  let policyPart = null;
  const parts = signCookie.split(';');
  for (let item of parts) {
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

    const decodedText = Buffer.from(stdB64, 'base64').toString('utf-8');
    const policyJson = JSON.parse(decodedText);
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
// CASTLE API - DECRYPTION & EXTRACTOR
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
  const response = await fetchUrl(url, {
    headers: { "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9" },
  });
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

  const decrypted = decryptCastle(cipherText, securityKey);
  let result = JSON.parse(decrypted);

  if (result.data && typeof result.data === 'object') {
    return result.data;
  }
  return result;
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
    const first = rows[0];
    movieId = String(first.id || first.redirectId || first.redirectIdStr || "");
  }

  if (!movieId) throw new Error("Castle: Movie ID not found");
  return movieId;
}

async function castleGetDetails(movieId, securityKey) {
  const url = `${CASTLE_API}/film-api/v1.9.9/movie?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}&movieId=${movieId}&packageName=${CASTLE_CONFIG.packageName}`;
  return await castleRequest(url, securityKey);
}

async function castleGetVideo(movieId, episodeId, securityKey, resolution = "2") {
  const url = `${CASTLE_API}/film-api/v2.0.1/movie/getVideo2?clientType=${CASTLE_CONFIG.clientType}&packageName=${CASTLE_CONFIG.packageName}&channel=${CASTLE_CONFIG.channel}&lang=${CASTLE_CONFIG.lang}`;
  
  const body = {
    mode: "1",
    appMarket: "GuanWang",
    clientType: CASTLE_CONFIG.clientType,
    woolUser: "false",
    apkSignKey: CASTLE_CONFIG.key,
    androidVersion: "13",
    movieId: movieId,
    episodeId: episodeId,
    isNewUser: "true",
    resolution: resolution,
    packageName: CASTLE_CONFIG.packageName,
  };

  return await castleRequest(url, securityKey, { method: "POST", body });
}

async function extractCastle(title, season = null, episode = null) {
  try {
    const securityKey = await getCastleSecurityKey();
    const movieId = await castleSearch(title, securityKey);
    let details = await castleGetDetails(movieId, securityKey);
    
    let effectiveMovieId = movieId;

    if (season !== null && episode !== null) {
      const seasons = details.seasons || details.seasonList || [];
      if (seasons.length > 0) {
        const seasonData = seasons.find(s => Number(s.number || s.seasonIndex || s.season) === Number(season));
        if (seasonData && seasonData.movieId && String(seasonData.movieId) !== String(movieId)) {
          details = await castleGetDetails(seasonData.movieId, securityKey);
          effectiveMovieId = seasonData.movieId;
        }
      }
    }

    const episodes = details.episodes || details.episodeList || details.list || [];
    if (!episodes.length) throw new Error("Castle: No episodes found in detail payload");

    let episodeData = null;
    if (season !== null && episode !== null) {
      episodeData = episodes.find(ep => 
        Number(ep.number || ep.episodeIndex || ep.episode || ep.sort) === Number(episode)
      );
    }
    if (!episodeData) episodeData = episodes[0];
    if (!episodeData) throw new Error("Castle: Episode not found");

    const episodeId = episodeData.id || episodeData.episodeId || episodeData.movieId;

    // Try multiple resolutions if resolution 2 returns no valid URL
    let videoData = null;
    let videoUrl = "";
    
    for (const resChoice of ["2", "1", "3", "auto"]) {
      videoData = await castleGetVideo(effectiveMovieId, episodeId, securityKey, resChoice);
      videoUrl = videoData.videoUrl || videoData.url || videoData.playUrl || videoData.m3u8Url || videoData.streamUrl || "";
      
      if (!videoUrl && Array.isArray(videoData.list) && videoData.list.length > 0) {
        videoUrl = videoData.list[0].url || videoData.list[0].videoUrl || videoData.list[0].playUrl || "";
      }

      if (videoUrl) break;
    }

    if (!videoUrl) throw new Error("Castle: Video URL unavailable for this episode");

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
// MODIPLAY - EXTRACTION
// ============================================================

async function extractModiplay(mediaId, mediaType = "tv", season = null, episode = null) {
  try {
    let embedUrl;
    if (mediaType === "tv" && season && episode) {
      embedUrl = `${MODIPLAY_API}/embed/tmdb/tv?id=${mediaId}&s=${season}&e=${episode}`;
    } else {
      embedUrl = `${MODIPLAY_API}/embed/tmdb/${mediaType}?id=${mediaId}`;
    }

    const embedResponse = await fetchUrl(embedUrl, {
      userAgent: DEFAULT_UA,
      headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });

    const iframeRegex = /<iframe\b[^>]*\bid\s*=\s*["']playerFrame["'][^>]*>/i;
    const iframeMatch = embedResponse.data.match(iframeRegex);

    let playerUrl = "";
    if (iframeMatch) {
      const srcMatch = iframeMatch[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (srcMatch) playerUrl = srcMatch[1].trim();
    }

    if (!playerUrl) {
      const genericIframe = embedResponse.data.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
      if (genericIframe) playerUrl = genericIframe[1].trim();
    }

    if (!playerUrl) throw new Error("Modiplay: Player iframe source not found");

    if (playerUrl.startsWith('/')) {
      const urlObj = new URL(embedUrl);
      playerUrl = `${urlObj.protocol}//${urlObj.host}${playerUrl}`;
    } else if (!playerUrl.startsWith('http')) {
      playerUrl = embedUrl.split('?')[0].replace(/\/$/, '') + '/' + playerUrl;
    }

    const playerResponse = await fetchUrl(playerUrl, {
      userAgent: DEFAULT_UA,
      headers: {
        "Referer": embedUrl,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const html = playerResponse.data;
    let videoUrl = "";

    // Regex list for extracting standard direct JS variables
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

    // Direct m3u8/mp4 regex fallback if JavaScript variable matches fail
    if (!videoUrl) {
      const streamMatch = html.match(/(https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)/i);
      if (streamMatch) videoUrl = streamMatch[1];
    }

    if (!videoUrl) throw new Error("Modiplay: Direct video source not found in player script");

    try {
      videoUrl = decodeURIComponent(videoUrl);
    } catch (e) {}

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
// MOVIEBOX - EXTRACTION
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

  const payload = {
    keyword: title,
    page: 1,
    perPage: 24,
    subjectType: mediaType === "movie" ? 1 : 2,
  };

  const response = await fetchUrl(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
      "Referer": MOVIEBOX_BASE_URL,
    },
    body: payload,
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
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
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
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: {
        episodeId: episodeId,
        languageId: languageId || "",
        resolution: 1080,
        quality: "high",
      },
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

    // STEP A: Fetch using Episode Play Endpoint if TV / Detail Tree present
    const detailTree = await getMovieBoxSubjectDetail(subjectId, token);
    if (detailTree && detailTree.seasons) {
      const seasonKey = `Season ${season}`;
      const seasonData = detailTree.seasons[seasonKey] || {};
      const episodeData = seasonData[`Episode ${episode}`] || {};
      const episodeId = episodeData.id;

      if (episodeId) {
        const tracks = episodeData.tracks || [];
        let selectedLangId = "";

        for (const trk of tracks) {
          if ((trk.languageName || "").toLowerCase().includes(preferredLanguage.toLowerCase())) {
            selectedLangId = trk.languageId;
            break;
          }
        }
        if (!selectedLangId && tracks.length > 0) {
          selectedLangId = tracks[0].languageId;
        }

        const sources = await fetchMovieBoxEpisodePlay(episodeId, selectedLangId, token);
        for (const s of sources) {
          if (s.vipLocked) continue;
          let finalUrl = s.url || s.videoUrl || "";
          const signCookie = s.sign_cookie || s.signCookie;

          if (!finalUrl && signCookie) {
            finalUrl = dashManifestFromPolicy(signCookie) || "";
          }

          if (finalUrl) {
            candidateStreams.push({
              url: finalUrl,
              resolution: s.resolutions || s.resolution || s.quality || "1080p",
            });
          }
        }
      }
    }

    // STEP B: Fallback Play/Download API
    if (!candidateStreams.length && detailPath) {
      const params = `subjectId=${subjectId}&detailPath=${encodeURIComponent(detailPath)}` + 
        (mediaType !== "movie" ? `&se=${season}&ep=${episode}` : "");
      
      const playUrl = `${MOVIEBOX_BASE_URL}/wefeed-h5api-bff/subject/play?${params}`;
      
      try {
        const playRes = await fetchUrl(playUrl, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/json",
            "Referer": `https://fmoviesunblocked.net/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail`,
          },
        });
        
        const pData = JSON.parse(playRes.data).data || {};
        const combined = [...(pData.streams || []), ...(pData.dash || [])];

        for (const s of combined) {
          if (s.vipLocked) continue;
          let finalUrl = s.url || s.videoUrl || "";
          const signCookie = s.sign_cookie || s.signCookie;

          if (!finalUrl && signCookie) {
            finalUrl = dashManifestFromPolicy(signCookie) || "";
          }

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

    // Primary Headers including the requested Fallback Candidate (123moviesfree.club)
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
// MAIN VERCEL API HANDLER
// ============================================================

module.exports = async (req, res) => {
  // CORS configuration
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const { 
      id, 
      title, 
      type = "tv", 
      s, 
      e, 
      source = "all" 
    } = req.query;

    if (!id && !title) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: 'id' (for Modiplay) or 'title' (for Castle/MovieBox)",
      });
    }

    const season = s ? parseInt(s, 10) : 1;
    const episode = e ? parseInt(e, 10) : 1;
    const mediaType = type.toLowerCase() === "movie" ? "movie" : "tv";

    const fetchTasks = [];

    // 1. MovieBox
    if ((source === "all" || source === "moviebox") && title) {
      fetchTasks.push(extractMovieBox(title, mediaType, season, episode));
    }

    // 2. Castle
    if ((source === "all" || source === "castle") && title) {
      fetchTasks.push(extractCastle(title, season, episode));
    }

    // 3. Modiplay
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
