// ROBLOX REPORT :: news backend
// Aggregates FREE, no-key Roblox news sources into the article schema the
// Roblox experience expects, and serves them at GET /articles.
//
// No API key is needed to RUN this. The Open Cloud key is only used by the
// optional image uploader in images.js.

import http from "node:http";

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 10 * 60 * 1000; // 10 minutes; well under every source's limits
const MAX_ARTICLES = 60;

// ---------------------------------------------------------------------------
// SOURCES
// The DevForum runs Discourse, so ANY category URL + ".json" returns clean
// structured data with no key. Reddit exposes ".json" the same way.
// To add a source later: add an entry here and a matching fetch function.
// ---------------------------------------------------------------------------
const SOURCES = [
  {
    id: "devforum-announcements",
    url: "https://devforum.roblox.com/c/updates/announcements/36.json",
    kind: "discourse",
    source: "Roblox",
    category: "Platform",
  },
  {
    id: "devforum-release-notes",
    url: "https://devforum.roblox.com/c/updates/release-notes/62.json",
    kind: "discourse",
    source: "Roblox",
    category: "Studio",
  },
  {
    id: "reddit-roblox",
    url: "https://www.reddit.com/r/roblox/hot.json?limit=25",
    kind: "reddit",
    source: "RTC",
    category: "Community",
  },
  {
    id: "reddit-robloxgamedev",
    url: "https://www.reddit.com/r/robloxgamedev/hot.json?limit=25",
    kind: "reddit",
    source: "RTC",
    category: "Studio",
  },
];

// Reddit blocks requests without a descriptive User-Agent.
const UA = "RobloxReport/1.0 (Roblox experience news terminal)";

// ---------------------------------------------------------------------------
// CATEGORISATION
// Sources rarely label themselves, so classify from the title. Order matters:
// the first matching rule wins.
// ---------------------------------------------------------------------------
const RULES = [
  { category: "Events", words: ["event", "egg", "hunt", "limited", "rthro run", "celebration", "collab"] },
  { category: "Studio", words: ["studio", "release notes", "engine", "luau", "api", "plugin", "beta", "open cloud", "creator"] },
  { category: "Platform", words: ["policy", "safety", "age", "verification", "moderation", "economy", "robux", "premium", "terms"] },
  { category: "Community", words: ["community", "creator fund", "developer", "showcase"] },
];

function classify(title, fallback) {
  const t = String(title).toLowerCase();
  for (const rule of RULES) {
    for (const w of rule.words) {
      if (t.includes(w)) return rule.category;
    }
  }
  return fallback || "Community";
}

// ---------------------------------------------------------------------------
// FETCHERS
// Every one is individually guarded: a dead source must never take down the feed.
// ---------------------------------------------------------------------------
async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchDiscourse(src) {
  const data = await getJSON(src.url);
  const topics = data?.topic_list?.topics || [];
  return topics
    .filter((t) => !t.pinned_globally)
    .map((t) => ({
      title: t.title,
      description: stripHtml(t.excerpt) || t.title,
      url: `https://devforum.roblox.com/t/${t.slug}/${t.id}`,
      image: "",
      source: src.source,
      category: classify(t.title, src.category),
      date: t.created_at,
      confirmed: true,
    }));
}

async function fetchReddit(src) {
  const data = await getJSON(src.url);
  const posts = data?.data?.children || [];
  return posts
    .map((p) => p.data)
    .filter((p) => p && !p.stickied && !p.over_18)
    .map((p) => ({
      title: p.title,
      description: stripHtml(p.selftext).slice(0, 300) || p.title,
      url: `https://www.reddit.com${p.permalink}`,
      image: "",
      source: src.source,
      category: classify(p.title, src.category),
      // Reddit gives unix seconds; the schema wants ISO 8601
      date: new Date(p.created_utc * 1000).toISOString(),
      // Community chatter is not confirmed news; this drives the Unconfirmed label
      confirmed: false,
    }));
}

const FETCHERS = { discourse: fetchDiscourse, reddit: fetchReddit };

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
    image: typeof a.image === "string" ? a.image : "",
    source: ["Roblox", "RTC", "Bloxy News"].includes(a.source) ? a.source : "RTC",
    category: ["Studio", "Platform", "Community", "Events"].includes(a.category) ? a.category : "Community",
    date: new Date(when).toISOString(),
    confirmed: a.confirmed === true,
  };
}

async function refresh() {
  const results = await Promise.allSettled(
    SOURCES.map((src) => FETCHERS[src.kind](src))
  );

  const all = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      for (const raw of r.value) {
        const clean = validate(raw);
        if (clean) all.push(clean);
      }
    } else {
      console.warn(`source failed: ${SOURCES[i].id}: ${r.reason?.message}`);
    }
  });

  if (all.length === 0) {
    // keep whatever we had rather than serving an empty feed
    console.warn("all sources failed; keeping previous cache");
    cache.live = false;
    return;
  }

  // de-duplicate by url, newest first, capped
  const seen = new Set();
  const deduped = [];
  all
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .forEach((a) => {
      if (seen.has(a.url)) return;
      seen.add(a.url);
      if (deduped.length < MAX_ARTICLES) deduped.push(a);
    });

  cache = { articles: deduped, updatedAt: new Date().toISOString(), live: true };
  console.log(`refreshed: ${deduped.length} articles at ${cache.updatedAt}`);
}

// ---------------------------------------------------------------------------
// SERVER
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/articles")) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    });
    res.end(JSON.stringify(cache));
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`roblox-report backend listening on :${PORT}`);
  refresh().catch((e) => console.error("initial refresh failed:", e.message));
  setInterval(() => refresh().catch((e) => console.error("refresh failed:", e.message)), REFRESH_MS);
});
