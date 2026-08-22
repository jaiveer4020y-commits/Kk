export const config = {
    runtime: "nodejs"
};

const HLS_API = "https://hls-proxy.vercel.app/api";

const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 10; K) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";

// ============================================================
// FIND PROVIDER "UNKNOWN"
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
// BASE-62 UNPACKER
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
// FIND & PARSE PACKED SCRIPT
// ============================================================

function findPackedScript(html) {
    console.log("[DEBUG] Searching for packed script in HTML...");
    
    // 1. Check <script> tags
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
        const text = match[1];
        if (text && /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k/i.test(text)) {
            console.log("[DEBUG] Found packed script in script tag.");
            return text;
        }
    }

    // 2. Fallback to raw HTML regex search
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

    // Matches the core payload arguments inside eval(function(p,a,c,k,e,d){...}(...))
    const evalMatch = jsCode.match(/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k[\s\S]*?\}\s*\(\s*(['"][\s\S]*?['"])\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"][\s\S]*?['"])\s*\.\s*split\(['"]\|['"]\)/i);

    if (!evalMatch) {
        console.error("[PACKER ERROR] Failed to match standard parameter structure. Full script snippet:", jsCode.slice(0, 300));
        throw new Error("Could not locate packed-script parameters structure.");
    }

    let packedRaw = evalMatch[1];
    const radix = parseInt(evalMatch[2], 10);
    const count = parseInt(evalMatch[3], 10);
    let dictRaw = evalMatch[4];

    // Clean leading/trailing quotes safely
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
// EXTRACT HLS / SOURCES
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
        const { id, type = "tv", s, e } = req.query;

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

        console.log(`[START] Extracting source for ID: ${id}, Type: ${type}, Season: ${season}, Episode: ${episode}`);

        const result = await extractSource({ id, type, season, episode });

        return res.status(200).json({
            ok: true,
            id,
            type,
            season,
            episode,
            source: result.source,
            hls2: result.hls2,
            referer: result.referer
        });
    } catch (error) {
        console.error("[SOURCE ERROR]", error.message);
        return res.status(500).json({
            ok: false,
            error: error?.message || "Extraction failed"
        });
    }
}
