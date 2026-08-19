/* The International 2026 — schedule PWA.
   Renders the match list from data/schedule.json in the viewer's timezone. */

const DATA_URL = 'data/schedule.json'
const STORE_DATA = 'ti2026:data'
const STORE_TZ = 'ti2026:tz'
const STORE_HIDE_PAST = 'ti2026:hidePast'
const STORE_VIEW = 'ti2026:view'

/** Refetch when the app is reopened and the cached copy is older than this. */
const STALE_MS = 60_000

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const el = {
  app: document.getElementById('app'),
  banner: document.getElementById('banner'),
  refresh: document.getElementById('refresh'),
  tz: document.getElementById('tz'),
  togglePast: document.getElementById('toggle-past'),
  viewList: document.getElementById('view-list'),
  viewBracket: document.getElementById('view-bracket'),
  subtitle: document.getElementById('subtitle'),
  updated: document.getElementById('updated'),
  footerTz: document.getElementById('footer-tz'),
  sourceLink: document.getElementById('source-link'),
  ics: document.getElementById('ics'),
  sheet: document.getElementById('sheet'),
  sheetBody: document.getElementById('sheet-body'),
}

const state = {
  data: null,
  tzMode: localStorage.getItem(STORE_TZ) || 'local',
  // Bracket is the default; only an explicit choice of "list" overrides it.
  view: localStorage.getItem(STORE_VIEW) === 'list' ? 'list' : 'bracket',
  hidePast: localStorage.getItem(STORE_HIDE_PAST) === '1',
  loading: false,
  /** Id of the match whose detail sheet is open, if any. */
  openMatchId: null,
  /** Signature of the last render, so the 1s tick only re-renders on real change. */
  signature: '',
}

// ---------------------------------------------------------------- time helpers

const eventTz = () => state.data?.tournament?.eventTimeZone || 'Asia/Shanghai'

function activeTz() {
  if (state.tzMode === 'event') return eventTz()
  if (state.tzMode === 'utc') return 'UTC'
  return LOCAL_TZ
}

function partsIn(date, tz, opts) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts }).formatToParts(date)
  return Object.fromEntries(parts.map((p) => [p.type, p.value]))
}

/** Calendar day of `date` as seen from `tz`, as "YYYY-MM-DD". */
function dayKey(date, tz) {
  const p = partsIn(date, tz, { year: 'numeric', month: '2-digit', day: '2-digit' })
  return `${p.year}-${p.month}-${p.day}`
}

const fmtTime = (date, tz) =>
  new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(
    date
  )

const fmtDayLong = (date, tz) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(date)

const fmtWeekday = (date, tz) =>
  new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long' }).format(date)

function tzOffsetLabel(tz) {
  const p = partsIn(new Date(), tz, { timeZoneName: 'shortOffset' })
  return p.timeZoneName || ''
}

/** "6h 12m", "2d 6h", "45s" — coarse-grained, for list rows. */
function humanDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** "2d 06:12:45" / "06:12:45" — precise, for the hero countdown. */
function preciseCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const pad = (n) => String(n).padStart(2, '0')
  const clock = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(
    s % 60
  )}`
  return d > 0 ? `${d}d ${clock}` : clock
}

/** `nowMs` is a timestamp, matching every other now-taking helper here. */
function relativeDayLabel(date, tz, nowMs) {
  const target = dayKey(date, tz)
  if (target === dayKey(nowMs, tz)) return 'Today'

  const oneDay = 86_400_000
  if (target === dayKey(nowMs + oneDay, tz)) return 'Tomorrow'
  if (target === dayKey(nowMs - oneDay, tz)) return 'Yesterday'
  return fmtWeekday(date, tz)
}

// ---------------------------------------------------------------- match status

/**
 * Liquipedia publishes results a little after a series ends, so a match that
 * started but has no score yet is treated as live for a generous window and as
 * "result pending" after that.
 */
const liveWindowMs = (match) => ((match.bestOf || 3) * 60 + 45) * 60_000

function statusOf(match, now) {
  if (match.finished) return 'finished'
  if (!match.startsAtUnix) return 'scheduled'
  const start = match.startsAtUnix * 1000
  if (now < start) return 'upcoming'
  if (now < start + liveWindowMs(match)) return 'live'
  return 'pending'
}

// ---------------------------------------------------------------- team visuals

function teamInitials(team) {
  if (team.tbd) return '?'
  const short = (team.short || '').trim()
  if (short && short.length <= 3) return short.toUpperCase()

  const words = (team.name || '').split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (team.name || '?').slice(0, 2).toUpperCase()
}

function teamColor(team) {
  if (team.tbd) return 'rgba(255,255,255,.06)'
  let hash = 7
  for (const ch of team.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${hash % 360} 52% 40%)`
}

const BRACKET_COLOR = {
  upper: 'var(--upper)',
  lower: 'var(--lower)',
  'grand-final': 'var(--grand)',
  other: 'var(--other)',
}

// ---------------------------------------------------------------- rendering

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )

const ICONS = {
  twitch: '<path d="M4 3h16v11l-4 4h-3l-3 3H8v-3H4V3Zm5 4v5m5-5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  youtube:
    '<path d="M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8Zm7 1.5v5l4.5-2.5L10 9.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  calendar:
    '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6Zm4-4v4m8-4v4M4 10h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  external:
    '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
}

function teamRow(team, { score, isWinner, isLoser, showScore }) {
  const classes = ['team']
  if (team.tbd) classes.push('team--tbd')
  if (isWinner) classes.push('team--winner')
  if (isLoser) classes.push('team--loser')

  return `
    <div class="${classes.join(' ')}">
      <span class="team__badge" style="--team-color:${teamColor(team)}">${escapeHtml(
        teamInitials(team)
      )}</span>
      <span class="team__name">${escapeHtml(team.name)}</span>
      ${showScore ? `<span class="team__score">${score ?? '–'}</span>` : ''}
    </div>`
}

function matchCard(match, tz, now) {
  const status = statusOf(match, now)
  const date = match.startsAtUnix ? new Date(match.startsAtUnix * 1000) : null
  const showScore = status === 'finished'

  const classes = ['match']
  if (status === 'live') classes.push('match--live')
  if (status === 'finished') classes.push('match--finished')

  const foot =
    status === 'live'
      ? '<span class="live-dot">Live</span>'
      : status === 'upcoming'
        ? `<span class="match__rel" data-countdown="${match.startsAtUnix}">in ${humanDuration(
            date - now
          )}</span>`
        : status === 'pending'
          ? '<span class="match__rel">Result pending</span>'
          : status === 'finished'
            ? '<span class="match__rel">Finished</span>'
            : '<span class="match__rel">Time to be announced</span>'

  const streamLinks =
    status === 'finished'
      ? ''
      : (match.streams || [])
          .filter((s) => ICONS[s.platform])
          .map(
            (s) =>
              `<a class="match__link" href="${escapeHtml(s.url)}" target="_blank" rel="noopener"
                  title="Watch on ${escapeHtml(s.platform)}" aria-label="Watch on ${escapeHtml(
                    s.platform
                  )}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[s.platform]}</svg></a>`
          )
          .join('')

  const calendarBtn =
    date && status !== 'finished'
      ? `<button class="match__link" type="button" data-ics="${escapeHtml(match.id)}"
           title="Add to calendar" aria-label="Add this match to calendar">
           <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.calendar}</svg></button>`
      : ''

  return `
    <article class="${classes.join(' ')}" data-mid="${escapeHtml(match.id)}" tabindex="0"
      role="button" aria-label="Match details: ${escapeHtml(
        match.teams.map((t) => t.name).join(' versus ')
      )}"
      style="--accent:${BRACKET_COLOR[match.bracket] || BRACKET_COLOR.other}">
      <div class="match__top">
        <span class="match__round" title="${escapeHtml(match.round)}"
          ><span class="match__round--full">${escapeHtml(match.round)}</span
          ><span class="match__round--short">${escapeHtml(match.roundShort)}</span></span
        >
        ${match.bestOf ? `<span class="match__bo">Bo${match.bestOf}</span>` : ''}
        <span class="match__time">${date ? fmtTime(date, tz) : 'TBA'}</span>
      </div>

      <div class="match__teams">
        ${teamRow(match.teams[0], {
          score: match.score?.[0],
          isWinner: match.winner === 0,
          isLoser: match.winner === 1,
          showScore,
        })}
        ${teamRow(match.teams[1], {
          score: match.score?.[1],
          isWinner: match.winner === 1,
          isLoser: match.winner === 0,
          showScore,
        })}
      </div>

      <div class="match__foot">
        ${foot}
        <span class="match__links">${streamLinks}${calendarBtn}</span>
      </div>
    </article>`
}

function heroCard(match, tz, now) {
  const date = new Date(match.startsAtUnix * 1000)
  const live = statusOf(match, now) === 'live'
  const [a, b] = match.teams

  return `
    <section class="hero" data-mid="${escapeHtml(match.id)}" tabindex="0" role="button"
      aria-label="Match details: ${escapeHtml(match.teams.map((t) => t.name).join(' versus '))}">
      <div class="hero__label">
        ${live ? '<span class="live-dot">Live now</span>' : '<span>Next match</span>'}
        <span class="hero__round" style="--accent:${
          BRACKET_COLOR[match.bracket] || BRACKET_COLOR.other
        }" title="${escapeHtml(match.round)}">${escapeHtml(match.roundShort)}</span>
      </div>

      <div class="hero__teams">
        <span>${escapeHtml(a.name)}</span>
        <span class="hero__vs">vs</span>
        <span>${escapeHtml(b.name)}</span>
      </div>

      ${
        live
          ? '<div class="hero__countdown">In progress</div>'
          : `<div class="hero__countdown" data-precise="${match.startsAtUnix}">${preciseCountdown(
              date - now
            )}</div>`
      }
      <div class="hero__when">${escapeHtml(
        relativeDayLabel(date, tz, now)
      )}, ${fmtDayLong(date, tz)} · ${fmtTime(date, tz)}</div>
    </section>`
}

// ---------------------------------------------------------------- bracket view

/** Bracket position within a round, from the Liquipedia id (…_R02-M003 -> 3). */
const matchSeq = (match) => Number(/-M(\d+)/.exec(match.id)?.[1] ?? match.order)

/**
 * Column/row layout for the bracket. `sync.mjs` lifts this straight out of
 * Liquipedia's own markup; the fallback only matters if that ever disappears.
 */
function bracketLayout(data) {
  if (data.layout?.rounds?.length) return data.layout

  const rounds = []
  let column = 0
  for (const match of [...data.matches].sort(
    (a, b) => (a.startsAtUnix ?? 0) - (b.startsAtUnix ?? 0)
  )) {
    if (rounds.some((r) => r.name === match.round)) continue
    rounds.push({
      name: match.round,
      short: match.roundShort,
      row: match.bracket === 'grand-final' ? 'final' : match.bracket === 'lower' ? 'lower' : 'upper',
      column: ++column,
    })
  }
  return { columns: column, rounds }
}

function matchesByRound(data) {
  const map = new Map()
  for (const match of data.matches) {
    if (!map.has(match.round)) map.set(match.round, [])
    map.get(match.round).push(match)
  }
  // Bracket order, not chronological — LB QF M003 is played after M004.
  for (const list of map.values()) list.sort((a, b) => matchSeq(a) - matchSeq(b))
  return map
}

/**
 * Which match feeds which. Two shapes cover a double-elimination bracket:
 * a round that halves (two feeders per match) and one that carries straight
 * over (one feeder). Anything else is left unconnected rather than guessed.
 */
function bracketEdges(layout, byRound) {
  const edges = []
  const rowRounds = (row) =>
    layout.rounds.filter((r) => r.row === row).sort((a, b) => a.column - b.column)

  for (const row of ['upper', 'lower']) {
    const rounds = rowRounds(row)
    for (let i = 1; i < rounds.length; i++) {
      const from = byRound.get(rounds[i - 1].name) ?? []
      const to = byRound.get(rounds[i].name) ?? []
      if (!from.length || !to.length) continue

      if (from.length === to.length * 2) {
        to.forEach((target, j) => {
          edges.push([from[2 * j].id, target.id])
          edges.push([from[2 * j + 1].id, target.id])
        })
      } else if (from.length === to.length) {
        to.forEach((target, j) => edges.push([from[j].id, target.id]))
      }
    }
  }

  // Both bracket finals feed the grand final.
  const finalRound = layout.rounds.find((r) => r.row === 'final')
  const grandFinal = finalRound && (byRound.get(finalRound.name) ?? [])[0]
  if (grandFinal) {
    for (const row of ['upper', 'lower']) {
      const last = rowRounds(row).at(-1)
      const feeder = last && (byRound.get(last.name) ?? []).at(-1)
      if (feeder) edges.push([feeder.id, grandFinal.id])
    }
  }

  return edges
}

function bracketTeamRow(team, { score, isWinner, isLoser, showScore }) {
  const classes = ['bteam']
  if (team.tbd) classes.push('bteam--tbd')
  if (isWinner) classes.push('bteam--winner')
  if (isLoser) classes.push('bteam--loser')

  return `
    <div class="${classes.join(' ')}">
      <span class="bteam__badge" style="--team-color:${teamColor(team)}">${escapeHtml(
        teamInitials(team)
      )}</span>
      <span class="bteam__name">${escapeHtml(team.name)}</span>
      <span class="bteam__score">${showScore ? score : ''}</span>
    </div>`
}

function bracketCard(match, tz, nowMs) {
  const status = statusOf(match, nowMs)
  const date = match.startsAtUnix ? new Date(match.startsAtUnix * 1000) : null
  const showScore = status === 'finished'

  const classes = ['bmatch']
  if (status === 'live') classes.push('bmatch--live')
  if (status === 'finished') classes.push('bmatch--finished')

  const when = date
    ? `${new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short' }).format(
        date
      )} ${fmtTime(date, tz)}`
    : 'TBA'

  return `
    <article class="${classes.join(' ')}" data-mid="${escapeHtml(match.id)}" tabindex="0"
      role="button" aria-label="Match details: ${escapeHtml(
        match.teams.map((t) => t.name).join(' versus ')
      )}"
      style="--accent:${BRACKET_COLOR[match.bracket] || BRACKET_COLOR.other}">
      <div class="bmatch__meta">
        <span class="bmatch__when">${escapeHtml(when)}</span>
        ${
          status === 'live'
            ? '<span class="live-dot">Live</span>'
            : match.bestOf
              ? `<span class="bmatch__bo">Bo${match.bestOf}</span>`
              : ''
        }
      </div>
      ${bracketTeamRow(match.teams[0], {
        score: match.score?.[0],
        isWinner: match.winner === 0,
        isLoser: match.winner === 1,
        showScore,
      })}
      ${bracketTeamRow(match.teams[1], {
        score: match.score?.[1],
        isWinner: match.winner === 1,
        isLoser: match.winner === 0,
        showScore,
      })}
    </article>`
}

function bracketMarkup(data, tz, nowMs) {
  const layout = bracketLayout(data)
  const byRound = matchesByRound(data)

  // Grid rows: 1 upper headers, 2 upper matches, 3 lower headers, 4 lower matches.
  const ROW_POS = { upper: [1, 2], lower: [3, 4] }

  const cells = layout.rounds.flatMap((round) => {
    const matches = byRound.get(round.name) ?? []
    const cards = matches.map((m) => bracketCard(m, tz, nowMs)).join('')

    if (round.row === 'final') {
      // Drawn between the two halves, so it spans every match row.
      return [
        `<div class="bracket__head bracket__head--final" style="grid-column:${round.column};grid-row:1">
           <span>${escapeHtml(round.name)}</span></div>`,
        `<div class="bracket__col bracket__col--final" style="grid-column:${round.column};grid-row:2 / span 3">
           ${cards}</div>`,
      ]
    }

    const [headRow, bodyRow] = ROW_POS[round.row]
    return [
      `<div class="bracket__head" style="grid-column:${round.column};grid-row:${headRow}">
         <span>${escapeHtml(round.name)}</span></div>`,
      `<div class="bracket__col" style="grid-column:${round.column};grid-row:${bodyRow}">
         ${cards}</div>`,
    ]
  })

  return `
    <div class="bracket">
      <div class="bracket__inner" style="--cols:${layout.columns}">
        <svg class="bracket__lines" aria-hidden="true" focusable="false"></svg>
        ${cells.join('')}
      </div>
    </div>`
}

/**
 * Connectors are drawn after layout from real element positions, so they stay
 * correct whatever the cards end up measuring.
 */
function drawBracketLines() {
  const inner = el.app.querySelector('.bracket__inner')
  const svg = inner?.querySelector('.bracket__lines')
  if (!inner || !svg || !state.data) return

  const layout = bracketLayout(state.data)
  const edges = bracketEdges(layout, matchesByRound(state.data))

  const width = inner.scrollWidth
  const height = inner.scrollHeight
  svg.setAttribute('width', width)
  svg.setAttribute('height', height)
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

  const box = inner.getBoundingClientRect()
  const anchor = (id, side) => {
    const node = inner.querySelector(`[data-mid="${CSS.escape(id)}"]`)
    if (!node) return null
    const r = node.getBoundingClientRect()
    return { x: (side === 'right' ? r.right : r.left) - box.left, y: r.top - box.top + r.height / 2 }
  }

  const paths = []
  for (const [fromId, toId] of edges) {
    const a = anchor(fromId, 'right')
    const b = anchor(toId, 'left')
    if (!a || !b || b.x <= a.x) continue
    const mid = a.x + (b.x - a.x) / 2
    paths.push(`M${a.x} ${a.y} H${mid} V${b.y} H${b.x}`)
  }

  svg.innerHTML = paths
    .map((d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" />`)
    .join('')
}

// ---------------------------------------------------------------- render

function render() {
  const data = state.data
  if (!data) return

  const tz = activeTz()
  const nowMs = Date.now()

  if (state.view === 'bracket') {
    renderChrome(data, tz, nowMs)
    const next = nextMatch(data.matches, nowMs)
    el.app.innerHTML = (next ? heroCard(next, tz, nowMs) : '') + bracketMarkup(data, tz, nowMs)
    state.signature = signatureOf(data.matches, nowMs)
    // Lay out first, then measure.
    requestAnimationFrame(drawBracketLines)
    return
  }

  renderList(data, tz, nowMs)
}

const nextMatch = (matches, nowMs) =>
  [...matches]
    .sort((a, b) => (a.startsAtUnix ?? Infinity) - (b.startsAtUnix ?? Infinity))
    .find((m) => {
      const s = statusOf(m, nowMs)
      return (s === 'upcoming' || s === 'live') && m.startsAtUnix
    })

function renderChrome(data, tz, nowMs) {
  // The list reads best in a narrow column; the bracket wants the whole window.
  el.app.classList.toggle('app--bracket', state.view === 'bracket')
  el.subtitle.textContent = `${data.tournament.stage} · ${data.tournament.city}, ${data.tournament.country}`
  el.footerTz.textContent = `${tz} (${tzOffsetLabel(tz)})`
  el.sourceLink.href = data.tournament.sourceUrl
  el.updated.textContent = data.updatedAt
    ? `${humanDuration(nowMs - Date.parse(data.updatedAt))} ago`
    : '—'

  // Both views route through here, so this keeps an open sheet in step with a
  // timezone switch, a data refresh or a status flip.
  if (state.openMatchId) openMatchSheet(state.openMatchId)
}

function renderList(data, tz, nowMs) {
  let matches = [...data.matches].sort(
    (a, b) => (a.startsAtUnix ?? Infinity) - (b.startsAtUnix ?? Infinity)
  )
  if (state.hidePast) matches = matches.filter((m) => statusOf(m, nowMs) !== 'finished')

  const upcoming = nextMatch(matches, nowMs)

  const groups = new Map()
  for (const match of matches) {
    const key = match.startsAtUnix ? dayKey(new Date(match.startsAtUnix * 1000), tz) : 'tba'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(match)
  }

  const sections = [...groups.entries()].map(([key, items]) => {
    if (key === 'tba') {
      return `<section class="day">
          <div class="day__head"><span class="day__name">Date to be announced</span></div>
          ${items.map((m) => matchCard(m, tz, nowMs)).join('')}
        </section>`
    }

    const date = new Date(items[0].startsAtUnix * 1000)
    const label = relativeDayLabel(date, tz, nowMs)
    const isToday = label === 'Today'

    return `<section class="day">
        <div class="day__head${isToday ? ' day__head--today' : ''}">
          <span class="day__name">${escapeHtml(label)}</span>
          <span class="day__date">${fmtDayLong(date, tz)}</span>
        </div>
        ${items.map((m) => matchCard(m, tz, nowMs)).join('')}
      </section>`
  })

  el.app.innerHTML =
    (upcoming ? heroCard(upcoming, tz, nowMs) : '') +
    (sections.length ? sections.join('') : '<p class="empty">No matches to show.</p>')

  renderChrome(data, tz, nowMs)
  state.signature = signatureOf(data.matches, nowMs)
}

/**
 * Changes only when something the layout depends on changes. Always computed
 * over every match, so the 1s tick can compare it without caring which view or
 * filter is active.
 */
const signatureOf = (matches, nowMs) =>
  matches.map((m) => `${m.id}:${statusOf(m, nowMs)}:${m.score ?? ''}`).join('|')

// ---------------------------------------------------------------- match detail sheet

const PLATFORM_LABEL = { twitch: 'Twitch', youtube: 'YouTube' }

function sheetMarkup(match, tz, nowMs) {
  const status = statusOf(match, nowMs)
  const date = match.startsAtUnix ? new Date(match.startsAtUnix * 1000) : null
  const showScore = status === 'finished'
  const accent = BRACKET_COLOR[match.bracket] || BRACKET_COLOR.other

  const statusLine =
    status === 'live'
      ? '<span class="live-dot">Live now</span>'
      : status === 'upcoming'
        ? `<span class="sheet__count" data-precise="${match.startsAtUnix}">${preciseCountdown(
            date - nowMs
          )}</span>`
        : status === 'finished'
          ? '<span class="sheet__count">Finished</span>'
          : status === 'pending'
            ? '<span class="sheet__count">Result pending</span>'
            : '<span class="sheet__count">Time to be announced</span>'

  const eventTz = state.data?.tournament?.eventTimeZone
  const alsoEventTime =
    date && eventTz && eventTz !== tz
      ? `<div class="sheet__row"><span>Event time</span><span>${fmtTime(
          date,
          eventTz
        )} · ${escapeHtml(state.data.tournament.city)}</span></div>`
      : ''

  const streams = (match.streams || [])
    .map(
      (s) => `<a class="sheet__action sheet__action--${escapeHtml(s.platform)}"
          href="${escapeHtml(s.url)}" target="_blank" rel="noopener">
          ${ICONS[s.platform] ? `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[s.platform]}</svg>` : ''}
          <span>Watch on ${escapeHtml(PLATFORM_LABEL[s.platform] ?? s.platform)}</span></a>`
    )
    .join('')

  return `
    <div class="sheet__grip"></div>

    <div class="sheet__head">
      <span class="sheet__round" style="--accent:${accent}">${escapeHtml(match.round)}</span>
      ${match.bestOf ? `<span class="match__bo">Bo${match.bestOf}</span>` : ''}
      <button class="sheet__close" type="button" data-close aria-label="Close">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="sheet__teams">
      ${teamRow(match.teams[0], {
        score: match.score?.[0],
        isWinner: match.winner === 0,
        isLoser: match.winner === 1,
        showScore,
      })}
      ${teamRow(match.teams[1], {
        score: match.score?.[1],
        isWinner: match.winner === 1,
        isLoser: match.winner === 0,
        showScore,
      })}
    </div>

    <div class="sheet__status">${statusLine}</div>

    <div class="sheet__rows">
      ${
        date
          ? `<div class="sheet__row"><span>Your time</span><span>${escapeHtml(
              relativeDayLabel(date, tz, nowMs)
            )}, ${fmtDayLong(date, tz)} · ${fmtTime(date, tz)}</span></div>`
          : ''
      }
      ${alsoEventTime}
    </div>

    <div class="sheet__actions">
      ${streams}
      ${
        date
          ? `<button class="sheet__action" type="button" data-ics="${escapeHtml(match.id)}">
              <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.calendar}</svg>
              <span>Add to calendar</span></button>`
          : ''
      }
      ${
        match.matchUrl
          ? `<a class="sheet__action" href="${escapeHtml(
              match.matchUrl
            )}" target="_blank" rel="noopener">
              <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.external}</svg>
              <span>Match details on Liquipedia</span></a>`
          : ''
      }
    </div>`
}

function openMatchSheet(id) {
  const match = state.data?.matches.find((m) => m.id === id)
  if (!match) return
  state.openMatchId = id
  el.sheetBody.innerHTML = sheetMarkup(match, activeTz(), Date.now())
  if (!el.sheet.open) el.sheet.showModal()
}

function closeMatchSheet() {
  state.openMatchId = null
  if (el.sheet.open) el.sheet.close()
}

// ---------------------------------------------------------------- 1s tick

function tick() {
  if (!state.data) return
  const now = Date.now()

  // A status flip (upcoming -> live -> finished) changes the layout: re-render.
  if (signatureOf(state.data.matches, now) !== state.signature) {
    render() // also rebuilds the sheet, via renderChrome
    return
  }

  // Otherwise just refresh the numbers in place — keeps scroll position intact.
  // The sheet lives outside #app, so it needs its own pass while it is open.
  for (const scope of state.openMatchId ? [el.app, el.sheet] : [el.app]) {
    for (const node of scope.querySelectorAll('[data-precise]')) {
      node.textContent = preciseCountdown(Number(node.dataset.precise) * 1000 - now)
    }
    for (const node of scope.querySelectorAll('[data-countdown]')) {
      node.textContent = `in ${humanDuration(Number(node.dataset.countdown) * 1000 - now)}`
    }
  }
}

// ---------------------------------------------------------------- data loading

function showBanner(message, kind) {
  el.banner.textContent = message
  el.banner.className = kind === 'error' ? 'banner banner--error' : 'banner'
  el.banner.hidden = false
}

const hideBanner = () => {
  el.banner.hidden = true
}

const dataAge = () =>
  state.data?.updatedAt ? humanDuration(Date.now() - Date.parse(state.data.updatedAt)) : 'a while'

/**
 * Offline is worth surfacing even when a render succeeds: the service worker
 * happily serves a cached schedule, so nothing else would tell the user that
 * scores and times may have moved on.
 */
function updateConnectionBanner() {
  if (!state.data) return
  if (navigator.onLine) hideBanner()
  else showBanner(`Offline — showing the schedule saved ${dataAge()} ago.`)
}

function applyData(data, { fromCache = false } = {}) {
  state.data = data
  render()
  if (fromCache) showBanner(`Couldn't reach the network — showing the schedule saved ${dataAge()} ago.`)
  else updateConnectionBanner()
}

async function load({ silent = false } = {}) {
  if (state.loading) return
  state.loading = true
  el.refresh.classList.add('is-busy')

  try {
    const res = await fetch(`${DATA_URL}?ts=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data.matches)) throw new Error('malformed schedule')

    localStorage.setItem(STORE_DATA, JSON.stringify(data))
    applyData(data)
  } catch (err) {
    const cached = localStorage.getItem(STORE_DATA)
    if (cached) {
      applyData(JSON.parse(cached), { fromCache: true })
    } else if (!silent) {
      el.app.innerHTML = '<p class="empty">Could not load the schedule.</p>'
      showBanner(`Could not load the schedule (${err.message}).`, 'error')
    }
  } finally {
    state.loading = false
    el.refresh.classList.remove('is-busy')
  }
}

// ---------------------------------------------------------------- calendar export

const icsEscape = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')

/**
 * RFC 5545 caps content lines at 75 octets; continuations start with a space.
 * Folding by code point rather than octet is fine here because the text we emit
 * is ASCII apart from team names, which stay far below the limit.
 */
function foldLine(line) {
  const chunks = []
  let rest = line
  while (rest.length > 74) {
    chunks.push(rest.slice(0, 74))
    rest = ` ${rest.slice(74)}`
  }
  chunks.push(rest)
  return chunks.join('\r\n')
}

const icsStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

function buildIcs(matches) {
  const now = new Date()
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//The International 2026 Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:The International 2026',
  ]

  for (const match of matches) {
    if (!match.startsAtUnix) continue
    const start = new Date(match.startsAtUnix * 1000)
    const end = new Date(start.getTime() + (match.bestOf || 3) * 55 * 60_000)
    const teams = match.teams.map((t) => t.name).join(' vs ')

    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsEscape(match.id)}@ti2026-schedule`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(end)}`,
      foldLine(`SUMMARY:${icsEscape(`TI 2026 ${match.roundShort}: ${teams}`)}`),
      foldLine(
        `DESCRIPTION:${icsEscape(
          `${match.round} - best of ${match.bestOf || 3}. The International 2026, ${
            state.data?.tournament?.city ?? ''
          }.`
        )}`
      ),
      foldLine(`URL:${icsEscape(match.matchUrl || state.data?.tournament?.sourceUrl || '')}`),
      'END:VEVENT'
    )
  }

  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

function downloadIcs(matches, filename) {
  const blob = new Blob([buildIcs(matches)], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------------------------------------------------------------- wiring

function buildTzOptions() {
  // Kept short so the control never truncates on a narrow phone; the resolved
  // zone name is spelled out in the footer.
  const options = [
    { value: 'local', label: `Your time (${tzOffsetLabel(LOCAL_TZ)})` },
    { value: 'event', label: `Event time (${tzOffsetLabel(eventTz())})` },
    { value: 'utc', label: 'UTC' },
  ]
  el.tz.innerHTML = options
    .map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`)
    .join('')
  el.tz.value = state.tzMode
  el.tz.title = `Showing times in ${activeTz()}`
}

/**
 * The day headers stick below the topbar, so they need its real height rather
 * than a hardcoded guess (it changes with safe-area insets and text scaling).
 */
function trackTopbarHeight() {
  const topbar = document.querySelector('.topbar')
  const apply = () =>
    document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)
  apply()
  if ('ResizeObserver' in window) new ResizeObserver(apply).observe(topbar)
  window.addEventListener('orientationchange', () => setTimeout(apply, 200))
}

el.tz.addEventListener('change', () => {
  state.tzMode = el.tz.value
  localStorage.setItem(STORE_TZ, state.tzMode)
  el.tz.title = `Showing times in ${activeTz()}`
  render()
})

function applyViewButtons() {
  el.viewList.setAttribute('aria-pressed', String(state.view === 'list'))
  el.viewBracket.setAttribute('aria-pressed', String(state.view === 'bracket'))
  // Filtering matches out of a bracket would break the tree, so it is list-only.
  el.togglePast.hidden = state.view !== 'list'
}

function setView(view) {
  if (state.view === view) return
  state.view = view
  localStorage.setItem(STORE_VIEW, view)
  applyViewButtons()
  render()
}

el.viewList.addEventListener('click', () => setView('list'))
el.viewBracket.addEventListener('click', () => setView('bracket'))

el.togglePast.addEventListener('click', () => {
  state.hidePast = !state.hidePast
  localStorage.setItem(STORE_HIDE_PAST, state.hidePast ? '1' : '0')
  el.togglePast.setAttribute('aria-pressed', String(state.hidePast))
  el.togglePast.title = state.hidePast ? 'Show finished matches' : 'Hide finished matches'
  render()
})

// Connector geometry depends on measured positions, so it must be recomputed
// whenever the bracket is re-laid-out.
window.addEventListener('resize', () => {
  if (state.view === 'bracket') drawBracketLines()
})

el.refresh.addEventListener('click', () => load())

el.ics.addEventListener('click', () => {
  if (!state.data) return
  downloadIcs(state.data.matches, 'the-international-2026.ics')
})

/** Calendar buttons appear both on list cards and inside the sheet. */
function handleIcsClick(event) {
  const button = event.target.closest('[data-ics]')
  if (!button || !state.data) return true
  const match = state.data.matches.find((m) => m.id === button.dataset.ics)
  if (match) downloadIcs([match], `ti2026-${match.id}.ics`)
  return false
}

// Delegated — cards are re-rendered constantly.
el.app.addEventListener('click', (event) => {
  if (handleIcsClick(event) === false) return
  // Let the stream links and calendar buttons on a card do their own thing.
  if (event.target.closest('a, button')) return

  const card = event.target.closest('[data-mid]')
  if (card) openMatchSheet(card.dataset.mid)
})

// Cards are focusable, so make them respond like buttons.
el.app.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const card = event.target.closest('[data-mid]')
  if (!card) return
  event.preventDefault()
  openMatchSheet(card.dataset.mid)
})

el.sheet.addEventListener('click', (event) => {
  if (handleIcsClick(event) === false) return
  if (event.target.closest('[data-close]')) {
    closeMatchSheet()
    return
  }
  // Clicking the backdrop means clicking the <dialog> itself.
  if (event.target === el.sheet) closeMatchSheet()
})

el.sheet.addEventListener('close', () => {
  state.openMatchId = null
})

window.addEventListener('offline', updateConnectionBanner)
window.addEventListener('online', () => {
  updateConnectionBanner()
  load({ silent: true })
})

// Coming back to the app after a while should show fresh data.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.data) return
  const age = Date.now() - Date.parse(state.data.updatedAt || 0)
  if (!Number.isFinite(age) || age > STALE_MS) load({ silent: true })
})

// ---------------------------------------------------------------- boot

buildTzOptions()
trackTopbarHeight()
applyViewButtons()
el.togglePast.setAttribute('aria-pressed', String(state.hidePast))
el.togglePast.title = state.hidePast ? 'Show finished matches' : 'Hide finished matches'

// Paint instantly from the last known copy, then refresh from the network.
const cached = localStorage.getItem(STORE_DATA)
if (cached) {
  try {
    state.data = JSON.parse(cached)
    render()
  } catch {
    localStorage.removeItem(STORE_DATA)
  }
}

load({ silent: Boolean(cached) })
setInterval(tick, 1000)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline support is a bonus; the app works without it */
    })
  })
}
