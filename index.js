// ROBLOX REPORT :: news backend  (v2)
// Aggregates FREE Roblox news into the article schema the experience expects
// and serves it at GET /articles.
//
// Reddit is tried three ways, best first:
//   1. OAuth      - reliable, needs two free env vars (see DEPLOY-GUIDE)
//   2. plain JSON - works from home IPs, usually 403s from cloud hosts
//   3. RSS        - the fallback that most often survives on cloud hosts
//
// No key of any kind is required to run this. OAuth is optional.

import http from "node:http";

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 10 * 60 * 1000;
const MAX_ARTICLES = 80;

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || "";
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || "";

// Reddit rejects generic agents. Must be descriptive.
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

// Reddit is third-party chatter: source "RTC", confirmed false.
// That is what lights up the TwitIcon filter and the Unconfirmed label.
const SUBREDDITS = [
  { name: "roblox",        category: "Community" },
  { name: "robloxgamedev", category: "Studio" },
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

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstImage(html) {
  const m = String(html || "").match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : "";
}

// ---------------------------------------------------------------------------
// DEVFORUM  (Discourse, no key)
// ---------------------------------------------------------------------------
let categoryIdCache = null;

async function loadCategoryIds() {
  if (categoryIdCache) return categoryIdCache;
  const data = await getJSON(
    "https://devforum.roblox.com/categories.json?include_subcategories=true"
  );
  const map = {};
  const walk = (list) => {
    for (const c of list || []) {
      map[c.slug] = c.id;
      if (c.subcategory_list) walk(c.subcategory_list);
    }
  };
  walk(data?.category_list?.categories);
  categoryIdCache = map;
  console.log(`devforum: resolved ${Object.keys(map).length} category slugs`);
  return map;
}

async function fetchDevforum(cfg) {
  const ids = await loadCategoryIds();
  const id = ids[cfg.slug];
  if (!id) throw new Error(`unknown category slug "${cfg.slug}"`);

  const data = await getJSON(`https://devforum.roblox.com/c/${cfg.slug}/${id}.json`);
  const topics = data?.topic_list?.topics || [];
  return topics
    .filter((t) => !t.pinned_globally)
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
// REDDIT  (three strategies, best first)
// ---------------------------------------------------------------------------
let redditToken = { value: "", expiresAt: 0 };

async function getRedditToken() {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) return "";
  if (redditToken.value && Date.now() < redditToken.expiresAt) return redditToken.value;

  const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const json = await res.json();
  redditToken = {
    value: json.access_token,
    // refresh a minute early so no request rides an expiring token
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  console.log("reddit: obtained oauth token");
  return redditToken.value;
}

function redditPostsToArticles(posts, cfg) {
  return posts
    .filter((p) => p && !p.stickied && !p.over_18)
    .map((p) => ({
      title: p.title,
      description: stripHtml(p.selftext).slice(0, 300) || p.title,
      url: `https://www.reddit.com${p.permalink}`,
      image: "",
      source: "RTC",
      category: classify(p.title, cfg.category),
      date: new Date(p.created_utc * 1000).toISOString(),
      confirmed: false,
    }));
}

// Reddit's Atom feed. Survives on cloud IPs more often than the json endpoints.
function parseRedditRSS(xml, cfg) {
  const out = [];
  const entries = String(xml).split("<entry>").slice(1);
  for (const e of entries) {
    const title = stripHtml((e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
    const link = (e.match(/<link[^>]+href=["']([^"']+)["']/) || [])[1];
    const updated = (e.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1];
    const content = (e.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || "";
    if (!title || !link) continue;
    out.push({
      title,
      description: stripHtml(content).slice(0, 300) || title,
      url: link,
      image: "",
      source: "RTC",
      category: classify(title, cfg.category),
      date: updated || new Date().toISOString(),
      confirmed: false,
    });
  }
  return out;
}

async function fetchSubreddit(cfg) {
  const strategies = [
    {
      name: "oauth",
      run: async () => {
        const token = await getRedditToken();
        if (!token) throw new Error("no oauth credentials configured");
        const data = await getJSON(
          `https://oauth.reddit.com/r/${cfg.name}/hot?limit=25`,
          { Authorization: `Bearer ${token}` }
        );
        return redditPostsToArticles((data?.data?.children || []).map((c) => c.data), cfg);
      },
    },
    {
      name: "json",
      run: async () => {
        const data = await getJSON(`https://www.reddit.com/r/${cfg.name}/hot.json?limit=25`);
        return redditPostsToArticles((data?.data?.children || []).map((c) => c.data), cfg);
      },
    },
    {
      name: "rss",
      run: async () => {
        const xml = await getText(`https://www.reddit.com/r/${cfg.name}/hot/.rss?limit=25`);
        const parsed = parseRedditRSS(xml, cfg);
        if (parsed.length === 0) throw new Error("rss returned no entries");
        return parsed;
      },
    },
  ];

  let lastError;
  for (const s of strategies) {
    try {
      const result = await s.run();
      if (result.length > 0) {
        console.log(`reddit r/${cfg.name}: ${result.length} posts via ${s.name}`);
        return result;
      }
      lastError = new Error("empty result");
    } catch (e) {
      lastError = e;
      console.warn(`reddit r/${cfg.name}: ${s.name} failed (${e.message})`);
    }
  }
  throw lastError || new Error("all strategies failed");
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
    source: ["Roblox", "RTC", "Bloxy News"].includes(a.source) ? a.source : "RTC",
    category: ["Studio", "Platform", "Community", "Events"].includes(a.category) ? a.category : "Community",
    date: new Date(when).toISOString(),
    confirmed: a.confirmed === true,
  };
}

async function refresh() {
  const jobs = [
    ...DEVFORUM_CATEGORIES.map((c) => ({ id: `devforum:${c.slug}`, run: () => fetchDevforum(c) })),
    ...SUBREDDITS.map((c) => ({ id: `reddit:${c.name}`, run: () => fetchSubreddit(c) })),
  ];

  const results = await Promise.allSettled(jobs.map((j) => j.run()));

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
  console.log(`roblox-report backend v2 listening on :${PORT}`);
  console.log(`reddit oauth: ${REDDIT_CLIENT_ID ? "configured" : "NOT configured (will try json, then rss)"}`);
  refresh().catch((e) => console.error("initial refresh failed:", e.message));
  setInterval(() => refresh().catch((e) => console.error("refresh failed:", e.message)), REFRESH_MS);
});
