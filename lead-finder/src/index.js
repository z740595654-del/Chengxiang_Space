const CORS_HEADERS = Object.freeze({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
});

const DEALER_SCORE_THRESHOLD = 35;
const NON_EN_DEALER_THRESHOLD = 28;
const SEARCH_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_ENRICH_CONCURRENCY = 3;

// OEM 主站后缀黑名单（只做后缀匹配，避免误杀经销商子域）
const OEM_BLOCKLIST_SUFFIXES = [
    ".hyster.com",
    ".hyster-yale.com",
    ".toyotaforklift.com",
    ".toyotaforklifts.com",
    ".toyotamaterialhandling.com",
    ".jungheinrich.com",
    ".jungheinrich.cn",
    ".crown.com",
    ".linde-mh.com",
    ".linde-mh.cn",
    ".still.de",
    ".still.com",
    ".komatsu.com",
    ".logisnext.com",
    ".mitsubishi-logisnext.com",
    ".hyundai-ce.com",
    ".doosan.com",
    ".kalmarglobal.com",
];

const OEM_KEYWORDS = [
    "hyster",
    "toyota",
    "jungheinrich",
    "crown",
    "linde",
    "still",
    "komatsu",
    "mitsubishi",
    "hyundai",
    "doosan",
    "kalmar",
];

const CHANNEL_TEMPLATES = {
    en: [
        "forklift dealer",
        "material handling dealer",
        "mhe distributor",
        "forklift rental",
        "forklift sales and service",
        "used forklift",
        "forklift parts",
        "warehouse equipment distributor",
    ],
    es: [
        "distribuidor de montacargas",
        "concesionario de montacargas",
        "alquiler de montacargas",
        "venta y servicio de montacargas",
        "carretillas elevadoras distribuidor",
    ],
    pt: [
        "revendedor de empilhadeiras",
        "distribuidor de empilhadeira",
        "locação de empilhadeiras",
        "venda e assistência técnica",
        "peças empilhadeira",
    ],
    de: [
        "Gabelstapler Händler",
        "Vertriebspartner",
        "Mietstapler",
        "Service Gabelstapler",
        "Gabelstapler Ersatzteile",
    ],
    fr: [
        "concessionnaire chariots élévateurs",
        "distributeur manutention",
        "location chariots élévateurs",
        "vente et service",
        "pièces chariots élévateurs",
    ],
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (request.method === "GET") {
            if (url.pathname === "/api/leads" || url.pathname === "/leads") {
                return handleLeads(url, env);
            }
            if (url.pathname === "/enrich") {
                return handleEnrich(url);
            }
        }

        return jsonResponse({ ok: false, message: "Not found" }, 404);
    },
};

function normalizeCountryName(countryRaw) {
    return (countryRaw || "").trim();
}

function resolveLang(countryRaw, langParam) {
    const country = normalizeCountryName(countryRaw).toLowerCase();
    if (langParam && langParam !== "auto") return langParam;

    const esCountries = ["spain", "mexico", "chile", "argentina", "colombia", "peru"];
    const ptCountries = ["brazil", "portugal"];
    const deCountries = ["germany", "austria", "switzerland"];
    const frCountries = ["france"];

    if (esCountries.some((c) => country.includes(c))) return "es";
    if (ptCountries.some((c) => country.includes(c))) return "pt";
    if (deCountries.some((c) => country.includes(c))) return "de";
    if (frCountries.some((c) => country.includes(c))) return "fr";
    return "en";
}

async function handleLeads(url, env) {
    const query = (url.searchParams.get("q") ?? url.searchParams.get("keyword") ?? "").trim();
    if (!query) return jsonResponse({ ok: false, message: "缺少 q/keyword" }, 400);

    const country = normalizeCountryName(url.searchParams.get("country"));
    const limit = clampLimit(url.searchParams.get("limit") ?? url.searchParams.get("num"));
    const start = clampStart(url.searchParams.get("start"));
    const mode = (url.searchParams.get("mode") || "dealer").toLowerCase();
    const langParam = (url.searchParams.get("lang") || "auto").toLowerCase();
    const enrichEnabled = (url.searchParams.get("enrich") || "0") === "1";
    const lang = resolveLang(country, langParam);
    const scoreThreshold =
        mode === "dealer"
            ? lang === "en"
                ? DEALER_SCORE_THRESHOLD
                : NON_EN_DEALER_THRESHOLD
            : 0;

    // 手测建议：/api/leads?q=forklift&country=Spain&limit=10&mode=dealer&lang=auto&enrich=0

    if (!env.GOOGLE_API_KEY || !env.GOOGLE_CSE_ID) {
        return jsonResponse({ ok: false, message: "缺少 Google API 配置" }, 500);
    }

    const searchQueries = buildQueries(query, country, lang, mode);

    try {
        const rawItems = await performSearch(searchQueries, limit, start, env);
        const transformed = [];
        const meta = {
            totalItems: rawItems.length,
            uniqueDomains: 0,
            filteredByBlacklist: 0,
            filteredByScore: 0,
            kept: 0,
        };

        for (const item of rawItems) {
            const parsed = await transformResult(item, country, mode);
            if (!parsed) continue;
            if (parsed.blocked) {
                meta.filteredByBlacklist += 1;
                continue;
            }
            const lead = parsed.lead;
            if (mode === "dealer" && lead.score < scoreThreshold) {
                meta.filteredByScore += 1;
                continue;
            }
            transformed.push(lead);
        }

        let results = transformed.slice(0, limit);

        if (enrichEnabled && results.length) {
            results = await enrichBatch(results, lang, country);
        }

        meta.kept = results.length;
        meta.uniqueDomains = new Set(
            results
                .map((r) => (r.website || "").toLowerCase())
                .filter((v) => v)
        ).size;

        return jsonResponse({ ok: true, results, meta });
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

function clampStart(rawStart) {
    const num = parseInt(rawStart, 10);
    if (Number.isNaN(num) || num < 1) return undefined;
    return num;
}

function buildQueries(userQuery, country, lang, mode) {
    const suffix = country ? ` ${country}` : "";
    if (mode !== "dealer") return [`${userQuery}${suffix}`.trim()];

    const templates = CHANNEL_TEMPLATES[lang] || CHANNEL_TEMPLATES.en;
    const orPart = templates.map((t) => `"${t}"`).join(" OR ");
    return [`(${orPart}) ${userQuery}${suffix}`.trim()];
}

async function performSearch(queries, limit, start, env) {
    const tasks = [];
    const firstBatch = Math.min(limit, 10);
    const secondBatch = limit > 10 ? Math.min(limit - 10, 10) : 0;

    const startOffset = start || 1;
    for (const q of queries) {
        tasks.push(cseFetch(q, startOffset, firstBatch, env));
        if (secondBatch > 0) {
            tasks.push(cseFetch(q, startOffset + 10, secondBatch, env));
        }
    }

    const all = await Promise.all(tasks);
    return all.flat();
}

async function cseFetch(query, start, num, env) {
    const searchUrl = new URL("https://www.googleapis.com/customsearch/v1");
    searchUrl.searchParams.set("key", env.GOOGLE_API_KEY);
    searchUrl.searchParams.set("cx", env.GOOGLE_CSE_ID);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("num", String(Math.min(num, 10)));
    searchUrl.searchParams.set("start", String(start));

    const resp = await fetchWithTimeout(searchUrl.toString(), { method: "GET" }, SEARCH_TIMEOUT_MS);
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Google API 返回 ${resp.status} ${text.slice(0, 100)}`);
    }
    const data = await resp.json();
    return Array.isArray(data.items) ? data.items : [];
}

async function transformResult(item, country, mode) {
    if (!item?.link) return null;
    let website = "";
    let origin = "";
    try {
        const url = new URL(item.link);
        website = url.hostname;
        origin = url.origin;
        if (isBlockedDomain(website)) return { blocked: true };
    } catch {
        return null;
    }

    const company = (item.title || "").trim() || website.replace(/^www\./, "");
    const description = `${item.title || ""} ${item.snippet || ""} ${item.displayLink || ""}`;
    const score = computeScore(description, website, mode);
    const tags = deriveTags(description);

    return {
        lead: {
            country,
            company,
            website,
            city: "",
            phone: "",
            email: "",
            sourceUrl: item.link,
            score,
            tags,
            meta: { origin },
        },
    };
}

function isBlockedDomain(hostname) {
    const host = hostname.toLowerCase().replace(/^www\./, "");
    return OEM_BLOCKLIST_SUFFIXES.some((suffix) => {
        const cleanSuffix = suffix.replace(/^\./, "");
        return host === cleanSuffix || host.endsWith(suffix);
    });
}

function computeScore(text, website, mode) {
    const lower = text.toLowerCase();
    const hostLower = website.toLowerCase();
    let score = 10;

    const positive = [
        "dealer",
        "distributor",
        "rental",
        "service",
        "parts",
        "used forklift",
        "warehouse",
        // ES
        "concesionario",
        "distribuidor",
        "alquiler",
        "servicio",
        "repuestos",
        "montacargas",
        "carretillas elevadoras",
        // PT
        "revendedor",
        "distribuidor",
        "locação",
        "assistência",
        "peças",
        "empilhadeira",
        "empilhadeiras",
        // DE
        "händler",
        "miet",
        "service",
        "ersatzteile",
        "gabelstapler",
        // FR
        "concessionnaire",
        "location",
        "pièces",
        "chariots élévateurs",
    ];
    for (const kw of positive) {
        if (lower.includes(kw)) score += 12;
    }

    const forkliftTerms = [
        "forklift",
        "mhe",
        "montacargas",
        "carretillas elevadoras",
        "empilhadeira",
        "empilhadeiras",
        "gabelstapler",
        "chariots élévateurs",
    ];
    if (forkliftTerms.some((kw) => lower.includes(kw))) score += 15;
    if (lower.includes("contact") || lower.includes("contacto") || lower.includes("kontakt")) score += 6;

    const oemHit = OEM_KEYWORDS.some((kw) => hostLower.includes(kw) || lower.includes(kw));
    if (oemHit) {
        score -= 28;
    }

    if (mode === "dealer") score += 5;

    return Math.max(0, Math.min(100, score));
}

function deriveTags(text) {
    const lower = text.toLowerCase();
    const tags = [];
    if (lower.includes("dealer") || lower.includes("concesionario") || lower.includes("distributor")) {
        tags.push("dealer");
    }
    if (lower.includes("rental") || lower.includes("alquiler") || lower.includes("locação") || lower.includes("miet")) {
        tags.push("rental");
    }
    if (lower.includes("service") || lower.includes("servicio") || lower.includes("service")) {
        tags.push("service");
    }
    if (lower.includes("parts") || lower.includes("pieza") || lower.includes("peças")) {
        tags.push("parts");
    }
    return Array.from(new Set(tags));
}

async function enrichBatch(results, lang, country) {
    const enriched = [...results];
    const queue = enriched.map((_, idx) => idx);
    const workers = [];

    const runner = async () => {
        while (queue.length) {
            const idx = queue.shift();
            if (idx === undefined) return;
            const lead = enriched[idx];
            try {
                const detail = await enrichSingle(lead.website, lang, country);
                enriched[idx] = { ...lead, ...detail };
            } catch (err) {
                console.warn("enrich failed", lead.website, err);
            }
        }
    };

    for (let i = 0; i < MAX_ENRICH_CONCURRENCY; i += 1) {
        workers.push(runner());
    }
    await Promise.all(workers);
    return enriched;
}

async function handleEnrich(url) {
    const website = (url.searchParams.get("website") || "").trim();
    if (!website) return jsonResponse({ ok: false, message: "缺少 website" }, 400);
    const langParam = (url.searchParams.get("lang") || "en").toLowerCase();
    const country = normalizeCountryName(url.searchParams.get("country"));
    const lang = resolveLang(country, langParam);

    try {
        const detail = await enrichSingle(website, lang, country);
        return jsonResponse({ ok: true, result: detail, ...detail });
    } catch (err) {
        console.error("enrich error", err);
        return jsonResponse({ ok: false, message: err.message || "enrich failed" }, 500);
    }
}

function buildEnrichPaths(lang) {
    const base = ["/", "/contact", "/contact-us", "/about", "/about-us"];
    const localized = {
        es: ["/contacto", "/contactenos", "/acerca", "/acerca-de"],
        pt: ["/contato", "/fale-conosco"],
        de: ["/kontakt", "/uber-uns"],
        fr: ["/contact", "/a-propos"],
    };
    return base.concat(localized[lang] || []);
}

async function enrichSingle(website, lang, country) {
    const host = website.startsWith("http") ? website : `https://${website}`;
    const origin = safeOrigin(host);
    const paths = buildEnrichPaths(lang);
    const candidates = paths.map((p) => `${origin}${p}`);

    let email = "";
    let phone = "";
    let visited = 0;

    for (const url of candidates) {
        if (visited >= 4 || (email && phone)) break;
        try {
            const html = await fetchHtml(url);
            visited += 1;
            if (!email) email = extractEmail(html);
            if (!phone) phone = extractPhone(html);
        } catch (err) {
            console.warn("fetch contact failed", url, err);
        }
    }

    const emailScore = scoreEmail(email);
    const phoneScore = scorePhone(phone, country);

    return { email, phone, emailScore, phoneScore };
}

function safeOrigin(input) {
    try {
        const url = new URL(input);
        return `${url.protocol}//${url.hostname}`;
    } catch {
        return `https://${input}`;
    }
}

async function fetchHtml(url) {
    const resp = await fetchWithTimeout(url, { method: "GET", headers: { Accept: "text/html,*/*" } }, FETCH_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
        const snippet = await resp.text();
        return snippet;
    }
    return resp.text();
}

function extractEmail(text) {
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const match = text.match(emailRegex);
    if (!match || !match.length) return "";
    return match[0];
}

function extractPhone(text) {
    const phoneRegex = /\+?\d[\d\s().-]{6,}\d/g;
    const match = text.match(phoneRegex);
    if (!match || !match.length) return "";
    const first = match.find((v) => {
        const digits = v.replace(/\D/g, "");
        return digits.length >= 7 && digits.length <= 20;
    });
    return (first || "").trim();
}

function scoreEmail(email) {
    if (!email) return 0;
    if (email.endsWith("example.com")) return 10;
    if (email.includes("info@")) return 50;
    if (email.includes("sales") || email.includes("contact")) return 70;
    return 60;
}

function scorePhone(phone, country) {
    if (!phone) return 0;
    const digits = phone.replace(/\D/g, "");
    let score = digits.length >= 10 ? 70 : 50;
    if (country && phone.includes(country.substring(0, 3))) score += 5;
    return Math.min(90, score);
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(id);
    }
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json;charset=utf-8", ...CORS_HEADERS },
    });
}
