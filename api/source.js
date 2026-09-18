export const config = {
    runtime: "nodejs"
};

const IQSMARTGAMES_API = "https://streams.iqsmartgames.com/embed";

const IQ_KEY =
    "e11a7debaaa4f5d25b671706ffe4d2acb56efbd4";

const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 10; K) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";

// ============================================================
// FETCH HTML
// ============================================================

async function fetchPage(url, referer = null) {
    console.log(`[FETCH] ${url}`);

    const headers = {
        "User-Agent": USER_AGENT,
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    };

    if (referer) {
        headers.Referer = referer;
    }

    const response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "follow"
    });

    const html = await response.text();

    console.log(
        `[FETCH] HTTP ${response.status} | ${html.length} bytes | ${response.url}`
    );

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} while fetching ${url}`
        );
    }

    return {
        html,
        finalUrl: response.url
    };
}

// ============================================================
// NORMALIZE URL
// ============================================================

function makeAbsoluteUrl(value, baseUrl) {
    if (!value) return null;

    try {
        return new URL(value, baseUrl).href;
    } catch {
        return value;
    }
}

// ============================================================
// EXTRACT iframe#player
//
// Handles:
//
// <iframe id="player" ... src="...">
//
// and:
//
// <iframe src="..." ... id="player">
//
// and single/double quotes.
// ============================================================

function extractPlayerIframe(html, baseUrl) {
    console.log("[IFRAME] Looking for iframe#player");

    // First find every iframe opening tag.
    const iframeRegex = /<iframe\b[^>]*>/gi;

    let match;

    while ((match = iframeRegex.exec(html)) !== null) {
        const tag = match[0];

        // id="player" / id='player'
        const idMatch = tag.match(
            /\bid\s*=\s*["']player["']/i
        );

        if (!idMatch) {
            continue;
        }

        // src="..." / src='...'
        const srcMatch = tag.match(
            /\bsrc\s*=\s*["']([^"']+)["']/i
        );

        if (!srcMatch) {
            console.log(
                "[IFRAME] Found #player but it has no src"
            );

            return null;
        }

        const rawSrc = srcMatch[1].trim();
        const absoluteSrc = makeAbsoluteUrl(
            rawSrc,
            baseUrl
        );

        console.log(
            "[IFRAME] #player:",
            absoluteSrc
        );

        return absoluteSrc;
    }

    console.log(
        "[IFRAME] iframe#player was not found"
    );

    return null;
}

// ============================================================
// FALLBACK: FIRST iframe inside player-container
//
// This is deliberately separate from the primary #player
// extraction so that changes to the surrounding div don't
// break the parser.
// ============================================================

function extractFirstIframeFromPlayerContainer(
    html,
    baseUrl
) {
    console.log(
        "[IFRAME] Trying player-container fallback"
    );

    /*
     * Instead of trying to match nested <div>s, locate the
     * player-container text and then search for the iframe.
     */

    const containerIndex = html.search(
        /class\s*=\s*["'][^"']*\bplayer-container\b[^"']*["']/i
    );

    if (containerIndex === -1) {
        console.log(
            "[IFRAME] player-container class not found"
        );

        return null;
    }

    /*
     * Search a reasonable section following the container.
     * The normal page structure puts the iframe immediately
     * inside this container.
     */

    const section = html.slice(
        containerIndex,
        containerIndex + 10000
    );

    const iframeMatch = section.match(
        /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i
    );

    if (!iframeMatch) {
        console.log(
            "[IFRAME] No iframe found after player-container"
        );

        return null;
    }

    const url = makeAbsoluteUrl(
        iframeMatch[1].trim(),
        baseUrl
    );

    console.log(
        "[IFRAME] player-container iframe:",
        url
    );

    return url;
}

// ============================================================
// EXTRACT ALL IFRAMES
// ============================================================

function extractAllIframes(html, baseUrl) {
    const result = [];

    const iframeRegex = /<iframe\b[^>]*>/gi;

    let match;

    while ((match = iframeRegex.exec(html)) !== null) {
        const tag = match[0];

        const idMatch = tag.match(
            /\bid\s*=\s*["']([^"']+)["']/i
        );

        const srcMatch = tag.match(
            /\bsrc\s*=\s*["']([^"']+)["']/i
        );

        if (!srcMatch) continue;

        result.push({
            id: idMatch ? idMatch[1] : null,
            src: makeAbsoluteUrl(
                srcMatch[1].trim(),
                baseUrl
            ),
            raw: tag
        });
    }

    return result;
}

// ============================================================
// EXTRACT SERVER ITEMS
// ============================================================

function extractVideoServerLinks(html, baseUrl) {
    console.log("[SERVERS] Extracting server metadata");

    const servers = [];

    /*
     * Find each <li ... class="server-item"...>
     *
     * We don't require data-link/data-source-key to appear
     * in a particular attribute order.
     */

    const liRegex =
        /<li\b[^>]*\bclass\s*=\s*["'][^"']*\bserver-item\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi;

    let match;

    while ((match = liRegex.exec(html)) !== null) {
        const block = match[0];

        // data-link
        const linkMatch = block.match(
            /\bdata-link\s*=\s*["']([^"']+)["']/i
        );

        // data-source-key
        const keyMatch = block.match(
            /\bdata-source-key\s*=\s*["']([^"']+)["']/i
        );

        // class
        const classMatch = block.match(
            /\bclass\s*=\s*["']([^"']+)["']/i
        );

        const classes = classMatch
            ? classMatch[1]
            : "";

        const isActive =
            /\bactive\b/i.test(classes);

        /*
         * Try several ways of getting the displayed name.
         */

        let name = null;

        const serverNameMatch = block.match(
            /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bserver-name\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
        );

        if (serverNameMatch) {
            name = serverNameMatch[1]
                .replace(/<[^>]+>/g, "")
                .replace(/\s+/g, " ")
                .trim();
        }

        if (!name) {
            const altMatch = block.match(
                /<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i
            );

            if (altMatch) {
                name = altMatch[1].trim();
            }
        }

        if (!name) {
            name = "Unknown";
        }

        servers.push({
            name,
            link: linkMatch
                ? makeAbsoluteUrl(
                      linkMatch[1].trim(),
                      baseUrl
                  )
                : null,
            sourceKey: keyMatch
                ? keyMatch[1].trim()
                : null,
            isActive
        });
    }

    console.log(
        `[SERVERS] Found ${servers.length} server entries`
    );

    return servers;
}

// ============================================================
// EXTRACT TRACKS / SUBTITLES
// ============================================================

function extractTracks(html, baseUrl) {
    const tracks = [];

    const trackRegex =
        /<track\b[^>]*>/gi;

    let match;

    while ((match = trackRegex.exec(html)) !== null) {
        const tag = match[0];

        const srcMatch = tag.match(
            /\bsrc\s*=\s*["']([^"']+)["']/i
        );

        if (!srcMatch) continue;

        const kindMatch = tag.match(
            /\bkind\s*=\s*["']([^"']+)["']/i
        );

        const labelMatch = tag.match(
            /\blabel\s*=\s*["']([^"']+)["']/i
        );

        const srclangMatch = tag.match(
            /\bsrclang\s*=\s*["']([^"']+)["']/i
        );

        tracks.push({
            src: makeAbsoluteUrl(
                srcMatch[1],
                baseUrl
            ),
            kind: kindMatch
                ? kindMatch[1]
                : null,
            label: labelMatch
                ? labelMatch[1]
                : null,
            srclang: srclangMatch
                ? srclangMatch[1]
                : null
        });
    }

    return tracks;
}

// ============================================================
// IQSMARTGAMES FLOW
// ============================================================

async function extractIqsmartgames({
    id,
    type,
    season,
    episode
}) {
    console.log(
        `[START] IQSMARTGAMES ${type} ${id}`
    );

    // --------------------------------------------------------
    // STEP 1
    // --------------------------------------------------------

    let embedUrl;

    if (type === "tv") {
        embedUrl =
            `${IQSMARTGAMES_API}/tv/` +
            `${encodeURIComponent(id)}/` +
            `${encodeURIComponent(season)}/` +
            `${encodeURIComponent(episode)}` +
            `?key=${IQ_KEY}`;
    } else {
        embedUrl =
            `${IQSMARTGAMES_API}/movie/` +
            `${encodeURIComponent(id)}` +
            `?key=${IQ_KEY}`;
    }

    console.log(
        "[STEP 1] Embed:",
        embedUrl
    );

    const embedResponse =
        await fetchPage(embedUrl);

    const embedHtml =
        embedResponse.html;

    // --------------------------------------------------------
    // DEBUG
    // --------------------------------------------------------

    console.log(
        "[DEBUG] player-container present:",
        /player-container/i.test(embedHtml)
    );

    console.log(
        "[DEBUG] iframe#player present:",
        /<iframe\b[^>]*\bid=["']player["']/i.test(
            embedHtml
        )
    );

    // --------------------------------------------------------
    // STEP 2
    // --------------------------------------------------------
    // PRIMARY METHOD:
    // directly locate iframe#player.
    // --------------------------------------------------------

    console.log(
        "[STEP 2] Extracting iframe#player..."
    );

    let proPlayerUrl =
        extractPlayerIframe(
            embedHtml,
            embedResponse.finalUrl
        );

    // --------------------------------------------------------
    // FALLBACK
    // --------------------------------------------------------

    if (!proPlayerUrl) {
        console.log(
            "[STEP 2] Primary extraction failed."
        );

        proPlayerUrl =
            extractFirstIframeFromPlayerContainer(
                embedHtml,
                embedResponse.finalUrl
            );
    }

    if (!proPlayerUrl) {
        /*
         * Useful diagnostic output.
         */

        const playerIndex =
            embedHtml.search(
                /player-container/i
            );

        if (playerIndex !== -1) {
            console.log(
                "[DEBUG] player-container HTML:"
            );

            console.log(
                embedHtml.slice(
                    Math.max(0, playerIndex - 300),
                    playerIndex + 2500
                )
            );
        }

        throw new Error(
            "Could not extract iframe#player from embed page"
        );
    }

    console.log(
        "[STEP 2] PRO PLAYER:",
        proPlayerUrl
    );

    // --------------------------------------------------------
    // STEP 3
    // --------------------------------------------------------

    console.log(
        "[STEP 3] Requesting PRO player..."
    );

    const proResponse =
        await fetchPage(
            proPlayerUrl,
            embedResponse.finalUrl
        );

    const proHtml =
        proResponse.html;

    // --------------------------------------------------------
    // STEP 4
    // --------------------------------------------------------

    console.log(
        "[STEP 4] Extracting all player iframes..."
    );

    const proIframes =
        extractAllIframes(
            proHtml,
            proResponse.finalUrl
        );

    console.log(
        "[STEP 4] iframe count:",
        proIframes.length
    );

    /*
     * Find vidFrame specifically.
     */

    const vidFrame =
        proIframes.find(
            x => x.id === "vidFrame"
        ) || null;

    /*
     * Also keep every iframe because this is useful when
     * the page changes its markup.
     */

    console.log(
        "[STEP 4] vidFrame:",
        vidFrame
    );

    // --------------------------------------------------------
    // STEP 5
    // --------------------------------------------------------

    console.log(
        "[STEP 5] Extracting server metadata..."
    );

    const servers =
        extractVideoServerLinks(
            proHtml,
            proResponse.finalUrl
        );

    // --------------------------------------------------------
    // STEP 6
    // --------------------------------------------------------

    console.log(
        "[STEP 6] Extracting tracks..."
    );

    const tracks =
        extractTracks(
            proHtml,
            proResponse.finalUrl
        );

    // --------------------------------------------------------
    // RESULT
    // --------------------------------------------------------

    return {
        id,
        type,
        season,
        episode,

        embed: {
            url: embedUrl,
            finalUrl: embedResponse.finalUrl
        },

        proPlayer: {
            url: proPlayerUrl,
            finalUrl: proResponse.finalUrl
        },

        videoPlayer: {
            iframe: vidFrame,
            allIframes: proIframes
        },

        servers,

        activeServer:
            servers.find(
                server => server.isActive
            ) || null,

        tracks,

        metadata: {
            embedHtmlLength:
                embedHtml.length,

            proHtmlLength:
                proHtml.length,

            iframeCount:
                proIframes.length,

            serverCount:
                servers.length,

            trackCount:
                tracks.length
        },

        extractedAt:
            new Date().toISOString()
    };
}

// ============================================================
// VERCEL HANDLER
// ============================================================

export default async function handler(req, res) {
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

    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    if (req.method !== "GET") {
        return res.status(405).json({
            ok: false,
            error: "Method not allowed"
        });
    }

    try {
        const {
            id,
            type = "tv",
            s,
            e
        } = req.query;

        // ----------------------------------------------------
        // VALIDATION
        // ----------------------------------------------------

        if (!id) {
            return res.status(400).json({
                ok: false,
                error:
                    "Missing required parameter: id"
            });
        }

        if (
            type !== "tv" &&
            type !== "movie"
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    "type must be tv or movie"
            });
        }

        let season = null;
        let episode = null;

        if (type === "tv") {
            if (
                s === undefined ||
                e === undefined
            ) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "TV requires s and e"
                });
            }

            season = Number(s);
            episode = Number(e);

            if (
                !Number.isInteger(season) ||
                !Number.isInteger(episode)
            ) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "s and e must be integers"
                });
            }
        }

        console.log(
            "=================================================="
        );

        console.log(
            "[REQUEST]",
            {
                id,
                type,
                season,
                episode
            }
        );

        console.log(
            "=================================================="
        );

        // ----------------------------------------------------
        // EXTRACT
        // ----------------------------------------------------

        const result =
            await extractIqsmartgames({
                id,
                type,
                season,
                episode
            });

        // ----------------------------------------------------
        // RESPONSE
        // ----------------------------------------------------

        return res.status(200).json({
            ok: true,
            ...result
        });

    } catch (error) {
        console.error(
            "[ERROR]",
            error
        );

        return res.status(500).json({
            ok: false,
            error:
                error?.message ||
                "Extraction failed"
        });
    }
}
