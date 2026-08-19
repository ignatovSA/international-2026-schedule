#!/usr/bin/env node
/**
 * Pulls The International 2026 Main Event schedule from Liquipedia and writes
 * public/data/schedule.json.
 *
 * Why scrape the rendered HTML instead of the wikitext?
 * Liquipedia moves match data out of wikitext and into its match2 database as a
 * tournament is played (TI 2025's wikitext is nothing but empty `{{Match}}`
 * stubs). The rendered page keeps working in both states, and every bracket
 * renders a flat "Show schedule" table that already contains exactly what we
 * need: UTC timestamp, round name, both opponents, score and best-of.
 *
 * Liquipedia API terms of use (https://liquipedia.net/api-terms-of-use):
 *   - a descriptive User-Agent is mandatory        -> USER_AGENT below
 *   - gzip is mandatory                            -> Accept-Encoding header
 *   - action=parse at most once per 30 seconds     -> MIN_INTERVAL_MS guard
 *   - cache the results                            -> that is the whole point
 *     of this script; the PWA only ever reads the generated JSON.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = resolve(ROOT, 'public/data/schedule.json')

const WIKI = 'https://liquipedia.net/dota2'
const API = `${WIKI}/api.php`
const PAGE = 'The International/2026/Main Event'

// Please keep this descriptive and keep a contact route in it — it is what
// Liquipedia uses to reach you before they rate-limit or ban a misbehaving
// client. If you fork this, point it at yourself.
const USER_AGENT =
  'international-2026-schedule/1.0 (PWA showing TI2026 times in local timezone; +https://github.com/ignatovSA/international-2026-schedule)'

const MIN_INTERVAL_MS = 30_000

/** Static facts about the event; they do not change, so we don't spend a request on them. */
const TOURNAMENT = {
  name: 'The International 2026',
  shortName: 'TI 2026',
  edition: 'TI 15',
  stage: 'Main Event',
  city: 'Shanghai',
  country: 'China',
  venue: 'Oriental Sports Center',
  eventTimeZone: 'Asia/Shanghai',
  sourceUrl: `${WIKI}/The_International/2026/Main_Event`,
  license: 'CC-BY-SA 3.0',
}

// ---------------------------------------------------------------- tiny HTML utils

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const stripTags = (s) => s.replace(/<[^>]*>/g, '')

const text = (s) => decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------- fetching

/**
 * One request, both representations: the rendered HTML carries the schedule and
 * bracket, while the wikitext still carries the raw stream handles (`twitch=`)
 * that the HTML only exposes as opaque Liquipedia redirect pages.
 */
async function fetchPage(page) {
  const url = `${API}?action=parse&format=json&prop=text|wikitext&page=${encodeURIComponent(page)}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'gzip', // required, 406 otherwise
      Accept: 'application/json',
    },
  })

  if (!res.ok) throw new Error(`Liquipedia responded ${res.status} ${res.statusText} for "${page}"`)

  const body = await res.json()
  if (body.error) throw new Error(`Liquipedia API error: ${body.error.info ?? body.error.code}`)
  if (!body?.parse?.text?.['*']) throw new Error(`Unexpected API payload for "${page}"`)

  return {
    html: decodeEntities(body.parse.text['*']),
    wikitext: body.parse.wikitext?.['*'] ?? '',
  }
}

/**
 * The event's Twitch channel, e.g. "dota2ti".
 *
 * The rendered page only links Twitch as `Special:Stream/twitch/The_International`,
 * which is a Liquipedia page name, not a channel — so a real twitch.tv link has
 * to come from the wikitext. Only trusted when every match agrees, and the
 * caller falls back to the Liquipedia link when it does not.
 */
function parseTwitchChannel(wikitext) {
  const values = [
    ...new Set(
      [...wikitext.matchAll(/\|twitch=([^\n|}]*)/g)].map((m) => m[1].trim()).filter(Boolean)
    ),
  ]
  return values.length === 1 ? values[0] : null
}

// ---------------------------------------------------------------- parsing

/**
 * The bracket renders twice: a graphical bracket and a flat schedule table,
 * wrapped in `data-toggle-area-content` panes. We want the table pane, which is
 * the one containing the sortable Date/Round/Opponent header row.
 */
function extractScheduleTable(html) {
  const panes = [...html.matchAll(/<div data-toggle-area-content="(\d+)"/g)]
  if (!panes.length) throw new Error('No toggle-area panes found — page layout changed')

  for (let i = 0; i < panes.length; i++) {
    const start = panes[i].index
    const end = i + 1 < panes.length ? panes[i + 1].index : html.length
    const pane = html.slice(start, end)
    if (/data-sort-type="isoDate"/.test(pane) && /table2__row--body/.test(pane)) return pane
  }
  throw new Error('Schedule table not found in any pane — page layout changed')
}

function parseTeamCell(cell) {
  const name =
    text(/<span class="name hidden-xs"[^>]*>([\s\S]*?)<\/span>/.exec(cell)?.[1] ?? '') ||
    text(/<span class="name[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(cell)?.[1] ?? '') ||
    text(/data-sort-value="([^"]*)"/.exec(cell)?.[1] ?? '')

  const short = text(/<span class="name visible-xs"[^>]*>([\s\S]*?)<\/span>/.exec(cell)?.[1] ?? '')

  // Team page link, e.g. href="/dota2/Team_Spirit". TBD slots have no link.
  const href = /<a href="(\/dota2\/(?!Special:|index\.php)[^"#?]+)"/.exec(cell)?.[1]

  const tbd = !name || /^tbd$/i.test(name)

  return {
    name: tbd ? 'TBD' : name,
    short: tbd ? 'TBD' : short || name,
    url: href ? `https://liquipedia.net${href}` : null,
    tbd,
  }
}

function parseScoreCell(cell) {
  const bestOf = Number(/Best of (\d+)/.exec(cell)?.[1] ?? 0) || null

  // Played: `<b>2</b>:0` (the winner's score is bolded). Unplayed: `vs`.
  const line = text(/<div style="line-height:1\.1">([\s\S]*?)<\/div>/.exec(cell)?.[1] ?? '')
  const pair = /^(\d+)\s*:\s*(\d+)$/.exec(line)
  if (!pair) return { bestOf, score: null, winner: null }

  const score = [Number(pair[1]), Number(pair[2])]
  const boldLeft = /<b>\s*\d+\s*<\/b>\s*:/.test(cell)
  const boldRight = /:\s*<b>\s*\d+\s*<\/b>/.test(cell)

  let winner = null
  if (boldLeft && !boldRight) winner = 0
  else if (boldRight && !boldLeft) winner = 1
  else if (score[0] !== score[1]) winner = score[0] > score[1] ? 0 : 1

  return { bestOf, score, winner }
}

/**
 * Turns a Liquipedia stream redirect into a link that opens the stream itself.
 * Anything not confidently derivable keeps the Liquipedia URL, which always works.
 */
function directStreamUrl(platform, path, twitchChannel) {
  const segments = path.split('/').filter(Boolean)

  if (platform === 'youtube') {
    // "dota2/hC1V-oCh1r0" -> a specific broadcast; "dota2" -> the channel.
    if (segments.length >= 2) return `https://www.youtube.com/watch?v=${segments.at(-1)}`
    if (segments.length === 1) return `https://www.youtube.com/@${segments[0]}`
  }

  if (platform === 'twitch' && twitchChannel) return `https://www.twitch.tv/${twitchChannel}`

  return null
}

function parseDateCell(cell, twitchChannel) {
  const unix = Number(/data-timestamp="(\d+)"/.exec(cell)?.[1] ?? 0)

  const streams = [
    ...cell.matchAll(/href="\/dota2\/Special:Stream\/([a-z]+)\/([^"]+)"/g),
  ].map(([, platform, path]) => {
    const fallbackUrl = `https://liquipedia.net/dota2/Special:Stream/${platform}/${path}`
    return { platform, url: directStreamUrl(platform, path, twitchChannel) ?? fallbackUrl, fallbackUrl }
  })

  return { unix: unix || null, streams }
}

/** "Upper Bracket Quarterfinals" -> "UB QF"; keeps anything it doesn't recognise. */
function shortenRound(round) {
  return round
    .replace(/Upper Bracket/i, 'UB')
    .replace(/Lower Bracket/i, 'LB')
    .replace(/Quarterfinals?/i, 'QF')
    .replace(/Semifinals?/i, 'SF')
    .replace(/\bRound (\d+)/i, 'R$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function classifyBracket(round) {
  if (/grand final/i.test(round)) return 'grand-final'
  if (/lower/i.test(round)) return 'lower'
  if (/upper/i.test(round)) return 'upper'
  return 'other'
}

/**
 * Reads the bracket's column layout from the graphical bracket pane.
 *
 * Liquipedia emits one `.brkts-round-header` container per half of the bracket
 * (upper first — the grand final belongs to it — then lower), and each header
 * carries a `--skip-round` offset. That offset is what pushes "Upper Bracket
 * Final" into column 4 instead of 3, so honouring it reproduces the real
 * bracket shape instead of a guess.
 */
function parseBracketLayout(html) {
  const starts = [...html.matchAll(/class="brkts-round-header"/g)].map((m) => m.index)
  if (!starts.length) return null

  const rounds = []
  starts.forEach((start, index) => {
    const segment = html.slice(start, starts[index + 1] ?? html.length)
    const headers = [
      ...segment.matchAll(/class="brkts-header brkts-header-div"[^>]*style="([^"]*)"[^>]*>([^<]*)</g),
    ]

    let column = 0
    for (const [, style, rawName] of headers) {
      column += 1 + Number(/--skip-round:(\d+)/.exec(style)?.[1] ?? 0)
      const name = text(rawName)
      if (!name) continue
      rounds.push({
        name,
        short: shortenRound(name),
        // The grand final is listed under the upper header row but is drawn
        // between the two halves, so it gets its own row.
        row: classifyBracket(name) === 'grand-final' ? 'final' : index === 0 ? 'upper' : 'lower',
        column,
      })
    }
  })

  if (!rounds.length) return null
  return { columns: Math.max(...rounds.map((r) => r.column)), rounds }
}

function parseSchedule(html, twitchChannel) {
  const pane = extractScheduleTable(html)
  const rows = [...pane.matchAll(/<tr class="table2__row--body">([\s\S]*?)<\/tr>/g)].map((m) => m[1])
  if (!rows.length) throw new Error('Schedule table has no rows — page layout changed')

  const matches = rows.map((row, index) => {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1])
    if (cells.length < 5) throw new Error(`Row ${index} has ${cells.length} cells, expected >= 5`)

    const [dateCell, roundCell, leftCell, scoreCell, rightCell, linkCell = ''] = cells

    const { unix, streams } = parseDateCell(dateCell, twitchChannel)
    const round = text(roundCell)
    const { bestOf, score, winner } = parseScoreCell(scoreCell)

    // e.g. "Match:ID_TI2026Main_R01-M001" — stable per match, so the client can
    // keep per-match UI state across refreshes.
    const id = /Match:ID[_ ]([A-Za-z0-9_-]+)/.exec(linkCell)?.[1] ?? null
    // Liquipedia only links a match page once it exists; before that the button
    // is editor-only (`show-when-logged-in`).
    const hasPublicPage = id && !/show-when-logged-in/.test(linkCell)

    return {
      id: id ?? `row-${index}`,
      order: index,
      round,
      roundShort: shortenRound(round),
      bracket: classifyBracket(round),
      startsAtUnix: unix,
      startsAt: unix ? new Date(unix * 1000).toISOString() : null,
      bestOf,
      teams: [parseTeamCell(leftCell), parseTeamCell(rightCell)],
      score,
      winner,
      finished: score !== null,
      streams,
      matchUrl: hasPublicPage ? `https://liquipedia.net/dota2/Match:ID_${id}` : null,
    }
  })

  return matches.sort((a, b) => (a.startsAtUnix ?? Infinity) - (b.startsAtUnix ?? Infinity))
}

// ---------------------------------------------------------------- sanity checks

/**
 * Refuse to overwrite good data with a bad parse. A layout change upstream
 * should fail the sync loudly, not silently empty the app.
 */
function validate(matches) {
  const problems = []
  if (matches.length < 4) problems.push(`only ${matches.length} matches parsed`)
  if (!matches.some((m) => m.startsAtUnix)) problems.push('no match has a timestamp')
  if (!matches.some((m) => m.round)) problems.push('no match has a round name')
  if (matches.every((m) => m.teams.every((t) => t.tbd))) problems.push('every opponent is TBD')
  if (problems.length) throw new Error(`Parsed data failed sanity checks: ${problems.join('; ')}`)
}

// ---------------------------------------------------------------- main

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUT_FILE, 'utf8'))
  } catch {
    return null
  }
}

const argValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

async function main() {
  const force = process.argv.includes('--force')
  // `--page=` / `--out=` exist so the same parser can be pointed at another
  // edition (handy for verifying it still handles finished tournaments).
  const page = argValue('page') ?? PAGE
  const outFile = argValue('out') ? resolve(process.cwd(), argValue('out')) : OUT_FILE
  const previous = await readPrevious()

  if (!force && previous?.updatedAt) {
    const age = Date.now() - Date.parse(previous.updatedAt)
    if (age >= 0 && age < MIN_INTERVAL_MS) {
      const wait = Math.ceil((MIN_INTERVAL_MS - age) / 1000)
      console.log(`Last sync was ${Math.round(age / 1000)}s ago. Liquipedia asks for 30s between`)
      console.log(`action=parse calls — try again in ${wait}s (or pass --force).`)
      return
    }
  }

  console.log(`Fetching "${page}" from Liquipedia…`)
  const { html, wikitext } = await fetchPage(page)

  const twitchChannel = parseTwitchChannel(wikitext)
  const matches = parseSchedule(html, twitchChannel)
  validate(matches)

  // Optional: the list view works without it, the bracket view falls back to
  // deriving columns from round order.
  const layout = parseBracketLayout(html)

  const payload = {
    tournament: { ...TOURNAMENT, sourceUrl: `${WIKI}/${page.replace(/ /g, '_')}` },
    updatedAt: new Date().toISOString(),
    matchCount: matches.length,
    layout,
    matches,
  }

  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`)

  const finished = matches.filter((m) => m.finished).length
  const decided = matches.filter((m) => m.teams.every((t) => !t.tbd)).length
  console.log(`Wrote ${matches.length} matches to ${outFile.replace(`${ROOT}/`, '')}`)
  console.log(`  ${finished} finished, ${decided} with both opponents known`)
  console.log(
    layout
      ? `  bracket layout: ${layout.rounds.length} rounds across ${layout.columns} columns`
      : '  bracket layout: not found (bracket view will fall back to round order)'
  )
  console.log(`  first: ${matches[0]?.startsAt}  last: ${matches.at(-1)?.startsAt}`)
}

main().catch((err) => {
  console.error(`\nSync failed: ${err.message}`)
  console.error('Existing public/data/schedule.json was left untouched.')
  process.exitCode = 1
})
