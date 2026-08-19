# The International 2026 — Schedule PWA

A mobile-first, installable web app that shows The International 2026 Main Event
schedule **in the viewer's own timezone**. Two views: a flat list — who plays
whom, which part of the playoffs it is, and when — and the full double-elimination
bracket, both in local time with no mental arithmetic.

Match data comes from [Liquipedia](https://liquipedia.net/dota2/The_International/2026/Main_Event).

## Quick start

```bash
npm run sync     # pull the latest schedule from Liquipedia
npm run serve    # serve public/ at http://localhost:5173
```

or both at once:

```bash
npm start
```

There is no build step and no dependencies — plain HTML, CSS and ES modules.

To try it on your phone, run `npm run serve` and open
`http://<your-mac-lan-ip>:5173` on the same Wi‑Fi, then use **Add to Home
Screen**.

> Installing as a PWA (and offline support) needs `http://localhost` or HTTPS —
> service workers do not register over `file://`.

## What it does

- **Two views.** *Bracket* (the default) draws the whole double-elimination
  tree, scrolling horizontally on a phone; *List* groups the same cards by day.
  Your choice is remembered.
- **Auto-detects your timezone** and converts every match time to it. You can
  switch between your time, event time (Shanghai, UTC+8) and UTC.
- **Groups matches by your local day** — "Today", "Tomorrow", then weekdays.
  A match at 02:00 UTC lands on Aug 20 in Moscow but Aug 19 in New York, and the
  list reflects that.
- **Tap any match** — or the next-match card — for a detail sheet with a live
  countdown, the time in both your zone and Shanghai, direct **Twitch** and
  **YouTube** links, and calendar export.
- **Live countdown** to the next match, and a LIVE badge while one is in progress.
- **Results** — once Liquipedia publishes a score, the card shows it with the
  winner highlighted.
- **Colour-coded rounds** — upper bracket blue, lower bracket red, grand final gold.
- **Calendar export** — the whole schedule or a single match as `.ics`.
- **Works offline** — the last synced schedule is cached and shown with a notice.

## How the data works

```
Liquipedia ──(scripts/sync.mjs)──> public/data/schedule.json ──(fetch)──> the app
```

The app never calls Liquipedia directly: their API sends no CORS headers, and
their terms ask clients to cache rather than hit the API per page view. So the
sync script fetches once and writes a static JSON file that the PWA reads.

### Why it scrapes rendered HTML instead of wikitext

Liquipedia migrates match data out of wikitext into its `match2` database as a
tournament progresses — TI 2025's wikitext is now nothing but empty `{{Match}}`
stubs. The *rendered* page keeps working in both states, and every bracket also
renders a flat "Show schedule" table containing exactly what we need: a UTC
timestamp, the round name, both opponents, the score and the best-of.

`sync.mjs` parses that table. It has been verified against both TI 2026
(upcoming, opponents still TBD) and TI 2025 (finished, full results):

```bash
node scripts/sync.mjs --force \
  --page="The International/2025/Main Event" --out=/tmp/ti2025.json
```

If Liquipedia ever changes that layout, the script fails loudly and **leaves the
existing JSON untouched** rather than publishing an empty schedule.

### Stream links

The rendered page only links Twitch as `Special:Stream/twitch/The_International`
— a Liquipedia page name, not a channel — so a real `twitch.tv` link has to come
from the wikitext `|twitch=` parameter, which the sync reads from the same
request (`prop=text|wikitext`). It is only trusted when every match agrees on one
value. YouTube is derived from the link path instead: two segments means a
specific broadcast (`watch?v=…`), one means the channel. Anything not confidently
derivable keeps the Liquipedia URL in `fallbackUrl`, which always resolves.

### Where the bracket shape comes from

The bracket view is not hand-drawn. Liquipedia's graphical bracket emits one
round-header row per half (upper first — the grand final belongs to it — then
lower), and each header carries a `--skip-round` offset. That offset is why
"Upper Bracket Final" sits in column 4 rather than 3, lining up with the lower
bracket final before both feed the grand final. `sync.mjs` reads those offsets
into `layout` in the JSON, so the tree reproduces the real bracket instead of a
guess.

Connectors are drawn as an SVG overlay from measured element positions after
layout, so they stay correct at any card size. Feeder relationships are inferred
from round sizes — a round that halves gets two feeders per match, one that
carries straight over gets one — and anything that fits neither shape is simply
left unconnected rather than mis-drawn.

### Respecting Liquipedia's API terms

[Their terms](https://liquipedia.net/api-terms-of-use) are enforced, and
`sync.mjs` complies:

| Requirement | How it is met |
| --- | --- |
| Descriptive `User-Agent` | `USER_AGENT` at the top of `scripts/sync.mjs` |
| gzip required (else HTTP 406) | `Accept-Encoding: gzip` on the request |
| `action=parse` at most once / 30 s | refuses to re-run within 30 s unless `--force` |
| Cache results | the whole point of the generated JSON |
| Attribution, CC BY-SA 3.0 | credited in the app footer |

**If you fork this, change `USER_AGENT` to point at you.** It is how Liquipedia
contacts you before rate-limiting a misbehaving client.

Team logos are deliberately *not* hotlinked: many are licensed to Liquipedia
under terms incompatible with CC BY-SA. The app draws colour-coded monogram
badges instead.

## Keeping it up to date

- **Manually:** `npm run sync`
- **Automatically:** `.github/workflows/deploy.yml` checks Liquipedia every
  5 minutes. It runs on GitHub's servers, so nothing needs to stay online at
  home. One Liquipedia API call per run.

It only commits and redeploys when the schedule actually moved. `sync.mjs`
fingerprints the content *excluding* `updatedAt` and stores it as `contentHash`;
if the hash matches the previous file it leaves the file byte-identical and
reports `changed=false`, so a quiet hour produces no commits and no deploys.
Without that, the timestamp alone would differ every run and "commit only on
change" would commit every single time.

There is no server and no database to run. The whole dataset is ~16 KB of JSON,
so a file in the repo is the store.

### Why sync and deploy are one workflow

A commit pushed with the default `GITHUB_TOKEN` does **not** trigger further
workflow runs — GitHub blocks that to prevent recursion. So a scheduled sync
that commits, plus a separate `on: push` deploy, silently never deploys: the
data updates in the repo while the published site goes stale. Doing both in one
job avoids that entirely, and the artifact is built from the working tree, so
the fresh schedule ships without needing a commit at all.

If Liquipedia is unreachable the sync step is allowed to fail and the last good
committed schedule is published instead.

### Two caveats with GitHub's cron

- **5 minutes is the floor.** GitHub does not honour intervals shorter than
  that, and scheduled runs sit on shared infrastructure, so they can be
  **delayed by several minutes** under load. Treat `*/5` as best effort.
- GitHub **disables scheduled workflows after 60 days without repo activity**.
  Irrelevant across a four-day tournament; worth knowing if you leave it running.

## Deploying

`public/` is a static directory — any static host works.

- **GitHub Pages:** `.github/workflows/deploy.yml` is ready. Push to `main`, then
  Settings → Pages → Source: *GitHub Actions*. Free, HTTPS, installable, and it
  refreshes itself.
- **Cloudflare Pages / Netlify / Vercel:** connect the repo, publish directory
  `public`, no build command. Keep the GitHub Action for the data refresh —
  Vercel's free tier only runs cron once a day, which is too coarse here.

## Project layout

```
public/                     the deployable static app
  index.html                shell
  app.js                    list + bracket rendering, timezones, countdowns, .ics
  styles.css                dark mobile-first theme
  sw.js                     service worker (offline + installability)
  manifest.webmanifest      PWA manifest
  data/schedule.json        generated — do not edit by hand
  icons/                    generated PWA icons
scripts/
  sync.mjs                  Liquipedia -> schedule.json
  serve.mjs                 dependency-free static dev server
  make-icons.mjs            regenerates icons (needs `brew install librsvg`)
```

## Notes

- Only the **Main Event** has published match data. The Group Stage
  (Aug 13–16) pages carry standings but no per-match times, so there is nothing
  to list there.
- A match that has started but has no published score yet shows as LIVE for a
  generous window, then as "result pending" — Liquipedia updates results a
  little after a series ends.
