export const config = {
    runtime: "nodejs"
};

const HLS_API = "https://hls-proxy.vercel.app/api";
const IQSMARTGAMES_API = "https://streams.iqsmartgames.com/embed";

const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 10; K) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";

// ============================================================
// IFRAME EXTRACTION
// ============================================================

function extractIframeFromContainer(html, selector) {
    console.log(`[DEBUG] Extracting iframe from selector: ${selector}`);
    
    const containerRegex = new RegExp(`<div[^>]*class="[^"]*${selector}[^"]*"[^>]*>(.*?)<\\/div>`, "i");
    const match = html.match(containerRegex);
    
    if (!match) {
        console.log(`[DEBUG] Container with selector "${selector}" not found`);
        return null;
    }
    
    const iframeRegex = /<iframe[^>]*src="([^"]+)"/i;
    const iframeMatch = match[1].match(iframeRegex);
    
    if (!iframeMatch) {
        console.log(`[DEBUG] No iframe src found in container`);
        return null;
    }
    
    console.log(`[DEBUG] Extracted iframe src: ${iframeMatch[1]}`);
    return iframeMatch[1];
}

// ============================================================
// VIDEO SERVER LINKS EXTRACTION
// ============================================================

function extractVideoServerLinks(html) {
    console.log("[DEBUG] Extracting video server links from player page...");
    
    const serverItems = [];
    const serverRegex = /<li[^>]*class="server-item"[^>]*data-link="([^"]+)"[^>]*data-source-key="([^"]+)"[^>]*>(.*?)<\/li>/gi;
    
    let match;
    while ((match = serverRegex.exec(html)) !== null) {
        const link = match[1];
        const sourceKey = match[2];
        
        // Extract server name from img alt or server-name div
        const nameRegex = /<div[^>]*class="server-name"[^>]*>([^<]+)<\/div>/i;
        const nameMatch = match[3].match(nameRegex);
        const name = nameMatch ? nameMatch[1].trim() : "Unknown";
        
        serverItems.push({
            name,
            link,
            sourceKey,
            isActive: match[0].includes('class="server-item active')
        });
        
        console.log(`[DEBUG] Found server: ${name} (${sourceKey}) - ${link}`);
    }
    
    return serverItems;
}

function extractSubtitles(html) {
    console.log("[DEBUG] Searching for subtitle sources...");
    
    const subtitles = [];
    
    // Pattern for subtitle tracks in various formats
    const subtitlePatterns = [
        /<track[^>]*kind="captions"[^>]*src="([^"]+)"[^>]*label="([^"]+)"/gi,
        /<track[^>]*src="([^"]+)"[^>]*label="([^"]+)"/gi,
        /"subtitle"[^}]*?"url"\s*:\s*"([^"]+)"/gi,
        /hls4["\']?\s*:\s*["\']?([^"'}\s,]+\.m3u8[^"'}\s,]*)/gi
    ];
    
    for (const pattern of subtitlePatterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
            if (match[1]) {
                subtitles.push({
                    url: match[1],
                    label: match[2] || "Unknown"
                });
                console.log(`[DEBUG] Found subtitle: ${match[1]}`);
            }
        }
    }
    
    return subtitles;
}

// ============================================================
// FIND PROVIDER "UNKNOWN" (OLD LOGIC)
// ============================================================

function findUnknownSource(obj) {
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const result = findUnknownSource(item);
            if (result) return result;
        }
        return null;
    }

    if (obj && typeof obj === "object") {
        if (
            obj.provider === "unknown" &&
            typeof obj.src === "string" &&
            /^https?:\/\//i.test(obj.src)
        ) {
            return obj.src;
        }

        for (const value of Object.values(obj)) {
            const result = findUnknownSource(value);
            if (result) return result;
        }
    }

    return null;
}

// ============================================================
// BASE-62 UNPACKER (OLD LOGIC)
// ============================================================

function unpack(p, a, c, k) {
    const baseUnpack = (num, radix) => {
        const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        return (num < radix ? "" : baseUnpack(Math.floor(num / radix), radix)) +
               ((num %= radix) > 35 ? String.fromCharCode(num + 29) : num.toString(36));
    };

    while (c--) {
        if (k[c]) {
            const token = baseUnpack(c, a);
            const regex = new RegExp("\\b" + token + "\\b", "g");
            p = p.replace(regex, k[c]);
        }
    }
    return p;
}

// ============================================================
// FIND & PARSE PACKED SCRIPT (OLD LOGIC)
// ============================================================

function findPackedScript(html) {
    console.log("[DEBUG] Searching for packed script in HTML...");
    
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
        const text = match[1];
        if (text && /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k/i.test(text)) {
            console.log("[DEBUG] Found packed script in script tag.");
            return text;
        }
    }

    const rawMatch = html.match(/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k[\s\S]*?\}\s*\([\s\S]*?\)\s*\)/i);
    if (rawMatch) {
        console.log("[DEBUG] Found packed script in raw HTML fallback.");
        return rawMatch[0];
    }

    console.log("[DEBUG] Failed to locate packed script. HTML Sample:", html.slice(0, 300));
    return null;
}

function decodePackedScript(jsCode) {
    console.log("[PACKER] Decoding packed script block...");

    const evalMatch = jsCode.match(/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k[\s\S]*?\}\s*\(\s*(['"][\s\S]*?['"])\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"][\s\S]*?['"])\s*\.\s*split\(['"]\|['"]\)/i);

    if (!evalMatch) {
        console.error("[PACKER ERROR] Failed to match standard parameter structure. Full script snippet:", jsCode.slice(0, 300));
        throw new Error("Could not locate packed-script parameters structure.");
    }

    let packedRaw = evalMatch[1];
    const radix = parseInt(evalMatch[2], 10);
    const count = parseInt(evalMatch[3], 10);
    let dictRaw = evalMatch[4];

    const packed = packedRaw.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
    const dictionary = dictRaw.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"').split("|");

    console.log("[PACKER] Successfully extracted parameters:");
    console.log(" -> Radix:", radix);
    console.log(" -> Token count:", count);
    console.log(" -> Dictionary size:", dictionary.length);
    console.log(" -> Packed payload length:", packed.length);

    const decoded = unpack(packed, radix, count, dictionary);
    console.log("[PACKER] Decoded output length:", decoded.length);
    console.log("[PACKER] Decoded snippet:", decoded.slice(0, 300));

    return decoded;
}

// ============================================================
// EXTRACT HLS / SOURCES (OLD LOGIC)
// ============================================================

function extractHls2(decoded) {
    console.log("[DEBUG] Extracting stream URL from decoded script...");

    const patterns = [
        /"hls2"\s*:\s*"([^"]+)"/i,
        /'hls2'\s*:\s*'([^']+)'/i,
        /hls2\s*[:=]\s*["']([^"']+)["']/i,
        /"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/i,
        /'file'\s*:\s*'([^']+\.m3u8[^']*)'/i,
        /file\s*:\s*["']([^"']+)["']/i
    ];

    for (const pattern of patterns) {
        const match = decoded.match(pattern);
        if (match) {
            console.log("[DEBUG] Found match with pattern:", pattern);
            return match[1];
        }
    }

    return null;
}

// ============================================================
// NEW IQSMARTGAMES FLOW
// ============================================================

async function fetchPage(url, referer = null) {
    console.log(`[DEBUG] Fetching page: ${url}`);
    
    const headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    };
    
    if (referer) {
        headers["Referer"] = referer;
    }
    
    const response = await fetch(url, {
        method: "GET",
        headers
    });
    
    if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    
    const html = await response.text();
    console.log(`[DEBUG] Page fetched. Size: ${html.length} bytes`);
    return html;
}

async function extractFullPlayerData({ id, type, season, episode }) {
    console.log(`[START] Extracting from iqsmartgames - ID: ${id}, Type: ${type}, Season: ${season}, Episode: ${episode}`);
    
    try {
        // Step 1: Request iqsmartgames embed page
        let embedUrl;
        if (type === "tv") {
            embedUrl = `${IQSMARTGAMES_API}/tv/${id}/${season}/${episode}?key=e11a7debaaa4f5d25b671706ffe4d2acb56efbd4`;
        } else {
            embedUrl = `${IQSMARTGAMES_API}/movie/${id}?key=e11a7debaaa4f5d25b671706ffe4d2acb56efbd4`;
        }
        
        console.log(`[STEP 1] Requesting: ${embedUrl}`);
        const embedHtml = await fetchPage(embedUrl);
        
        // Step 2: Extract first iframe from player-container
        console.log("[STEP 2] Extracting iframe from player-container...");
        const proIframeUrl = extractIframeFromContainer(embedHtml, "player-container");
        if (!proIframeUrl) throw new Error("Could not extract pro.iqsmartgames iframe from player-container");
        
        const proUrl = proIframeUrl.startsWith("http") ? proIframeUrl : `https://${proIframeUrl}`;
        console.log(`[STEP 2] Extracted pro iframe: ${proUrl}`);
        
        // Step 3: Request pro.iqsmartgames page
        console.log("[STEP 3] Requesting pro.iqsmartgames player page...");
        const proHtml = await fetchPage(proUrl, embedUrl);
        
        // Step 4: Extract second iframe from videoPlayer div
        console.log("[STEP 4] Extracting iframe from videoPlayer...");
        const playerIframeUrl = extractIframeFromContainer(proHtml, "videoPlayer");
        if (!playerIframeUrl) throw new Error("Could not extract video player iframe from videoPlayer div");
        
        const playerUrl = playerIframeUrl.startsWith("http") ? playerIframeUrl : `https://${playerIframeUrl}`;
        console.log(`[STEP 4] Extracted player iframe: ${playerUrl}`);
        
        // Step 5: Request final video player page
        console.log("[STEP 5] Requesting final video player page...");
        const playerHtml = await fetchPage(playerUrl, proUrl);
        
        // Step 6: Extract all video server links
        console.log("[STEP 6] Extracting video server links...");
        const videoServers = extractVideoServerLinks(playerHtml);
        if (videoServers.length === 0) {
            throw new Error("No video servers found in player page");
        }
        
        // Step 7: Extract subtitles/hls4
        console.log("[STEP 7] Extracting subtitles and additional streams...");
        const subtitles = extractSubtitles(playerHtml);
        
        // Step 8: Find primary stream (STREAMHG is marked as active)
        const primaryServer = videoServers.find(s => s.isActive) || videoServers[0];
        
        console.log(`[SUCCESS] Extracted ${videoServers.length} video servers`);
        console.log(`[PRIMARY] Using: ${primaryServer.name} (${primaryServer.sourceKey})`);
        
        return {
            id,
            type,
            season,
            episode,
            source: embedUrl,
            proPlayerUrl: proUrl,
            videoPlayerUrl: playerUrl,
            primaryServer: {
                name: primaryServer.name,
                link: primaryServer.link,
                sourceKey: primaryServer.sourceKey
            },
            allServers: videoServers,
            subtitles,
            hls2: primaryServer.link, // For backwards compatibility
            referer: proUrl,
            extractedAt: new Date().toISOString()
        };
        
    } catch (error) {
        console.error("[EXTRACTION ERROR]", error.message);
        throw error;
    }
}

// ============================================================
// OLD HLS PROXY FLOW (KEPT FOR BACKWARDS COMPATIBILITY)
// ============================================================

function makeAbsoluteUrl(value, sourceUrl) {
    try {
        return new URL(value, sourceUrl).href;
    } catch (_) {
        return value;
    }
}

async function getDynamicSource({ id, type, season, episode }) {
    const params = new URLSearchParams({ id, type });
    if (type === "tv") {
        params.set("s", String(season));
        params.set("e", String(episode));
    }

    const apiUrl = `${HLS_API}?${params.toString()}`;
    console.log("[DEBUG] Requesting HLS API:", apiUrl);

    const response = await fetch(apiUrl, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
    });

    if (!response.ok) throw new Error(`HLS API returned HTTP ${response.status}`);

    const data = await response.json();
    console.log("[DEBUG] HLS API returned JSON:", JSON.stringify(data).slice(0, 200));

    const source = findUnknownSource(data);
    if (!source) throw new Error("No provider='unknown' source found in response.");

    console.log("[DEBUG] Resolved target player page source URL:", source);
    return source;
}

async function fetchSourcePage(sourceUrl) {
    const parsed = new URL(sourceUrl);
    const referer = `${parsed.protocol}//${parsed.host}/`;

    console.log("[DEBUG] Fetching player HTML page from:", sourceUrl);

    const response = await fetch(sourceUrl, {
        method: "GET",
        headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": referer
        }
    });

    if (!response.ok) throw new Error(`Source page returned HTTP ${response.status}`);

    const html = await response.text();
    console.log("[DEBUG] Source HTML fetched. Size:", html.length, "bytes.");
    return { html, referer };
}

async function extractSource({ id, type, season, episode }) {
    const sourceUrl = await getDynamicSource({ id, type, season, episode });
    const { html, referer } = await fetchSourcePage(sourceUrl);

    const packedScript = findPackedScript(html);
    if (!packedScript) throw new Error("Packed JWPlayer script was not found in page HTML.");

    const decoded = decodePackedScript(packedScript);
    const rawHls2 = extractHls2(decoded);

    if (!rawHls2) throw new Error("No hls2 or file stream field was found in unpacked script.");

    const hls2 = makeAbsoluteUrl(rawHls2, sourceUrl);
    console.log("[DEBUG] Final resolved stream URL:", hls2);

    return { source: sourceUrl, referer, hls2 };
}

// ============================================================
// VERCEL HANDLER
// ============================================================

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

    try {
        const { id, type = "tv", s, e, source = "iqsmartgames" } = req.query;

        if (!id) return res.status(400).json({ ok: false, error: "Missing required parameter: id" });
        if (type !== "tv" && type !== "movie") return res.status(400).json({ ok: false, error: "type must be tv or movie" });

        let season = null, episode = null;
        if (type === "tv") {
            if (s === undefined || e === undefined) {
                return res.status(400).json({ ok: false, error: "TV requires s and e" });
            }
            season = Number(s);
            episode = Number(e);
            if (!Number.isInteger(season) || !Number.isInteger(episode)) {
                return res.status(400).json({ ok: false, error: "s and e must be integers" });
            }
        }

        console.log(`[START] Extraction - ID: ${id}, Type: ${type}, Source: ${source}, Season: ${season}, Episode: ${episode}`);

        let result;
        
        // Route to appropriate extraction method
        if (source === "iqsmartgames") {
            result = await extractFullPlayerData({ id, type, season, episode });
        } else if (source === "hls" || source === "hlsproxy") {
            result = await extractSource({ id, type, season, episode });
        } else {
            return res.status(400).json({ 
                ok: false, 
                error: "Invalid source. Use 'iqsmartgames' or 'hls'" 
            });
        }

        return res.status(200).json({
            ok: true,
            ...result
        });
        
    } catch (error) {
        console.error("[SOURCE ERROR]", error.message);
        return res.status(500).json({
            ok: false,
            error: error?.message || "Extraction failed"
        });
    }
}
