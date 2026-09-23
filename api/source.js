/**
 * Dual Video Source API - Castle + Modiplay
 * Endpoint: /api/source?id=1399&type=tv&s=1&e=1
 * Usage: Rename to source.js and place in api/ folder
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ============================================================
// CONFIGURATION
// ============================================================

const CASTLE_API = "https://api.hlowb.com";
const MODIPLAY_API = "https://rozgarlelo.modiplay.xyz";

const CASTLE_CONFIG = {
  channel: "IndiaA",
  clientType: "1",
  lang: "en-US",
  packageName: "com.external.castle",
  key: process.env.CASTLE_KEY || "PUT_YOUR_CASTLE_KEY_HERE",
};

const MODIPLAY_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// ============================================================
// UTILITIES
// ============================================================

function fetchUrl(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const protocol = url.protocol === "https:" ? https : http;
    
    const requestOptions = {
      method: options.method || "GET",
      headers: {
        "User-Agent": options.userAgent || MODIPLAY_UA,
        ...options.headers,
      },
      timeout: options.timeout || 20000,
    };

    const req = protocol.request(url, requestOptions, (res) => {
      let data = "";
      
      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ data, statusCode: res.statusCode });
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
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

// ============================================================
// CASTLE API - DECRYPTION
// ============================================================

function decrypt_castle(cipherText, securityKey) {
  const crypto = require('crypto');
  
  const pepper = Buffer.from("T!BgJB");
  const keyWords = Buffer.from(securityKey, 'base64');
  const combined = Buffer.concat([keyWords, pepper]);
  const keyMaterial = combined.slice(0, 16);
  
  const cipherBytes = Buffer.from(cipherText, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyMaterial, keyMaterial);
  
  let decrypted = decipher.update(cipherBytes);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  // Remove PKCS7 padding
  const padding = decrypted[decrypted.length - 1];
  if (padding >= 1 && padding <= 16) {
    decrypted = decrypted.slice(0, decrypted.length - padding);
  }
  
  return decrypted.toString('utf-8');
}

// ============================================================
// CASTLE API - REQUESTS
// ============================================================

async function getCastleSecurityKey() {
  const url = `${CASTLE_API}/v0.1/system/getSecurityKey/1?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}`;
  
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
  
  return securityKey;
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
  } catch (e) {
    // Keep original response
  }

  const decrypted = decrypt_castle(cipherText, securityKey);
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
  const rows = data.rows || [];

  if (!rows.length) {
    throw new Error("Castle: No search results");
  }

  let movieId = "";
  
  for (const row of rows) {
    const rowTitle = row.title || row.name || "";
    if (title.toLowerCase().includes(rowTitle.toLowerCase()) || 
        rowTitle.toLowerCase().includes(title.toLowerCase())) {
      movieId = String(row.id || row.redirectId || row.redirectIdStr || "");
      if (movieId) break;
    }
  }

  if (!movieId) {
    const first = rows[0];
    movieId = String(first.id || first.redirectId || first.redirectIdStr || "");
  }

  if (!movieId) {
    throw new Error("Castle: Movie ID not found");
  }

  return movieId;
}

async function castleGetDetails(movieId, securityKey) {
  const url = `${CASTLE_API}/film-api/v1.9.9/movie?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}&movieId=${movieId}&packageName=${CASTLE_CONFIG.packageName}`;
  return await castleRequest(url, securityKey);
}

async function castleGetSeasonDetails(seasonMovieId, securityKey) {
  const url = `${CASTLE_API}/film-api/v1.9.9/movie?channel=${CASTLE_CONFIG.channel}&clientType=${CASTLE_CONFIG.clientType}&lang=${CASTLE_CONFIG.lang}&movieId=${seasonMovieId}&packageName=${CASTLE_CONFIG.packageName}`;
  return await castleRequest(url, securityKey);
}

async function castleGetVideo(movieId, episodeId, securityKey) {
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
    resolution: "2",
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

    // Handle TV series
    if (season !== null && episode !== null) {
      const seasons = details.seasons || [];
      if (seasons.length > 0) {
        const seasonData = seasons.find(s => s.number === season);
        if (seasonData && seasonData.movieId && seasonData.movieId !== movieId) {
          details = await castleGetSeasonDetails(seasonData.movieId, securityKey);
          effectiveMovieId = seasonData.movieId;
        }
      }
    }

    // Get episode
    const episodes = details.episodes || [];
    if (!episodes.length) {
      throw new Error("Castle: No episodes found");
    }

    let episodeData = null;
    if (season !== null && episode !== null) {
      episodeData = episodes.find(ep => ep.number === episode);
    } else {
      episodeData = episodes[0];
    }

    if (!episodeData) {
      throw new Error("Castle: Episode not found");
    }

    const episodeId = episodeData.id;

    // Get video
    const videoData = await castleGetVideo(effectiveMovieId, episodeId, securityKey);

    return {
      success: true,
      source: "castle",
      videoUrl: videoData.videoUrl,
      subtitles: videoData.subtitles || [],
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
    // Build embed URL
    let embedUrl;
    if (mediaType === "tv" && season && episode) {
      embedUrl = `${MODIPLAY_API}/embed/tmdb/tv?id=${mediaId}&s=${season}&e=${episode}`;
    } else {
      embedUrl = `${MODIPLAY_API}/embed/tmdb/${mediaType}?id=${mediaId}`;
    }

    // Fetch embed page
    const embedResponse = await fetchUrl(embedUrl, {
      userAgent: MODIPLAY_UA,
      headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });

    // Extract player iframe
    const iframeRegex = /<iframe\b[^>]*\bid\s*=\s*["']playerFrame["'][^>]*>/i;
    const iframeMatch = embedResponse.data.match(iframeRegex);

    if (!iframeMatch) {
      throw new Error("Modiplay: No player iframe found");
    }

    const srcRegex = /\bsrc\s*=\s*["']([^"']+)["']/i;
    const srcMatch = iframeMatch[0].match(srcRegex);

    if (!srcMatch) {
      throw new Error("Modiplay: No iframe src found");
    }

    let playerUrl = srcMatch[1].trim();
    
    // Make absolute URL
    if (playerUrl.startsWith('/')) {
      const url = new URL(embedUrl);
      playerUrl = `${url.protocol}//${url.host}${playerUrl}`;
    } else if (!playerUrl.startsWith('http')) {
      playerUrl = embedUrl.split('?')[0].replace(/\/$/, '') + '/' + playerUrl;
    }

    // Fetch player page
    const playerResponse = await fetchUrl(playerUrl, {
      userAgent: MODIPLAY_UA,
      headers: {
        "Referer": embedUrl,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    // Extract directSrc from JavaScript
    const directSrcRegex = /var\s+directSrc\s*=\s*["']([^"']+)["']/;
    const directSrcMatch = playerResponse.data.match(directSrcRegex);

    if (!directSrcMatch) {
      // Try alternative pattern
      const srcRegex2 = /var\s+src\s*=\s*["']([^"']+)["']/;
      const srcMatch2 = playerResponse.data.match(srcRegex2);
      
      if (!srcMatch2) {
        throw new Error("Modiplay: No directSrc found");
      }

      var videoUrl = decodeURIComponent(srcMatch2[1].trim());
    } else {
      var videoUrl = decodeURIComponent(directSrcMatch[1].trim());
    }

    // Make absolute URL
    if (videoUrl.startsWith('/')) {
      const url = new URL(playerUrl);
      videoUrl = `${url.protocol}//${url.host}${videoUrl}`;
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
// MAIN HANDLER
// ============================================================

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const { id, type = "tv", s, e, title, source = "both" } = req.query;

    // Validate parameters
    if (!id && !title) {
      return res.status(400).json({
        success: false,
        error: "Missing id or title parameter",
      });
    }

    let season = s ? parseInt(s) : null;
    let episode = e ? parseInt(e) : null;

    const results = {
      success: true,
      source: source,
      results: [],
    };

    // Try Castle
    if (source === "castle" || source === "both") {
      if (title) {
        const castleResult = await extractCastle(title, season, episode);
        results.results.push(castleResult);
      }
    }

    // Try Modiplay
    if (source === "modiplay" || source === "both") {
      if (id) {
        const modiplayResult = await extractModiplay(id, type, season, episode);
        results.results.push(modiplayResult);
      }
    }

    // Return first successful result
    const successful = results.results.find(r => r.success);
    
    if (successful) {
      return res.status(200).json({
        success: true,
        source: successful.source,
        videoUrl: successful.videoUrl,
        quality: successful.quality || "auto",
        subtitles: successful.subtitles || [],
        allResults: results.results,
      });
    }

    // All failed
    return res.status(200).json({
      success: false,
      error: "All sources failed",
      results: results.results,
    });

  } catch (error) {
    console.error("[ERROR]", error);
    
    return res.status(500).json({
      success: false,
      error: error.message || "Extraction failed",
    });
  }
};
