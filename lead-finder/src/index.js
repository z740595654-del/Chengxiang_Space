const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (url.pathname === "/api/leads") {
            if (request.method !== "GET") {
                return jsonResponse({ ok: false, message: "Method not allowed" }, 405);
            }
            return handleLeads(url, env);
        }

        return jsonResponse({ ok: false, message: "Not found" }, 404);
    },
};

async function handleLeads(url, env) {
    const query = url.searchParams.get("q")?.trim();
    const country = url.searchParams.get("country")?.trim() || "";
    const limit = clampLimit(url.searchParams.get("limit"));

    if (!query) {
        return jsonResponse({ ok: false, message: "缺少 q 参数" }, 400);
    }

    if (!env.GOOGLE_API_KEY || !env.GOOGLE_CSE_ID) {
        return jsonResponse({ ok: false, message: "缺少 Google API 配置" }, 500);
    }

    try {
        const items = await searchGoogle(query, limit, env);
        const results = [];

        for (const item of items) {
            const parsed = await transformResult(item, country);
            if (parsed) {
                results.push(parsed);
            }
        }

        return jsonResponse({ ok: true, results });
    } catch (err) {
        console.error("Lead finder error", err);
        return jsonResponse({ ok: false, message: err.message || "服务异常" }, 500);
    }
}

function clampLimit(rawLimit) {
    const num = parseInt(rawLimit, 10);
    if (Number.isNaN(num)) return 10;
    return Math.max(1, Math.min(num, 20));
}

async function searchGoogle(query, limit, env) {
    const searchUrl = new URL("https://www.googleapis.com/customsearch/v1");
    searchUrl.searchParams.set("key", env.GOOGLE_API_KEY);
    searchUrl.searchParams.set("cx", env.GOOGLE_CSE_ID);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("num", String(limit));

    const resp = await fetch(searchUrl);
    if (!resp.ok) {
        throw new Error(`Google API 返回 ${resp.status}`);
    }
    const data = await resp.json();
    return data.items || [];
}

async function transformResult(item, country) {
    if (!item?.link) return null;

    let website = "";
    let origin = "";
    try {
        const url = new URL(item.link);
        website = url.hostname;
        origin = url.origin;
    } catch {
        return null;
    }

    const company = (item.title || "").trim() || website;
    const pages = buildPageList(origin, item.link);
    const { email, phone } = await scrapeContacts(pages);

    return {
        country,
        company,
        website,
        city: "",
        phone,
        email,
        sourceUrl: item.link,
    };
}

function buildPageList(origin, rawLink) {
    const candidates = [rawLink];
    const commonPaths = ["/", "/contact", "/contact-us", "/about", "/about-us"]; 
    for (const path of commonPaths) {
        candidates.push(`${origin}${path}`);
    }
    return Array.from(new Set(candidates));
}

async function scrapeContacts(urls) {
    let email = "";
    let phone = "";
    let visited = 0;

    for (const link of urls) {
        if (visited >= 2 || (email && phone)) break;
        try {
            const res = await fetch(link, { method: "GET" });
            if (!res.ok) continue;
            const contentType = res.headers.get("content-type") || "";
            if (!contentType.includes("text/html")) continue;
            const html = await res.text();
            visited += 1;
            if (!email) email = extractEmail(html);
            if (!phone) phone = extractPhone(html);
        } catch (err) {
            console.warn("fetch page failed", link, err);
        }
    }

    return { email, phone };
}

function extractEmail(text) {
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const match = text.match(emailRegex);
    return match?.[0] || "";
}

function extractPhone(text) {
    const phoneRegex = /\+?\d[\d\s().-]{6,}\d/g;
    const match = text.match(phoneRegex);
    if (!match || !match.length) return "";
    return match[0].trim();
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json;charset=utf-8",
        },
    });
}
