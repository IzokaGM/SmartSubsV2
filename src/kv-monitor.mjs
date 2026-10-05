/** Mobile KV monitor: usage is persisted in the existing Delivery Relay Durable Object,
 * in a separate instance per SmartSubsV2 configuration. No Workers KV is touched here. */
import { normaliseMedia } from './kv-usage.mjs'

const METHODS = ['get', 'put', 'list', 'delete']
const CATEGORIES = ['translation-cache', 'queue-state', 'diagnostics', 'other']
const WINDOW_MS = 7 * 86400000
const DAY_MS = 86400000
const PREFIX = 'kv-monitor:v1:'

export function monitorStub(env, configId) {
  if (!/^[a-f0-9]{16}$/.test(String(configId || ''))) return null
  const binding = env?.SMARTSUBS_DELIVERY
  if (!binding?.idFromName || !binding?.get) return null
  return binding.get(binding.idFromName(`${PREFIX}${configId}`))
}

const zero = () => ({ get: 0, put: 0, list: 0, delete: 0 })
const cleanCount = counts => Object.fromEntries(METHODS.map(method => [method, Math.max(0, Math.floor(Number(counts?.[method] || 0)) || 0)]))
const plus = (a, b) => Object.fromEntries(METHODS.map(method => [method, (a?.[method] || 0) + (b?.[method] || 0)]))
const cleanCategories = categories => Object.fromEntries(CATEGORIES.map(cat => [cat, cleanCount(categories?.[cat])]))

export function reportForStorage(raw) {
  const media = normaliseMedia(raw?.media)
  const timestamp = Date.parse(raw?.timestamp)
  const requestId = String(raw?.requestId || '')
  if (!media || !Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > WINDOW_MS ||
      !/^[0-9a-f-]{36}$/i.test(requestId)) return null
  return {
    media, timestamp, requestId,
    phase: ['subtitle-list', 'player-translation', 'queue'].includes(raw.phase) ? raw.phase : 'other',
    cacheResult: String(raw.cacheResult || '').slice(0, 40),
    attempted: cleanCount(raw.attempted), succeeded: cleanCount(raw.succeeded),
    failed: cleanCount(raw.failed), categories: cleanCategories(raw.categories)
  }
}

export async function storeMonitorReport(storage, raw) {
  const event = reportForStorage(raw)
  if (!event) return false
  const date = new Date(event.timestamp).toISOString().slice(0, 10)
  const key = `usage:${date}:${event.media.type}:${event.media.id}`
  const previous = await storage.get(key)
  if (previous?.ids?.includes(event.requestId)) return false
  const next = previous || {
    media: event.media, date, requests: 0, attempted: zero(), succeeded: zero(), failed: zero(),
    categories: cleanCategories(null), phases: {}, cacheResults: {}, ids: [], last: 0
  }
  next.requests++
  next.last = Math.max(next.last, event.timestamp)
  next.attempted = plus(next.attempted, event.attempted)
  next.succeeded = plus(next.succeeded, event.succeeded)
  next.failed = plus(next.failed, event.failed)
  for (const cat of CATEGORIES) next.categories[cat] = plus(next.categories[cat], event.categories[cat])
  const phase = next.phases[event.phase] || { requests: 0, attempted: zero(), failed: zero() }
  phase.requests++
  phase.attempted = plus(phase.attempted, event.attempted)
  phase.failed = plus(phase.failed, event.failed)
  next.phases[event.phase] = phase
  if (event.cacheResult) next.cacheResults[event.cacheResult] = (next.cacheResults[event.cacheResult] || 0) + 1
  next.ids = [...next.ids, event.requestId].slice(-30)
  await storage.put(key, next)
  return true
}

export async function readMonitorReports(storage, now = Date.now()) {
  const rows = await storage.list({ prefix: 'usage:' })
  const cutoff = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - 6 * DAY_MS).toISOString().slice(0, 10)
  const reports = new Map()
  for (const report of rows.values()) {
    if (!report || report.date < cutoff) continue
    const id = `${report.media?.type}:${report.media?.id}`
    if (!report.media || !report.requests) continue
    let sum = reports.get(id)
    if (!sum) {
      sum = { media: report.media, requests: 0, attempted: zero(), succeeded: zero(), failed: zero(),
        categories: cleanCategories(null), phases: {}, cacheResults: {}, last: 0 }
      reports.set(id, sum)
    }
    sum.requests += report.requests
    sum.last = Math.max(sum.last, report.last || 0)
    sum.attempted = plus(sum.attempted, report.attempted)
    sum.succeeded = plus(sum.succeeded, report.succeeded)
    sum.failed = plus(sum.failed, report.failed)
    for (const cat of CATEGORIES) sum.categories[cat] = plus(sum.categories[cat], report.categories?.[cat])
    for (const [name, phase] of Object.entries(report.phases || {})) {
      const target = sum.phases[name] || { requests: 0, attempted: zero(), failed: zero() }
      target.requests += phase.requests
      target.attempted = plus(target.attempted, phase.attempted)
      target.failed = plus(target.failed, phase.failed)
      sum.phases[name] = target
    }
    for (const [name, count] of Object.entries(report.cacheResults || {})) sum.cacheResults[name] = (sum.cacheResults[name] || 0) + count
  }
  return [...reports.values()].sort((a, b) => b.last - a.last).slice(0, 100)
}

export async function pruneMonitorReports(storage, now = Date.now()) {
  const rows = await storage.list({ prefix: 'usage:' })
  const cutoff = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - 6 * DAY_MS).toISOString().slice(0, 10)
  for (const [key, report] of rows) {
    if (report?.date < cutoff) await storage.delete(key)
  }
  return rows.size > 0
}

// Manual measurement windows are independent of player sessions. We take differences
// of the EXISTING v1 episode totals: no changes to usage publication or Workers KV.
const ACTIVE_TEST_KEY = 'kv-test:v1:active'
const TEST_HISTORY_KEY = 'kv-test:v1:history'
const TEST_SEQUENCE_KEY = 'kv-test:v1:sequence'
const MAX_TEST_HISTORY = 20
const MAX_TEST_HOURS = 4

const subCounts = (now, before) => Object.fromEntries(METHODS.map(method =>
  [method, Math.max(0, (now?.[method] || 0) - (before?.[method] || 0))]))
const subCategories = (now, before) => Object.fromEntries(CATEGORIES.map(cat =>
  [cat, subCounts(now?.[cat], before?.[cat])]))

function reportDelta(current, baseline) {
  const prior = new Map((baseline || []).map(item => [`${item.media.type}:${item.media.id}`, item]))
  return (current || []).map(item => {
    const before = prior.get(`${item.media.type}:${item.media.id}`)
    const requests = Math.max(0, (item.requests || 0) - (before?.requests || 0))
    if (!requests) return null
    const phases = {}
    for (const [name, phase] of Object.entries(item.phases || {})) {
      const old = before?.phases?.[name]
      const qty = Math.max(0, (phase.requests || 0) - (old?.requests || 0))
      if (qty) phases[name] = {
        requests: qty,
        attempted: subCounts(phase.attempted, old?.attempted),
        failed: subCounts(phase.failed, old?.failed)
      }
    }
    const cacheResults = {}
    for (const [name, qty] of Object.entries(item.cacheResults || {})) {
      const delta = Math.max(0, qty - (before?.cacheResults?.[name] || 0))
      if (delta) cacheResults[name] = delta
    }
    return {
      media: item.media, last: item.last, requests,
      attempted: subCounts(item.attempted, before?.attempted),
      succeeded: subCounts(item.succeeded, before?.succeeded),
      failed: subCounts(item.failed, before?.failed),
      categories: subCategories(item.categories, before?.categories),
      phases, cacheResults
    }
  }).filter(Boolean)
}

function summarizeTest(reports) {
  const sum = { requests: 0, attempted: zero(), succeeded: zero(), failed: zero(), categories: cleanCategories(null) }
  for (const r of reports) {
    sum.requests += r.requests
    sum.attempted = plus(sum.attempted, r.attempted)
    sum.succeeded = plus(sum.succeeded, r.succeeded)
    sum.failed = plus(sum.failed, r.failed)
    for (const cat of CATEGORIES) sum.categories[cat] = plus(sum.categories[cat], r.categories?.[cat])
  }
  return sum
}

export async function startMonitorTest(storage, now = Date.now()) {
  if (await storage.get(ACTIVE_TEST_KEY)) return { ok: false, reason: 'A test is already running.' }
  const baseline = await readMonitorReports(storage, now)
  const number = Math.max(0, Number(await storage.get(TEST_SEQUENCE_KEY)) || 0) + 1
  const active = { id: crypto.randomUUID(), number, start: now, baseline }
  await storage.put(TEST_SEQUENCE_KEY, number)
  await storage.put(ACTIVE_TEST_KEY, active)
  return { ok: true, active: { id: active.id, number, start: active.start } }
}

export async function endMonitorTest(storage, now = Date.now()) {
  const active = await storage.get(ACTIVE_TEST_KEY)
  if (!active) return { ok: false, reason: 'No test is running.' }
  const reports = reportDelta(await readMonitorReports(storage, now), active.baseline)
  const test = {
    id: active.id, number: active.number, start: active.start, end: now, reports,
    totals: summarizeTest(reports),
    note: 'Manual time window; late queue/monitor events may not be included.'
  }
  const history = await storage.get(TEST_HISTORY_KEY) || []
  await storage.put(TEST_HISTORY_KEY, [test, ...history].slice(0, MAX_TEST_HISTORY))
  await storage.delete(ACTIVE_TEST_KEY)
  return { ok: true, test }
}

export async function pruneMonitorTestHistory(storage, now = Date.now()) {
  const history = await storage.get(TEST_HISTORY_KEY) || []
  const recent = history.filter(test => Number(test.end) > now - WINDOW_MS)
  if (recent.length !== history.length) {
    if (recent.length) await storage.put(TEST_HISTORY_KEY, recent)
    else await storage.delete(TEST_HISTORY_KEY)
  }
  const active = await storage.get(ACTIVE_TEST_KEY)
  if (active && Number(active.start) <= now - WINDOW_MS) await storage.delete(ACTIVE_TEST_KEY)
  return Boolean(recent.length || (active && Number(active.start) > now - WINDOW_MS))
}

export async function readMonitorTestState(storage, now = Date.now(), reports = null) {
  const active = await storage.get(ACTIVE_TEST_KEY)
  const history = await storage.get(TEST_HISTORY_KEY) || []
  if (!active) return { active: null, history }
  const current = reports || await readMonitorReports(storage, now)
  const runningReports = reportDelta(current, active.baseline)
  return {
    active: {
      id: active.id, number: active.number, start: active.start, reports: runningReports,
      totals: summarizeTest(runningReports),
      elapsedHours: (now - active.start) / 3600000,
      longRunning: now - active.start > MAX_TEST_HOURS * 3600000
    }, history
  }
}

export async function publishKvUsage(env, tracker) {
  const stub = monitorStub(env, tracker?.configId)
  if (!stub || !tracker?.media) return false
  const response = await stub.fetch('https://smartsubs-monitor.internal/usage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tracker.snapshot())
  })
  return response.ok
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function count(value) { return Number(value || 0).toLocaleString('en-MY') }
function metricsBlock(counts) {
  return `<div class="metrics">${METHODS.map(method => `<div><small>${{get:'Read',put:'Write',list:'List',delete:'Delete'}[method]}</small><strong>${count(counts?.[method])}</strong></div>`).join('')}</div>`
}

function formatDate(ms) { return new Date(ms).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }) }
function testSummary(test, active = false) {
  const total = test.totals || summarizeTest(test.reports || [])
  const title = `Test #${Number.isInteger(test.number) ? test.number : '–'} · ${active ? 'In progress' : 'Saved'}`
  const endTime = active ? 'In progress' : formatDate(test.end)
  const episodeRows = (test.reports || []).map(r => {
    const type = r.media.type === 'movie' ? 'Movie' : `S${r.media.season ?? '?'}E${r.media.episode ?? '?'}`
    const sources = CATEGORIES.map(cat => `<div class="detail"><span>${{ 'translation-cache':'Translation cache', 'queue-state':'Queue status', diagnostics:'Diagnostics', other:'Other' }[cat]}</span><b>${count(r.categories?.[cat]?.put)} W · ${count(r.categories?.[cat]?.get)} R</b></div>`).join('')
    return `<details class="episode"><summary><b>${escapeHtml(type)} · ${escapeHtml(r.media.id)}</b><br><small>${count(r.requests)} requests · ${count(r.attempted.put)} Write · ${count(r.attempted.get)} Read</small></summary><div class="inside">${metricsBlock(r.attempted)}${sources}</div></details>`
  }).join('')
  return `<details class="card" ${active ? 'open' : ''}><summary><small>${escapeHtml(title)} · ${escapeHtml(formatDate(test.start))}</small><h2>${count(total.attempted?.put)} Write · ${count(total.attempted?.get)} Read</h2><div class="summary"><span>${count(total.requests)} requests · ${count((test.reports || []).length)} media</span><span>${escapeHtml(endTime)}</span></div></summary><div class="inside"><h3>Test totals</h3>${metricsBlock(total.attempted)}<h3>Usage breakdown</h3>${CATEGORIES.map(cat => `<div class="detail"><span>${{ 'translation-cache':'Translation cache', 'queue-state':'Queue status', diagnostics:'Diagnostics', other:'Other' }[cat]}</span><b>${count(total.categories?.[cat]?.put)} W · ${count(total.categories?.[cat]?.get)} R</b></div>`).join('')}<h3>Movies and episodes</h3>${episodeRows || '<p class="hint">No media requests recorded during this test.</p>'}<p class="hint">${escapeHtml(test.note || 'Manual measurement window; not an automatic player session.')}</p></div></details>`
}

export function renderKvMonitor(reports, testState = { active: null, history: [] }) {
  const active = testState.active
  const history = testState.history || []
  const tests = [active ? testSummary(active, true) : '', ...history.map(t => testSummary(t))].join('')
  const cards = reports.map(report => {
    const label = report.media.type === 'movie' ? 'Movie' : `Series · Season ${report.media.season ?? '?'} · Episode ${report.media.episode ?? '?'}`
    return `<details class="card"><summary><small>${escapeHtml(label)}</small><h2>${escapeHtml(report.media.id)}</h2><div class="summary"><span>${count(report.requests)} requests recorded</span><b>${count(report.attempted?.put)} Write · ${count(report.attempted?.get)} Read</b></div><time>${escapeHtml(formatDate(report.last))}</time></summary><div class="inside">${metricsBlock(report.attempted)}<p class="hint">Cumulative operations for this episode across all tests.</p></div></details>`
  }).join('')
  const controls = active
    ? `<form method="POST" action="kv-monitor/test/end"><button type="submit" class="end">End Test</button></form><p class="hint">Started ${escapeHtml(formatDate(active.start))}. Finish playback and wait a few seconds for the last usage reports before ending the test.${active.longRunning ? ' This test has been running for over 4 hours.' : ''}</p>`
    : `<form method="POST" action="kv-monitor/test/start"><button type="submit">Start Test</button></form>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>SmartSubsV2 KV Monitor</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:22px 14px 60px;background:#101419;color:#ecf1f5;font:15px/1.45 system-ui,-apple-system,sans-serif}.wrap{max-width:680px;margin:auto}h1{font-size:25px;margin:0 0 4px}.lead{color:#a3b0bd;margin:0 0 15px}.card{background:#1b232d;border:1px solid #364353;border-radius:15px;margin:10px 0;overflow:hidden}summary{cursor:pointer;padding:16px;list-style:none}summary::-webkit-details-marker{display:none}small{color:#9fb0c2;font-size:12px}h2{font-size:17px;overflow-wrap:anywhere;margin:5px 0 9px}.summary{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.summary b{color:#ffbd68}time{display:block;color:#9fb0c2;font-size:12px;margin-top:8px}.inside{padding:0 16px 17px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.metrics>div{background:#111820;border-radius:9px;padding:10px 5px;text-align:center}.metrics strong{display:block;font-size:21px;margin-top:4px}.detail{display:flex;justify-content:space-between;gap:8px;padding:9px 0;border-bottom:1px solid #2f3c48}.detail b{white-space:nowrap}.hint{color:#a3b0bd;font-size:12px}h3{font-size:15px;margin:20px 0 5px}.empty{padding:20px;border:1px dashed #465666;border-radius:12px;color:#adbac8}button{background:#2a78e4;color:white;border:0;border-radius:10px;padding:12px 17px;font-weight:650;margin:4px 0 10px;min-height:44px}.end{background:#c35e34}.episode{background:#131b23;border:1px solid #33404d;border-radius:10px;margin:8px 0}.episode summary{padding:10px}.episode .inside{padding:4px 12px 12px}footer{color:#8a9aaa;font-size:12px;margin-top:22px}</style></head><body><main class="wrap"><h1>SmartSubsV2 KV Monitor</h1><p class="lead">Manual tests · Saved separately, even for the same episode</p>${controls}<form method="GET"><button type="submit">Refresh</button></form><h3>Test history (${history.length} · last 7 days)</h3>${tests || '<div class="empty">No tests saved. Press Start Test before playing a video.</div>'}<details><summary>All-time episode totals (last 7 days)</summary>${cards || '<div class="empty">No reports yet.</div>'}</details><footer>Each test measures the difference between Start Test and End Test. It is not a player session ID. Other simultaneous playback or late queue reports can affect attribution. Monitor storage is in a Durable Object; it adds no Workers KV operations. Keep this URL private.</footer></main></body></html>`
}
