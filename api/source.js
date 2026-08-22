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
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
        const text = match[1];
        if (text && /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k/i.test(text)) {
            return text;
        }
    }

    const rawMatch = html.match(/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k[\s\S]*?\}\s*\([\s\S]*?\)\s*\)/i);
    if (rawMatch) return rawMatch[0];

    return null;
}

function decodePackedScript(jsCode) {
    console.log("[PACKER] Packed JWPlayer script found");

    const evalMatch = jsCode.match(/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k[\s\S]*?\}\s*\(([\s\S]*?)\)\s*\)/i);

    if (!evalMatch) {
        throw new Error("Could not locate packed-script arguments.");
    }

    const argsString = evalMatch[1].trim();
    let packed, radix, count, dictionary;

    try {
        const parsedArgs = new Function(`return [${argsString}];`)();
        packed = parsedArgs[0];
        radix = parseInt(parsedArgs[1], 10);
        count = parseInt(parsedArgs[2], 10);
        dictionary = Array.isArray(parsedArgs[3])
            ? parsedArgs[3]
            : String(parsedArgs[3]).split("|");
    } catch (e) {
        throw new Error("Could not identify packed-script parameters: " + e.message);
    }

    console.log("[PACKER] Radix:", radix, "| Token count:", count);

    const decoded = unpack(packed, radix, count, dictionary);
    console.log("[PACKER] Decoded size:", decoded.length);

    return decoded;
}

// ============================================================
// EXTRACT HLS / SOURCES
// ============================================================

function extractHls2(decoded) {
    const patterns = [
        /"hls2"\s*:\s*"([^"]+)"/i,
        /'hls2'\s*:\s*'([^']+)'/i,
        /hls2\s*[:=]\s*["']([^"']+)["']/i,
        /"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/i,
        /'file'\s*:\s*'([^']+\.m3u8[^']*)'/i
    ];

    for (const pattern of patterns) {
        const match = decoded.match(pattern);
        if (match) return match[1];
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
    const response = await fetch(apiUrl, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
    });

    if (!response.ok) throw new Error(`HLS API returned HTTP ${response.status}`);

    const data = await response.json();
    const source = findUnknownSource(data);
    if (!source) throw new Error("No provider='unknown' source found.");

    return source;
}

async function fetchSourcePage(sourceUrl) {
    const parsed = new URL(sourceUrl);
    const referer = `${parsed.protocol}//${parsed.host}/`;

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
    return { html, referer };
}

async function extractSource({ id, type, season, episode }) {
    const sourceUrl = await getDynamicSource({ id, type, season, episode });
    const { html, referer } = await fetchSourcePage(sourceUrl);

    const packedScript = findPackedScript(html);
    if (!packedScript) throw new Error("Packed JWPlayer script was not found.");

    const decoded = decodePackedScript(packedScript);
    const rawHls2 = extractHls2(decoded);

    if (!rawHls2) throw new Error("No hls2 field was found.");

    const hls2 = makeAbsoluteUrl(rawHls2, sourceUrl);

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
        console.error("[SOURCE ERROR]", error);
        return res.status(500).json({
            ok: false,
            error: error?.message || "Extraction failed"
        });
    }
}
