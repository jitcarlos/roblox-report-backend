// ROBLOX REPORT :: news backend  (v3)
// Aggregates FREE Roblox news into the article schema the experience expects
// and serves it at GET /articles.
//
// Sources: Roblox DevForum (Discourse json) + Google News RSS.
// Both are free, need no API key, and work from cloud hosts.
//
// Reddit was removed: its Responsible Builder Policy disabled self-serve app
// creation, so OAuth is impossible to set up, and the anonymous endpoints
// return 403 then 429 from cloud IPs.

import http from "node:http";

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 10 * 60 * 1000;
const MAX_ARTICLES = 80;

const UA = "web:roblox-report:v2.0 (news terminal for a Roblox experience)";

// ---------------------------------------------------------------------------
// SOURCES
//
// DevForum categories are looked up BY SLUG at startup, so no fragile numeric
// ids live in this file. The slug is the text part of a category URL:
//   https://devforum.roblox.com/c/updates/announcements/36
//                                         ^^^^^^^^^^^^^ this
// Visit /categories on your deployed service to see every slug available.
// ---------------------------------------------------------------------------
const DEVFORUM_CATEGORIES = [
  { slug: "announcements",       source: "Roblox", category: "Platform",  confirmed: true },
  { slug: "release-notes",       source: "Roblox", category: "Studio",    confirmed: true },
  { slug: "community-resources", source: "Roblox", category: "Community", confirmed: true },
  { slug: "cool-creations",      source: "Roblox", category: "Community", confirmed: true },
  { slug: "bulletin-board",      source: "Roblox", category: "Community", confirmed: true },
];

// Third-party coverage. Anything whose source is not exactly "Roblox" shows the
// twitter icon, reads "3rd Party Post", and is hidden by the TwitIcon toggle.
const NEWS_QUERIES = [
  { query: "Roblox",                  category: "Platform"  },
  { query: "Roblox update OR event",  category: "Events"    },
  { query: "Roblox Studio developer", category: "Studio"    },
];

// ---------------------------------------------------------------------------
// CATEGORISATION
// ---------------------------------------------------------------------------
const RULES = [
  { category: "Events",    words: ["event", "egg", "hunt", "limited", "collab", "celebration", "anniversary"] },
  { category: "Studio",    words: ["studio", "release notes", "engine", "luau", "api", "plugin", "beta", "open cloud", "creator", "script"] },
  { category: "Platform",  words: ["policy", "safety", "age", "verification", "moderation", "economy", "robux", "premium", "terms"] },
  { category: "Community", words: ["community", "showcase", "creation", "feedback"] },
];

function classify(title, fallback) {
  const t = String(title).toLowerCase();
  for (const rule of RULES) {
    for (const w of rule.words) if (t.includes(w)) return rule.category;
  }
  return fallback || "Community";
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
async function getJSON(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last, or it would re-create the others
}

// decode FIRST, then strip: google news descriptions are escaped html, so
// stripping first would leave "&lt;a href=" visible in the ui
function stripHtml(s) {
  let out = decodeEntities(String(s || ""));
  out = out.replace(/<[^>]*>/g, " ");
  out = decodeEntities(out);
  return out.replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function firstImage(html) {
  const m = String(html || "").match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : "";
}

// ---------------------------------------------------------------------------
// DEVFORUM  (Discourse, no key)
// ---------------------------------------------------------------------------
// cache the PROMISE, not the result: all devforum sources are fetched in
// parallel, so caching only the resolved value made every one of them fetch
// categories.json before the first had finished.
let categoryIdPromise = null;

function loadCategoryIds() {
  if (categoryIdPromise) return categoryIdPromise;
  categoryIdPromise = (async () => {
    const data = await getJSON(
      "https://devforum.roblox.com/categories.json?include_subcategories=true"
    );
    const map = {};
    const walk = (list) => {
      for (const c of list || []) {
        map[c.slug] = c.id;
        if (c.subcategory_list) walk(c.subcategory_list);
        if (c.subcategory_ids && Array.isArray(c.subcategory_list)) walk(c.subcategory_list);
      }
    };
    walk(data?.category_list?.categories);
    console.log(`devforum: resolved ${Object.keys(map).length} category slugs`);
    return map;
  })().catch((e) => {
    categoryIdPromise = null; // allow a retry on the next refresh
    throw e;
  });
  return categoryIdPromise;
}

async function fetchDevforum(cfg) {
  const ids = await loadCategoryIds();
  const id = ids[cfg.slug];

  let data;
  if (id) {
    data = await getJSON(`https://devforum.roblox.com/c/${cfg.slug}/${id}.json`);
  } else {
    // some categories are nested and do not appear in the flat list; the
    // id-less form still resolves them on Discourse
    try {
      data = await getJSON(`https://devforum.roblox.com/c/${cfg.slug}.json`);
    } catch {
      console.warn(`devforum: slug "${cfg.slug}" not found; skipping. See /categories for valid slugs.`);
      return [];
    }
  }

  const topics = data?.topic_list?.topics || [];
  return topics
    .filter((t) => !t.pinned_globally && !topicBlocked(t.title))
    .map((t) => ({
      title: t.title,
      description: stripHtml(t.excerpt) || t.title,
      url: `https://devforum.roblox.com/t/${t.slug}/${t.id}`,
      image: "",
      source: cfg.source,
      category: classify(t.title, cfg.category),
      date: t.created_at,
      confirmed: cfg.confirmed,
    }));
}

// ---------------------------------------------------------------------------
// RELEVANCE FILTER
//
// A plain "Roblox" news search returns lawsuits, stock analysis and local TV
// crime coverage alongside actual gaming news. None of that belongs on a news
// terminal inside a Roblox experience, so third-party articles must clear both
// an outlet allowlist and a topic blocklist.
// ---------------------------------------------------------------------------

// gaming and tech press only. add outlets here as you see them in the logs.
const ALLOWED_OUTLETS = [
  "ign", "eurogamer", "rock paper shotgun", "polygon", "pc gamer", "kotaku",
  "gamesindustry", "pocket gamer", "insider gaming", "gosugamers", "vgc",
  "video games chronicle", "the verge", "engadget", "techcrunch", "tech times",
  "dexerto", "destructoid", "game rant", "screen rant", "gamespot", "gamedeveloper",
  "game developer", "digital trends", "androidcentral", "windows central",
  "nintendo life", "push square", "gamesradar", "pcgamesn", "massively",
  "80.lv", "hackernoon", "neowin", "ars technica", "wired", "the gamer", "thegamer",
];

// topics to reject regardless of outlet
const BLOCKED_WORDS = [
  // legal
  "lawsuit", "lawsuits", "sues", "sued", "suing", "settlement", "court",
  "attorney", "litigation", "subpoena", "class action", "plaintiff",
  // finance
  "stock", "shares", "nyse", "earnings", "price target", "analyst",
  "investor", "market cap", "valuation", "quarterly results", "revenue beat",
  "downgrade", "upgrade rating", "short interest", "hedge fund",
  // crime and safety reporting, not appropriate for an in-experience terminal
  "arrest", "arrested", "charged", "predator", "grooming", "groomed",
  "abuse", "assault", "indicted", "sentenced", "pleaded", "trafficking",
  "exploitation", "kidnap", "luring", "sex", "molest", "convicted",
  "investigation into", "missing girl", "missing boy", "victim",
];

function outletAllowed(outlet) {
  const o = String(outlet).toLowerCase();
  return ALLOWED_OUTLETS.some((a) => o.includes(a));
}

function topicBlocked(text) {
  const t = String(text).toLowerCase();
  return BLOCKED_WORDS.some((w) => t.includes(w));
}

// ---------------------------------------------------------------------------
// GOOGLE NEWS RSS  (free, no key, no app registration, no cloud-IP blocking)
//
// This replaced Reddit. Reddit's Responsible Builder Policy disabled self-serve
// app creation, so OAuth cannot be set up at all, and both the plain JSON and
// RSS endpoints refuse requests from cloud hosts (403 then 429).
//
// Google News aggregates real published articles about Roblox from actual
// outlets, which is a better fit for "3rd Party Post" than forum chatter was.
// ---------------------------------------------------------------------------
function rssItems(xml) {
  return String(xml).split("<item>").slice(1);
}

function tagText(chunk, tag) {
  const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return stripHtml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
}

async function fetchGoogleNews(cfg) {
  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(cfg.query) +
    "&hl=en-US&gl=US&ceid=US:en";

  const xml = await getText(url);
  const out = [];
  let rejectedOutlet = 0;
  let rejectedTopic = 0;

  for (const item of rssItems(xml)) {
    const rawTitle = tagText(item, "title");
    const link = tagText(item, "link");
    const pubDate = tagText(item, "pubDate");
    const outlet = tagText(item, "source") || "News";
    if (!rawTitle || !link) continue;

    // gaming/tech press only, and no legal, financial or crime coverage
    if (!outletAllowed(outlet)) { rejectedOutlet++; continue; }
    if (topicBlocked(rawTitle)) { rejectedTopic++; continue; }

    // google news formats titles as "Headline - Outlet"; drop the suffix since
    // the outlet is carried separately in the source field
    const escaped = outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const title = rawTitle.replace(new RegExp(`\\s*-\\s*${escaped}\\s*$`), "").trim();

    out.push({
      title,
      description: tagText(item, "description") || title,
      url: link,
      image: "",
      // the real outlet name; the ui renders "- BY <outlet>" from this
      source: outlet,
      category: classify(title, cfg.category),
      date: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      // published articles from real outlets, so not "unconfirmed"
      confirmed: true,
    });
  }

  console.log(
    `google news "${cfg.query}": kept ${out.length}, ` +
    `rejected ${rejectedOutlet} by outlet, ${rejectedTopic} by topic`
  );
  if (out.length === 0) throw new Error("no items survived filtering");
  return out;
}

// ---------------------------------------------------------------------------
// AGGREGATION
// ---------------------------------------------------------------------------
let cache = { articles: [], updatedAt: null, live: false };

function validate(a) {
  if (!a || typeof a.title !== "string" || !a.title.trim()) return null;
  if (typeof a.url !== "string" || !a.url.startsWith("http")) return null;
  const when = Date.parse(a.date);
  if (Number.isNaN(when)) return null;
  return {
    title: String(a.title).slice(0, 200),
    description: String(a.description || a.title).slice(0, 500),
    url: a.url,
    // only roblox-hosted assets can render, so anything else is dropped and the
    // experience falls back to its placeholder rather than showing a broken image
    image: typeof a.image === "string" && a.image.startsWith("rbxassetid://") ? a.image : "",
    // "Roblox" is the official-source marker the ui checks; anything else is
    // treated as third-party and keeps its real outlet name for "- BY <outlet>"
    source: typeof a.source === "string" && a.source.trim() ? String(a.source).slice(0, 40) : "News",
    category: ["Studio", "Platform", "Community", "Events"].includes(a.category) ? a.category : "Community",
    date: new Date(when).toISOString(),
    confirmed: a.confirmed === true,
  };
}

async function refresh() {
  const devforumJobs = DEVFORUM_CATEGORIES.map((c) => ({
    id: `devforum:${c.slug}`,
    run: () => fetchDevforum(c),
  }));

  // google news is happy with parallel requests, but a small gap keeps us
  // comfortably polite
  const newsJobs = NEWS_QUERIES.map((c) => ({
    id: `news:${c.query}`,
    run: () => fetchGoogleNews(c),
  }));

  const jobs = [...devforumJobs, ...newsJobs];

  const devforumResults = await Promise.allSettled(devforumJobs.map((j) => j.run()));

  const newsResults = [];
  for (const job of newsJobs) {
    try {
      newsResults.push({ status: "fulfilled", value: await job.run() });
    } catch (e) {
      newsResults.push({ status: "rejected", reason: e });
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const results = [...devforumResults, ...newsResults];

  const all = [];
  let okCount = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      okCount++;
      for (const raw of r.value) {
        const clean = validate(raw);
        if (clean) all.push(clean);
      }
    } else {
      console.warn(`source failed: ${jobs[i].id}: ${r.reason?.message}`);
    }
  });

  if (all.length === 0) {
    console.warn("every source failed; keeping the previous cache");
    cache.live = false;
    return;
  }

  const seen = new Set();
  const deduped = [];
  all
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .forEach((a) => {
      if (seen.has(a.url)) return;
      seen.add(a.url);
      if (deduped.length < MAX_ARTICLES) deduped.push(a);
    });

  const bySource = {};
  for (const a of deduped) bySource[a.source] = (bySource[a.source] || 0) + 1;

  cache = { articles: deduped, updatedAt: new Date().toISOString(), live: true };
  console.log(
    `refreshed: ${deduped.length} articles from ${okCount}/${jobs.length} sources ` +
      `(${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(", ")})`
  );
}

// ---------------------------------------------------------------------------
// SERVER
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/articles")) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" });
    res.end(JSON.stringify(cache));
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  // handy for finding new devforum slugs to add to DEVFORUM_CATEGORIES
  if (req.url === "/categories") {
    loadCategoryIds()
      .then((m) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(m, null, 2));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(e.message);
      });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`roblox-report backend v3 listening on :${PORT}`);
  refresh().catch((e) => console.error("initial refresh failed:", e.message));
  setInterval(() => refresh().catch((e) => console.error("refresh failed:", e.message)), REFRESH_MS);
});
