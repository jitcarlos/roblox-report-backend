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
const MAX_ARTICLES = 300;

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
  // pages: how many pages of ~30 topics to pull. the update categories carry the
  // actual feature news (age verification, dynamic heads, quick words), so they
  // get the most depth.
  // the parent "Updates" category: product announcements, news and staff posts.
  // this is the canonical feed for things like age verification and avatar changes.
  { slug: "updates",             source: "Roblox", category: "Platform",  confirmed: true, pages: 4 },
  { slug: "announcements",       source: "Roblox", category: "Platform",  confirmed: true, pages: 4 },
  { slug: "release-notes",       source: "Roblox", category: "Studio",    confirmed: true, pages: 4 },
  { slug: "community-resources", source: "Roblox", category: "Community", confirmed: true },
  { slug: "cool-creations",      source: "Roblox", category: "Community", confirmed: true },
  { slug: "bulletin-board",      source: "Roblox", category: "Community", confirmed: true },
];

// Third-party coverage. Anything whose source is not exactly "Roblox" shows the
// twitter icon, reads "3rd Party Post", and is hidden by the TwitIcon toggle.
const NEWS_QUERIES = [
  // quote the phrase so google news treats it as required, not optional.
  // "Roblox update OR event" was being read as Roblox OR update OR event,
  // which is why fortnite stories were appearing under Events.
  { query: '"Roblox"',                   category: "Platform" },
  { query: '"Roblox" event',             category: "Events"   },
  { query: '"Roblox" Studio developer',  category: "Studio"   },
];

// belt and braces: whatever the query does, the article itself must mention
// roblox somewhere or it is not roblox news
function mentionsRoblox(text) {
  return String(text).toLowerCase().includes("roblox");
}

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

  // discourse paginates at ~30 topics. the update categories carry the real
  // feature news, so they pull several pages.
  const topics = [];
  const pages = cfg.pages || 1;
  const path = id ? `${cfg.slug}/${id}` : cfg.slug;

  for (let p = 0; p < pages; p++) {
    let page;
    try {
      page = await getJSON(
        `https://devforum.roblox.com/c/${path}.json?page=${p}&include_subcategories=true`
      );
    } catch (e) {
      if (p === 0) throw e; // first page failing is a real error
      break;                // later pages just mean we ran out
    }
    const got = page?.topic_list?.topics || [];
    if (got.length === 0) break;
    topics.push(...got);
  }

  if (topics.length === 0) {
    console.warn(`devforum: slug "${cfg.slug}" returned nothing; skipping.`);
    return [];
  }

  const kept = topics
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

  console.log(`devforum ${cfg.slug}: ${topics.length} topics -> ${kept.length} kept`);
  return kept;
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
  // crime and safety reporting, never appropriate on an in-experience terminal
  "arrest", "arrested", "charged", "predator", "grooming", "groomed",
  "abuse", "assault", "indicted", "sentenced", "pleaded", "trafficking",
  "exploitation", "kidnap", "luring", "sex", "molest", "convicted",
  "investigation", "missing girl", "missing boy", "victim", "danger",
  "child safety", "children", "minors", "underage", "harm", "explicit",
  // government and regulatory coverage
  "senate", "congress", "lawmaker", "regulator", "regulation", "ftc",
  "attorney general", "subpoena", "testify", "hearing", "ban roblox",
  "age verification law", "coppa", "probe",
];

// game coverage and SEO filler, as opposed to platform news. these are articles
// ABOUT games that happen to run on roblox, which is not what this terminal is for.
const GAME_COVERAGE = [
  "codes", "code list", "free codes", "tier list", "how to get", "how to find",
  "beginner guide", "walkthrough", "best weapons", "best units", "all bosses",
  "speedrun", "tips and tricks", "everything you need to know about",
  // other platforms
  "fortnite", "minecraft", "call of duty", "gta ", "grand theft auto",
  "among us", "valorant", "overwatch", "genshin",
  // individual roblox games
  "99 nights", "grow a garden", "steal a brainrot", "blox fruits", "adopt me",
  "murder mystery", "brookhaven", "doors", "dress to impress", "blade ball",
  "pet simulator", "jailbreak", "arsenal", "tower defense",
];

function gameCoverage(text) {
  const t = String(text).toLowerCase();
  return GAME_COVERAGE.some((w) => t.includes(w));
}

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
  let rejectedOffTopic = 0;
  let rejectedGame = 0;

  for (const item of rssItems(xml)) {
    const rawTitle = tagText(item, "title");
    const link = tagText(item, "link");
    const pubDate = tagText(item, "pubDate");
    const outlet = tagText(item, "source") || "News";
    if (!rawTitle || !link) continue;

    const descr = tagText(item, "description");

    // gaming/tech press only, no legal/financial/crime coverage, and it must
    // actually be about roblox
    if (!outletAllowed(outlet)) { rejectedOutlet++; continue; }
    if (topicBlocked(rawTitle)) { rejectedTopic++; continue; }
    if (!mentionsRoblox(rawTitle) && !mentionsRoblox(descr)) { rejectedOffTopic++; continue; }
    if (gameCoverage(rawTitle)) { rejectedGame++; continue; }

    // google news formats titles as "Headline - Outlet"; drop the suffix since
    // the outlet is carried separately in the source field
    const escaped = outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const title = rawTitle.replace(new RegExp(`\\s*-\\s*${escaped}\\s*$`), "").trim();

    out.push({
      title,
      description: descr || title,
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
    `rejected ${rejectedOutlet} by outlet, ${rejectedTopic} by topic, ${rejectedOffTopic} off-topic, ${rejectedGame} game-coverage`
  );
  if (out.length === 0) throw new Error("no items survived filtering");
  return out;
}

// ---------------------------------------------------------------------------
// THUMBNAILS
// Hand-made, hand-uploaded images. No scraping and no automatic uploading, so
// nothing unreviewed can ever reach the screen or the owner's inventory.
// Order: source image, then category image, then generic.
// ---------------------------------------------------------------------------
const IMAGES = {
  source: {
    Roblox: "rbxassetid://98000033020431",   // Report_RobloxSource
    press:  "rbxassetid://111190113171579",  // Report_GamingPress
  },
  category: {
    Studio:    "rbxassetid://136131488938986",
    Platform:  "rbxassetid://114239623911906",
    Community: "rbxassetid://105559260052005",
    Events:    "rbxassetid://110706013366870",
  },
  generic: "rbxassetid://117858905448304",
};

function pickImage(article) {
  if (article.source === "Roblox") {
    return IMAGES.category[article.category] || IMAGES.source.Roblox || IMAGES.generic;
  }
  return IMAGES.category[article.category] || IMAGES.source.press || IMAGES.generic;
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
    // set below, after source and category are known
    image: "",
    // "Roblox" is the official-source marker the ui checks; anything else is
    // treated as third-party and keeps its real outlet name for "- BY <outlet>"
    source: typeof a.source === "string" && a.source.trim() ? String(a.source).slice(0, 40) : "News",
    category: ["Studio", "Platform", "Community", "Events"].includes(a.category) ? a.category : "Community",
    date: new Date(when).toISOString(),
    confirmed: a.confirmed === true,
  };
}

function withImage(a) {
  a.image = pickImage(a);
  return a;
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
        if (clean) all.push(withImage(clean));
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
// SEARCH
// The cache can only ever hold a few hundred recent topics, so searching it for
// something older ("age verification", "dynamic heads") finds nothing. Discourse
// exposes a real search endpoint, so a live query hits the whole DevForum
// history instead. Restricted to #updates so results stay official.
// ---------------------------------------------------------------------------
const searchCache = new Map(); // query -> { at, articles }
const SEARCH_TTL_MS = 5 * 60 * 1000;
const SEARCH_PAGES = 8;          // discourse returns ~50 topics per page
const SEARCH_MAX_RESULTS = 400;  // plenty; the ui renders the top slice

function relevanceScore(title, description, query) {
  // everything lowercased, so matching is case-insensitive throughout
  const t = String(title).toLowerCase();
  const d = String(description).toLowerCase();
  const q = String(query).toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);

  let score = 0;

  // an exact phrase in the title beats everything else, so searching a specific
  // topic surfaces that topic ahead of general coverage
  if (t === q) score += 100000;
  else if (t.startsWith(q)) score += 50000;
  else if (t.includes(q)) score += 25000;

  // every query word present in the title
  const inTitle = words.filter((w) => t.includes(w)).length;
  if (inTitle === words.length && words.length > 0) score += 8000;
  score += inTitle * 600;

  // description matches count for much less
  if (d.includes(q)) score += 1200;
  score += words.filter((w) => d.includes(w)).length * 60;

  // shorter titles that still match are usually the canonical announcement
  if (t.includes(q)) score += Math.max(0, 200 - t.length);

  return score;
}

async function searchDevforumPage(q, page, scoped) {
  const term = scoped ? `${q} #updates` : q;
  const url =
    "https://devforum.roblox.com/search.json?q=" +
    encodeURIComponent(term) +
    `&page=${page}`;
  return getJSON(url);
}

async function searchDevforum(query) {
  const q = String(query).trim().slice(0, 80);
  if (!q) return [];

  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.articles;

  const started = Date.now();
  const byUrl = new Map();

  // two passes. official Updates first, then the wider forum, so official
  // announcements always outrank general forum threads on the same topic.
  const passes = [
    { scoped: true,  pages: SEARCH_PAGES, bonus: 15000 },
    { scoped: false, pages: SEARCH_PAGES, bonus: 0 },
  ];

  for (const pass of passes) {
    // all pages of a pass at once. sequential paging was the whole reason a
    // deep search took so long: 16 round trips one after another.
    const pageNumbers = Array.from({ length: pass.pages }, (_, i) => i + 1);
    const settled = await Promise.allSettled(
      pageNumbers.map((page) => searchDevforumPage(q, page, pass.scoped))
    );

    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const data = result.value;

      const topics = data?.topics || [];
      const posts = data?.posts || [];
      if (topics.length === 0) continue;

      const blurb = {};
      for (const p of posts) {
        if (p.topic_id && !blurb[p.topic_id]) blurb[p.topic_id] = stripHtml(p.blurb);
      }

      for (const t of topics) {
        if (topicBlocked(t.title)) continue;
        if (!pass.scoped && gameCoverage(t.title)) continue;

        const url = `https://devforum.roblox.com/t/${t.slug}/${t.id}`;
        if (byUrl.has(url)) continue;

        const description = (blurb[t.id] || t.title).slice(0, 500);
        byUrl.set(url, {
          article: withImage({
            title: String(t.title).slice(0, 200),
            description,
            url,
            image: "",
            source: "Roblox",
            category: classify(t.title, "Platform"),
            date: new Date(t.created_at).toISOString(),
            confirmed: true,
          }),
          score: relevanceScore(t.title, description, q) + pass.bonus,
        });
      }
    }
  }

  const ranked = [...byUrl.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(b.article.date) - Date.parse(a.article.date);
    })
    .map((e) => e.article)
    .slice(0, SEARCH_MAX_RESULTS);

  searchCache.set(key, { at: Date.now(), articles: ranked });
  console.log(`search "${q}": ${ranked.length} results (from ${byUrl.size} unique topics) in ${Date.now() - started}ms`);
  return ranked;
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
  if (req.url.startsWith("/search")) {
    const q = new URL(req.url, "http://x").searchParams.get("q") || "";
    searchDevforum(q)
      .then((articles) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ articles, query: q }));
      })
      .catch((e) => {
        console.warn(`search failed: ${e.message}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ articles: [], query: q, error: e.message }));
      });
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
