# ROBLOX REPORT :: backend

Aggregates free, no-key Roblox news into the article schema the experience expects.

## What it serves

`GET /articles`

```json
{
  "articles": [
    {
      "title": "...",
      "description": "...",
      "url": "https://devforum.roblox.com/t/slug/123",
      "image": "",
      "source": "Roblox" | "RTC" | "Bloxy News",
      "category": "Studio" | "Platform" | "Community" | "Events",
      "date": "2026-08-15T12:00:00Z",
      "confirmed": true
    }
  ],
  "updatedAt": "2026-08-15T12:00:00Z",
  "live": true
}
```

`GET /health` returns `ok`.

## Sources (all free, no API key)

| Source | Endpoint | Why it works |
|---|---|---|
| DevForum announcements | `/c/updates/announcements/36.json` | DevForum runs Discourse; any category URL + `.json` returns structured data |
| DevForum release notes | `/c/updates/release-notes/62.json` | same |
| r/roblox | `/r/roblox/hot.json` | Reddit exposes `.json` on any listing |
| r/robloxgamedev | `/r/robloxgamedev/hot.json` | same |

Reddit requires a descriptive `User-Agent` or it returns 429. That's set in `UA`.

## Adding a source later

1. Add an entry to `SOURCES` with a `kind`.
2. If it's a new `kind`, write a fetch function returning the article shape and register it in `FETCHERS`.

That's the only change needed. Everything downstream is generic.

## Deploy (Render, free)

1. Put this folder in a GitHub repo.
2. render.com -> New -> Web Service -> connect the repo.
3. Runtime Node, Build `npm install`, Start `npm start`.
4. Instance type: Free.
5. Copy the URL it gives you, e.g. `https://roblox-report.onrender.com`.

Render's free tier sleeps after inactivity, so the first request after a
quiet period takes ~30s. The Roblox side keeps the previous articles while
that happens, so the terminal never goes blank.

## Notes

- `refresh()` runs on boot and every 10 minutes.
- If every source fails, the previous cache is kept and `live` becomes false.
- One bad article is dropped by `validate()`; it never takes down the feed.
