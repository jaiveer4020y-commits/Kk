// api/source.js

export const config = {
    runtime: "nodejs"
};


// ============================================================
// CONFIG
// ============================================================

const HLS_API = "https://hls-proxy.vercel.app/api";

const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 10; K) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";


// ============================================================
// FIND provider="unknown"
// ============================================================

function findUnknownSource(obj) {

    if (Array.isArray(obj)) {

        for (const item of obj) {

            const result =
                findUnknownSource(item);

            if (result) {
                return result;
            }
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

            const result =
                findUnknownSource(value);

            if (result) {
                return result;
            }
        }
    }

    return null;
}


// ============================================================
// BASE 36
// ============================================================

function toBase36(number) {

    if (number === 0) {
        return "0";
    }

    const chars =
        "0123456789abcdefghijklmnopqrstuvwxyz";

    let result = "";

    while (number > 0) {

        result =
            chars[number % 36] +
            result;

        number =
            Math.floor(number / 36);
    }

    return result;
}


// ============================================================
// PACKER UNPACKER
// ============================================================

function unpack(p, a, c, k) {

    for (
        let i = c - 1;
        i >= 0;
        i--
    ) {

        if (
            i < k.length &&
            k[i]
        ) {

            const token =
                toBase36(i);

            const escapedToken =
                token.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    "\\$&"
                );

            const regex =
                new RegExp(
                    "\\b" +
                    escapedToken +
                    "\\b",
                    "g"
                );

            p =
                p.replace(
                    regex,
                    k[i]
                );
        }
    }

    return p;
}


// ============================================================
// EXTRACT STRING LITERAL
// ============================================================

function decodeStringLiteral(value) {

    value =
        value.trim();


    if (
        value.length < 2
    ) {
        return value;
    }


    const quote =
        value[0];


    if (
        quote !== '"' &&
        quote !== "'"
    ) {
        return value;
    }


    let body =
        value.slice(
            1,
            -1
        );


    // Basic JavaScript escape handling

    body =
        body.replace(
            /\\x([0-9a-fA-F]{2})/g,
            (_, hex) =>
                String.fromCharCode(
                    parseInt(hex, 16)
                )
        );


    body =
        body.replace(
            /\\u([0-9a-fA-F]{4})/g,
            (_, hex) =>
                String.fromCharCode(
                    parseInt(hex, 16)
                )
        );


    body =
        body.replace(
            /\\n/g,
            "\n"
        );


    body =
        body.replace(
            /\\r/g,
            "\r"
        );


    body =
        body.replace(
            /\\t/g,
            "\t"
        );


    body =
        body.replace(
            /\\(["'\\])/g,
            "$1"
        );


    return body;
}


// ============================================================
// FIND PACKED SCRIPT
// ============================================================

function findPackedScript(html) {

    const scriptRegex =
        /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

    let match;


    while (
        (match =
            scriptRegex.exec(html)) !== null
    ) {

        const text =
            match[1];


        if (
            text &&
            text.includes(
                "eval(function(p,a,c,k,e,d)"
            )
        ) {

            return text;
        }
    }


    return null;
}


// ============================================================
// PARSE PACKED SCRIPT
// ============================================================

// ============================================================
// PARSE PACKED SCRIPT
// ============================================================

function decodePackedScript(jsCode) {
    console.log("[PACKER] Packed JWPlayer script found");

    // Match the eval(function(p,a,c,k,e,d)... payload
    const match = jsCode.match(/eval\(function\(p,a,c,k,e,r\b[\s\S]*?\}\(([\s\S]*?)\)\s*\)?/);

    if (!match) {
        throw new Error("Could not locate packed-script arguments.");
    }

    const argsString = match[1].trim();

    // Parse payload string 'p', radix 'a', count 'c', and dictionary array 'k'
    let packed, radix, count, dictionary;

    // Standard pattern: 'p',a,c,'k'.split('|') or 'p',a,c,k
    const pattern = /^\s*(['"][\s\S]*?['"])\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"][\s\S]*?['"])\s*\.\s*split\(['"]\|['"]\)/;
    const splitMatch = argsString.match(pattern);

    if (splitMatch) {
        packed = decodeStringLiteral(splitMatch[1]);
        radix = parseInt(splitMatch[2], 10);
        count = parseInt(splitMatch[3], 10);
        dictionary = decodeStringLiteral(splitMatch[4]).split("|");
    } else {
        // Fallback: execute argument extraction via dynamic Function evaluation if static regex misses
        try {
            const parsedArgs = new Function(`return [${argsString}];`)();
            packed = parsedArgs[0];
            radix = parseInt(parsedArgs[1], 10);
            count = parseInt(parsedArgs[2], 10);
            dictionary = Array.isArray(parsedArgs[3]) 
                ? parsedArgs[3] 
                : String(parsedArgs[3]).split("|");
        } catch (e) {
            throw new Error("Could not identify packed-script parameters.");
        }
    }

    console.log("[PACKER] Packed length:", packed.length);
    console.log("[PACKER] Radix:", radix);
    console.log("[PACKER] Token count:", count);
    console.log("[PACKER] Dictionary:", dictionary.length);

    const decoded = unpack(packed, radix, count, dictionary);
    console.log("[PACKER] Decoded size:", decoded.length);

    return decoded;
}


// ============================================================
// EXTRACT hls2
// ============================================================

function extractHls2(decoded) {

    const patterns = [

        /"hls2"\s*:\s*"([^"]+)"/i,

        /'hls2'\s*:\s*'([^']+)'/i,

        /hls2\s*[:=]\s*["']([^"']+)["']/i

    ];


    for (
        const pattern of patterns
    ) {

        const match =
            decoded.match(
                pattern
            );


        if (match) {

            return match[1];
        }
    }


    return null;
}


// ============================================================
// RESOLVE RELATIVE URL
// ============================================================

function makeAbsoluteUrl(
    value,
    sourceUrl
) {

    try {

        return new URL(
            value,
            sourceUrl
        ).href;

    } catch (_) {

        return value;
    }
}


// ============================================================
// GET DYNAMIC SOURCE FROM HLS API
// ============================================================

async function getDynamicSource({
    id,
    type,
    season,
    episode
}) {

    const params =
        new URLSearchParams();


    params.set(
        "id",
        id
    );


    params.set(
        "type",
        type
    );


    if (
        type === "tv"
    ) {

        params.set(
            "s",
            String(season)
        );

        params.set(
            "e",
            String(episode)
        );
    }


    const apiUrl =
        `${HLS_API}?${params.toString()}`;


    console.log(
        "[API] Request:",
        apiUrl
    );


    const response =
        await fetch(
            apiUrl,
            {
                method: "GET",

                headers: {
                    "User-Agent":
                        USER_AGENT,

                    "Accept":
                        "application/json"
                }
            }
        );


    if (!response.ok) {

        throw new Error(
            `HLS API returned HTTP ${response.status}`
        );
    }


    const data =
        await response.json();


    console.log(
        "[API] Response type:",
        Array.isArray(data)
            ? "array"
            : typeof data
    );


    const source =
        findUnknownSource(
            data
        );


    if (!source) {

        throw new Error(
            "No provider='unknown' source found."
        );
    }


    console.log(
        "[API] Selected source:",
        source
    );


    return source;
}


// ============================================================
// FETCH SOURCE PAGE
// ============================================================

async function fetchSourcePage(
    sourceUrl
) {

    const parsed =
        new URL(
            sourceUrl
        );


    const referer =
        `${parsed.protocol}//${parsed.host}/`;


    console.log(
        "[SOURCE] Fetching:",
        sourceUrl
    );


    const response =
        await fetch(
            sourceUrl,
            {
                method: "GET",

                headers: {
                    "User-Agent":
                        USER_AGENT,

                    "Accept":
                        "text/html," +
                        "application/xhtml+xml," +
                        "application/xml;q=0.9," +
                        "*/*;q=0.8",

                    "Referer":
                        referer
                }
            }
        );


    if (!response.ok) {

        throw new Error(
            `Source page returned HTTP ${response.status}`
        );
    }


    const html =
        await response.text();


    console.log(
        "[SOURCE] HTML length:",
        html.length
    );


    return {
        html,
        referer
    };
}


// ============================================================
// MAIN EXTRACTION
// ============================================================

async function extractSource({
    id,
    type,
    season,
    episode
}) {

    // --------------------------------------------------------
    // 1. Dynamic source API
    // --------------------------------------------------------

    const sourceUrl =
        await getDynamicSource({
            id,
            type,
            season,
            episode
        });


    // --------------------------------------------------------
    // 2. Fetch selected source
    // --------------------------------------------------------

    const {
        html,
        referer
    } =
        await fetchSourcePage(
            sourceUrl
        );


    // --------------------------------------------------------
    // 3. Find packed JS
    // --------------------------------------------------------

    const packedScript =
        findPackedScript(
            html
        );


    if (!packedScript) {

        throw new Error(
            "Packed JWPlayer script was not found."
        );
    }


    console.log(
        "[PACKER] Script found"
    );


    // --------------------------------------------------------
    // 4. Decode
    // --------------------------------------------------------

    const decoded =
        decodePackedScript(
            packedScript
        );


    // --------------------------------------------------------
    // 5. Extract hls2
    // --------------------------------------------------------

    const rawHls2 =
        extractHls2(
            decoded
        );


    if (!rawHls2) {

        throw new Error(
            "No hls2 field was found."
        );
    }


    const hls2 =
        makeAbsoluteUrl(
            rawHls2,
            sourceUrl
        );


    console.log(
        "[HLS2] Found:",
        hls2
    );


    return {
        source: sourceUrl,
        referer,
        hls2
    };
}


// ============================================================
// VERCEL HANDLER
// ============================================================

export default async function handler(
    req,
    res
) {

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "*"
    );


    if (
        req.method === "OPTIONS"
    ) {

        return res
            .status(204)
            .end();
    }


    if (
        req.method !== "GET"
    ) {

        return res
            .status(405)
            .json({
                ok: false,
                error: "Method not allowed"
            });
    }


    try {

        // ----------------------------------------------------
        // Parameters
        // ----------------------------------------------------

        const {
            id,
            type = "tv",
            s,
            e
        } = req.query;


        if (!id) {

            return res
                .status(400)
                .json({
                    ok: false,
                    error:
                        "Missing required parameter: id"
                });
        }


        if (
            type !== "tv" &&
            type !== "movie"
        ) {

            return res
                .status(400)
                .json({
                    ok: false,
                    error:
                        "type must be tv or movie"
                });
        }


        let season = null;
        let episode = null;


        if (
            type === "tv"
        ) {

            if (
                s === undefined ||
                e === undefined
            ) {

                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            "TV requires s and e"
                    });
            }


            season =
                Number(s);

            episode =
                Number(e);


            if (
                !Number.isInteger(season) ||
                !Number.isInteger(episode)
            ) {

                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            "s and e must be integers"
                    });
            }
        }


        console.log(
            "[SOURCE] Starting extraction:",
            {
                id,
                type,
                season,
                episode
            }
        );


        // ----------------------------------------------------
        // Extraction
        // ----------------------------------------------------

        const result =
            await extractSource({
                id,
                type,
                season,
                episode
            });


        // ----------------------------------------------------
        // Response
        // ----------------------------------------------------

        return res
            .status(200)
            .json({
                ok: true,

                id,

                type,

                season,

                episode,

                source:
                    result.source,

                hls2:
                    result.hls2,

                referer:
                    result.referer
            });


    } catch (error) {

        console.error(
            "[SOURCE ERROR]",
            error
        );


        return res
            .status(500)
            .json({
                ok: false,

                error:
                    error?.message ||
                    "Extraction failed"
            });
    }
}
