import { createHash, timingSafeEqual } from 'node:crypto'
import manifest from './manifest.js'
import configuredManifestModule from './configured-manifest.js'
import subtitlesModule from './subtitles.js'
import tokenModule from './token.js'
import userConfigModule from './user-config.js'
import configureModule from './configure.js'
import perfModule from './perf.js'
import diagnosticsModule from './diagnostics.js'
import { CloudflareTranslationCache, cfGetOrTranslate, makeCacheKey } from './cf-cache.mjs'
import { createKvUsageTracker, trackedEnvironment } from './kv-usage.mjs'
import { monitorStub, publishKvUsage, storeMonitorReport, readMonitorReports, pruneMonitorReports, renderKvMonitor, startMonitorTest, endMonitorTest, readMonitorTestState, pruneMonitorTestHistory } from './kv-monitor.mjs'

const { createConfiguredManifest } = configuredManifestModule
const { handleSubtitles } = subtitlesModule
const { decodeTranslationTokenData } = tokenModule
const { createUserConfigToken, decodeUserConfigToken, tokenFingerprint } = userConfigModule
const { buildConfiguredUrls, validateGeminiApiKey, renderConfigurePage, escapeHtml } = configureModule
const { nowMs, roundMs, logPerf } = perfModule
const { recordDiagnostic, readDiagnostics, deriveVerdict } = diagnosticsModule

const BUILD_ID = 'v2-multicandidate-ondemand-5'
const caches = new WeakMap()
// Per-request memoization only. No cross-request stale state when the owner switches OFF.
const diagnosticStateByEnv = new WeakMap()

async function diagnosticState(env, configId) {
  if (!env || !diagnosticAdminReady(env) || !/^[a-f0-9]{16}$/.test(String(configId || ''))) return { enabled: false, since: 0 }
  const fetchState = async () => {
    const stub = monitorStub(env, configId)
    if (!stub) return { enabled: false, since: 0 }
    try {
      const response = await stub.fetch('https://smartsubs-monitor.internal/diagnostics/state')
      if (!response.ok) return { enabled: false, since: 0 }
      const data = await response.json()
      return { enabled: data.enabled === true, since: Number(data.since) || 0 }
    } catch { return { enabled: false, since: 0 } } // fail closed; never disrupt playback
  }
  // The tracked environment is newly created for each live Worker/Queue invocation.
  // Untracked direct calls are intentionally not cached across distinct invocations.
  if (!env.__kvUsageTracker) return fetchState()
  let byConfig = diagnosticStateByEnv.get(env)
  if (!byConfig) { byConfig = new Map(); diagnosticStateByEnv.set(env, byConfig) }
  if (!byConfig.has(configId)) byConfig.set(configId, fetchState())
  return byConfig.get(configId)
}

async function recordConfiguredDiagnostic(env, configId, event) {
  if (!(await diagnosticState(env, configId)).enabled) return false
  return recordDiagnostic(env.SMARTSUBS_CACHE, configId, event)
}

function diagnosticAdminReady(env) {
  return String(env?.SMARTSUBS_DIAG_ADMIN_KEY || '').length >= 6 && String(env?.SMARTSUBS_DIAG_ADMIN_KEY || '').length <= 256
}

function validDiagnosticAdminKey(submitted, stored) {
  if (typeof submitted !== 'string' || submitted.length < 6 || submitted.length > 256 ||
      typeof stored !== 'string' || stored.length < 6) return false
  const a = createHash('sha256').update(submitted, 'utf8').digest()
  const b = createHash('sha256').update(stored, 'utf8').digest()
  return timingSafeEqual(a, b)
}

function diagnosticControlHtml(state = { enabled: false }, ready = false, error = '') {
  const enabled = state.enabled === true
  const heading = enabled ? 'ON' : 'OFF'
  // When ON, keep the control compact and allow a one-tap OFF without re-entering the key.
  // Turning ON still requires the configured server-side admin key.
  if (enabled) {
    return `<section class="card"><div class="diag-control-row"><h2>Diagnostics: <span class="pill good">${heading}</span></h2><form method="POST" action="diagnose/toggle" autocomplete="off"><button class="diag-off-btn" type="submit" name="action" value="off">Turn OFF</button></form></div><p class="muted">Diagnostic events are being recorded to Workers KV.</p>${error ? `<p class="bad-text">${escapeHtml(error)}</p>` : ''}</section>`
  }
  return `<section class="card"><h2>Diagnostics: <span class="pill neutral">${heading}</span></h2><p class="muted">Diagnostic recording is OFF. Translation, Queue and cache still work normally.</p><form method="POST" action="diagnose/toggle" autocomplete="off"><label for="diag-admin">Admin key</label><input id="diag-admin" name="adminKey" type="password" minlength="6" maxlength="256" required autocomplete="off" placeholder="Admin key (not Gemini API key)" ${ready ? '' : 'disabled'}><div><button type="submit" name="action" value="on" ${ready ? '' : 'disabled'}>Turn ON</button></div></form>${!ready ? '<p class="muted">Set secret SMARTSUBS_DIAG_ADMIN_KEY (6+ characters) and ensure SMARTSUBS_DELIVERY is available.</p>' : ''}${error ? `<p class="bad-text">${escapeHtml(error)}</p>` : ''}</section>`
}

function responseHeaders(contentType, status = 200, options = {}) {
  const headers = new Headers({
    'content-type': contentType,
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': options.cacheControl || (options.noStore ? 'no-store' : status === 200 ? 'public, max-age=300' : 'no-store')
  })
  if (options.csp) {
    headers.set(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    )
  }
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value !== undefined && value !== null && value !== '') headers.set(key, String(value))
  }
  return headers
}

function send(status, contentType, body, options = {}) {
  return new Response(body, {
    status,
    headers: responseHeaders(contentType, status, options)
  })
}

function json(body, status = 200, options = {}) {
  return send(status, 'application/json; charset=utf-8', JSON.stringify(body), options)
}

function safeMessage(error, apiKey) {
  let message = error && error.message ? String(error.message) : String(error || 'Unknown error')
  if (apiKey) message = message.split(apiKey).join('[redacted]')
  return message.slice(0, 300)
}

function safeDiagnosticHeader(request, name, maxLength = 180) {
  const value = String(request?.headers?.get?.(name) || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  return value ? value.slice(0, maxLength) : ''
}

function translationRequestProbe(request) {
  // Record only non-secret metadata useful for identifying duplicate subtitle
  // GET patterns. Never include URL/config token, IP, Cookie, Authorization,
  // Origin or Referer in diagnostic KV.
  const method = String(request?.method || 'GET').toUpperCase().slice(0, 12)
  const userAgent = safeDiagnosticHeader(request, 'user-agent', 180)
  const range = safeDiagnosticHeader(request, 'range', 96)
  const accept = safeDiagnosticHeader(request, 'accept', 120)
  const cacheControl = safeDiagnosticHeader(request, 'cache-control', 96)
  const pragma = safeDiagnosticHeader(request, 'pragma', 64)
  const secFetchMode = safeDiagnosticHeader(request, 'sec-fetch-mode', 32)
  const secFetchDest = safeDiagnosticHeader(request, 'sec-fetch-dest', 32)
  const purpose = safeDiagnosticHeader(request, 'purpose', 32) || safeDiagnosticHeader(request, 'sec-purpose', 32)
  const requestKind = range ? 'range' : 'full'
  const signatureInput = [
    method, requestKind, userAgent, range, accept, cacheControl, pragma,
    secFetchMode, secFetchDest, purpose
  ].join('\n')

  const probe = {
    probeVersion: 'request-probe-v1',
    method,
    requestKind,
    requestSignature: createHash('sha256').update(signatureInput, 'utf8').digest('hex').slice(0, 12)
  }
  if (userAgent) probe.userAgent = userAgent
  if (range) probe.range = range
  if (accept) probe.accept = accept
  if (cacheControl) probe.cacheControl = cacheControl
  if (pragma) probe.pragma = pragma
  if (secFetchMode) probe.secFetchMode = secFetchMode
  if (secFetchDest) probe.secFetchDest = secFetchDest
  if (purpose) probe.purpose = purpose
  return probe
}

function classifyTranslationError(error) {
  const message = error && error.message ? String(error.message) : String(error || '')
  if (/Gemini HTTP (401|403)/i.test(message)) {
    return {
      status: 401,
      code: 'gemini-key-rejected',
      publicMessage: 'Gemini API key rejected. Reconfigure SmartSubs.',
      retryAfter: ''
    }
  }

  if (/Gemini HTTP 429/i.test(message)) {
    return {
      status: 429,
      code: 'gemini-rate-limit',
      publicMessage: 'Gemini quota or rate limit reached. Try again shortly.',
      retryAfter: '30'
    }
  }
  if (/Gemini HTTP (408|5\d\d)|aborted|aborterror|timeout/i.test(message)) {
    return {
      status: 503,
      code: 'translation-temporary',
      publicMessage: 'Malay translation is temporarily unavailable. Try again shortly.',
      retryAfter: '10'
    }
  }

  return {
    status: 502,
    code: 'translation-failed',
    publicMessage: 'SmartSubs could not generate this Malay subtitle.',
    retryAfter: ''
  }
}

function requestBase(request) {
  return new URL(request.url).origin
}

function configuredBase(request, token) {
  return `${requestBase(request)}/c/${encodeURIComponent(token)}`
}

function serverSecret(env) {
  return String(env.SMARTSUBS_SECRET || env.CONFIG_TOKEN_SECRET || env.TRANSLATION_TOKEN_SECRET || '')
}

function geminiModel(env) {
  return String(env.GEMINI_MODEL || 'gemini-3.5-flash-lite')
}

function cacheVersion(env) {
  return String(env.SMARTSUBS_CACHE_VERSION || 'm8-v1')
}

function cacheTtlMs(env) {
  return Number(env.SMARTSUBS_CACHE_TTL_MS || 180 * 24 * 60 * 60 * 1000)
}

async function rateLimitAllowed(binding, key) {
  if (!binding || typeof binding.limit !== 'function') return true
  try {
    const result = await binding.limit({
      key: String(key || 'global').slice(0, 160)
    })
    return result?.success !== false
  } catch {
    return true
  }
}

function rateLimitedResponse(scope = 'request') {
  return send(
    429,
    'text/plain; charset=utf-8',
    `SmartSubs ${scope} rate limit reached. Try again shortly.`,
    {
      noStore: true,
      headers: {
        'retry-after': '60',
        'x-smartsubs-error': 'request-rate-limit',
        'x-smartsubs-build': BUILD_ID
      }
    }
  )
}

function publicReady(env) {
  return Boolean(
    serverSecret(env) &&
    env.SMARTSUBS_CACHE &&
    env.SMARTSUBS_TRANSLATION_QUEUE &&
    env.SMARTSUBS_SUBTITLE_LIMITER &&
    env.SMARTSUBS_GENERATE_LIMITER
  )
}


function getCache(env) {
  const binding = env.SMARTSUBS_CACHE
  if (!binding || (typeof binding !== 'object' && typeof binding !== 'function')) {
    return new CloudflareTranslationCache({
      kv: null,
      ttlMs: cacheTtlMs(env),
      version: cacheVersion(env)
    })
  }
  // A tracked request gets its own KV wrapper but shares the original isolate's
  // LRU memory and counters. Tracking must not silently disable memory caching.
  const original = env.__kvUsageOriginal || binding
  let cache = caches.get(original)
  if (!cache) {
    cache = new CloudflareTranslationCache({
      kv: original,
      ttlMs: cacheTtlMs(env),
      version: cacheVersion(env)
    })
    caches.set(original, cache)
  }
  if (!env.__kvUsageTracker) return cache
  if (!env.__kvUsageTracker.cache) {
    env.__kvUsageTracker.cache = new CloudflareTranslationCache({
      kv: binding,
      ttlMs: cacheTtlMs(env),
      version: cacheVersion(env),
      memory: cache.memory,
      counters: cache.counters
    })
  }
  return env.__kvUsageTracker.cache
}

function parseSubtitleArgs(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'subtitles' || !['movie', 'series'].includes(parts[1])) return null
  if (parts.length !== 3 && parts.length !== 4) return null

  let idPart
  let extraPart = ''
  if (parts.length === 3) {
    if (!parts[2].endsWith('.json')) return null
    idPart = parts[2].slice(0, -5)
  } else {
    idPart = parts[2]
    if (!parts[3].endsWith('.json')) return null
    extraPart = parts[3].slice(0, -5)
  }

  let id
  try {
    id = decodeURIComponent(idPart)
  } catch {
    return null
  }

  const extra = {}
  if (extraPart) {
    const params = new URLSearchParams(extraPart)
    for (const [key, value] of params.entries()) extra[key] = value
  }

  return { type: parts[1], id, extra }
}

async function readConfigureForm(request) {
  const maxBytes = 8192
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new Error('Configure request is too large')
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new Error('Configure request is too large')
  }
  return Object.fromEntries(new URLSearchParams(body).entries())
}

function renderRootDiagnosePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubsV2 Diagnose</title><style>:root{color-scheme:dark}body{margin:0;background:#101116;color:#f4f4f5;font-family:system-ui,sans-serif}.wrap{max-width:720px;margin:auto;padding:28px 18px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:20px}code{word-break:break-all;color:#c9ffdc}</style></head><body><main class="wrap"><section class="card"><h1>SmartSubsV2 Diagnose</h1><p>Build: <code>${BUILD_ID}</code></p><p>Open diagnose through your configured SmartSubs URL:</p><code>https://.../c/YOUR_CONFIG_TOKEN/diagnose</code><p>The config token is required so diagnostics stay isolated to that SmartSubs installation.</p></section></main></body></html>`
}

function formatMalaysiaTime(timestamp) {
  const value = Number(timestamp || 0)
  if (!Number.isFinite(value) || value <= 0) return 'Unknown time'
  try {
    const date = new Date(value)
    const datePart = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(date)
    const timePart = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kuala_Lumpur', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
    }).format(date).replace(/\s?(AM|PM)$/, (_, meridiem) => ` ${meridiem.toLowerCase()}`)
    return `${datePart}, ${timePart} MYT`
  } catch {
    return `${new Date(value).toISOString()} UTC`
  }
}

function compactMediaLabel(subtitle) {
  if (!subtitle) return 'No request'
  const id = String(subtitle.id || '')
  const episode = id.match(/^(.+?):(\d+):(\d+)$/)
  if (episode && ['series', 'tv'].includes(String(subtitle.type || '').toLowerCase())) {
    return `S${Number(episode[2])}E${Number(episode[3])} · ${id}`
  }
  return `${String(subtitle.type || '').toLowerCase() === 'movie' ? 'Movie' : 'Media'} · ${id || 'Unknown ID'}`
}

function compactMalayAutoStatus(subtitle) {
  if (!subtitle) return 'Not requested'
  if (subtitle.result === 'auto-malay-ready' || subtitle.autoReady === true) return 'Ready'
  if (subtitle.result === 'native-malay') return 'Not available'
  if (subtitle.result === 'native-malay-with-auto-fallback') return 'Ready'
  return String(subtitle.result || 'Not available')
}

function formatDuration(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return 'Not available'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

function compactMetric(label, value) {
  if (value === undefined || value === null || value === '') return null
  return { label: String(label), value: String(value) }
}

function eventPresentation(item = {}) {
  const event = String(item.event || '')
  const sourceId = String(item.sourceId || '')
  const metrics = []
  let category = 'EVENT'
  let tone = 'neutral'
  let title = event || 'Technical event'
  let summary = ''

  const add = (label, value) => {
    const metric = compactMetric(label, value)
    if (metric) metrics.push(metric)
  }

  if (event === 'subtitle-request') {
    category = 'DISCOVERY'
    title = 'Subtitle request'
    summary = item.id ? compactMediaLabel(item) : 'Player requested subtitle tracks'
  } else if (event === 'subtitle-result') {
    category = 'DISCOVERY'
    tone = item.result === 'error' ? 'bad' : 'good'
    title = 'Subtitle discovery'
    const total = Number(item.subtitleCount || 0)
    const ai = Number(item.aiCandidateCount ?? item.englishTrackCount ?? item.englishCandidateCount ?? 0)
    const english = Number(item.englishTrackCount ?? item.englishCandidateCount ?? 0)
    const nativeMalay = Number(item.malayCount || 0)
    const parts = [`${total} tracks`, `${ai} AI Malay`, `${english} English`]
    if (nativeMalay > 0) parts.push(`${nativeMalay} Native Malay`)
    summary = parts.join(' · ')
    add('Prefetch', item.autoPrefetch === false ? 'OFF' : item.autoPrefetch === true ? 'ON' : undefined)
    add('Selected', item.englishSelectedId || '—')
    add('Upstream', item.upstreamCount)
  } else if (event === 'translation-request') {
    category = 'TRANSLATE'
    title = 'AI translation requested'
    summary = sourceId ? `OpenSubtitles source ${sourceId}` : 'Player requested Malay AI'
    add('Mode', item.status)
  } else if (event === 'player-translation-queued' || event === 'queue-enqueued') {
    category = 'QUEUE'
    title = 'AI translation queued'
    summary = sourceId ? `OpenSubtitles source ${sourceId}` : 'Translation job sent to Queue'
    add('Profile', item.profile)
    add('Status', item.status)
  } else if (event === 'queue-deduped') {
    category = 'QUEUE'
    title = 'Existing Queue job reused'
    summary = sourceId ? `OpenSubtitles source ${sourceId}` : 'Duplicate translation job avoided'
    add('Status', item.status)
  } else if (event === 'queue-translation-start') {
    category = 'TRANSLATE'
    title = 'AI translation started'
    summary = sourceId ? `OpenSubtitles source ${sourceId}` : 'Queue consumer started translation'
    add('Profile', item.profile)
    add('Concurrency', item.concurrency)
    add('Queue delay', item.queueDelayMs === undefined ? undefined : formatDuration(item.queueDelayMs))
  } else if (event === 'queue-translation-complete' || event === 'prefetch-complete') {
    category = 'TRANSLATE'
    tone = 'good'
    title = 'AI translation ready'
    const parts = []
    if (sourceId) parts.push(`Source ${sourceId}`)
    if (item.cache) parts.push(`Cache ${item.cache}`)
    if (item.totalMs !== undefined) parts.push(formatDuration(item.totalMs))
    summary = parts.join(' · ') || 'Translation completed'
    add('Gemini calls', item.geminiCalls)
    add('Tokens', item.geminiTotalTokensTotal)
    add('Chunks', item.chunks)
    if (Number(item.missing || 0) > 0 || Number(item.retryRecovered || 0) > 0) {
      add('Cue recovery', `${Number(item.missing || 0)} missing · ${Number(item.retryRecovered || 0)} recovered`)
    }
  } else if (event === 'translation-delivered' || event === 'queue-join-hit') {
    category = 'DELIVERY'
    tone = 'good'
    title = event === 'translation-delivered' ? 'Translation delivered' : 'Queued translation joined'
    const parts = []
    if (sourceId) parts.push(`Source ${sourceId}`)
    if (item.cache) parts.push(`Cache ${item.cache}`)
    if (item.totalMs !== undefined) parts.push(formatDuration(item.totalMs))
    if (item.waitMs !== undefined && Number(item.waitMs) > 0) parts.push(`wait ${formatDuration(item.waitMs)}`)
    summary = parts.join(' · ') || 'Malay subtitle returned to player'
    add('Join', item.joinStatus)
    add('Polls', item.polls)
  } else if (event === 'translation-pending' || event === 'queue-join-start') {
    category = 'QUEUE'
    tone = 'warn'
    title = event === 'translation-pending' ? 'Translation still preparing' : 'Waiting for Queue result'
    summary = sourceId ? `OpenSubtitles source ${sourceId}` : 'Player is waiting for the selected translation'
    add('Status', item.status)
    add('Wait', item.waitMs === undefined ? undefined : formatDuration(item.waitMs))
    add('Polls', item.polls)
  } else if (event.includes('failed') || item.error) {
    category = 'ERROR'
    tone = 'bad'
    title = event === 'translation-failed' ? 'Translation failed'
      : event === 'queue-translation-failed' ? 'Queue translation failed'
        : event === 'queue-enqueue-failed' ? 'Queue enqueue failed'
          : 'Technical failure'
    summary = item.error || item.reason || item.failureStage || item.status || 'Failure recorded'
    add('Source', sourceId || undefined)
    add('Stage', item.failureStage)
    add('Time', item.totalMs === undefined ? undefined : formatDuration(item.totalMs))
  } else if (event.startsWith('queue-')) {
    category = 'QUEUE'
    title = event.replaceAll('-', ' ')
    summary = sourceId ? `OpenSubtitles source ${sourceId}` : (item.status || 'Queue activity')
    add('Wait', item.waitMs === undefined ? undefined : formatDuration(item.waitMs))
  } else if (event.startsWith('prefetch-')) {
    category = 'PREFETCH'
    title = event.replaceAll('-', ' ')
    summary = sourceId ? `OpenSubtitles source ${sourceId}` : (item.status || 'Legacy prefetch activity')
  } else {
    title = event ? event.replaceAll('-', ' ') : 'Technical event'
    summary = sourceId ? `OpenSubtitles source ${sourceId}` : (item.status || item.result || '')
  }

  return { category, tone, title, summary, metrics: metrics.slice(0, 6) }
}

function renderTechnicalEvent(item = {}) {
  const view = eventPresentation(item)
  const detail = Object.entries(item)
    .filter(([key]) => !['ts', 'event'].includes(key))
    .map(([key, value]) => `<span><b>${escapeHtml(key)}</b>=${escapeHtml(Array.isArray(value) ? value.join(',') : value)}</span>`)
    .join('') || '<span>No details</span>'
  const metrics = view.metrics
    .map(metric => `<span><b>${escapeHtml(metric.label)}</b> ${escapeHtml(metric.value)}</span>`)
    .join('')
  return `<article class="event-card"><div class="event-top"><span class="event-badge ${escapeHtml(view.tone)}">${escapeHtml(view.category)}</span><time>${escapeHtml(formatMalaysiaTime(item.ts))}</time></div><div class="event-title">${escapeHtml(view.title)}</div><code class="event-machine">${escapeHtml(item.event || '')}</code>${view.summary ? `<div class="event-summary">${escapeHtml(view.summary)}</div>` : ''}${metrics ? `<div class="event-metrics">${metrics}</div>` : ''}<details class="event-raw"><summary>Raw details</summary><div class="event-detail">${detail}</div></details></article>`
}

function verdictPresentation(verdict) {
  const map = {
    NO_SUBTITLE_REQUEST_SEEN: ['Waiting for subtitle request', 'neutral', 'The player has not requested this configured SmartSubs addon yet.'],
    NATIVE_MALAY_RETURNED: ['Native Malay returned', 'good', 'SmartSubs returned an existing Malay subtitle without Gemini translation.'],
    NATIVE_MALAY_WITH_AUTO_FALLBACK: ['Native Malay and Malay AI offered', 'good', 'Both subtitle choices were returned to the player.'],
    SUBTITLE_REQUEST_FAILED: ['Subtitle request failed', 'bad', 'SmartSubs received the request but the subtitle request failed.'],
    NO_ENGLISH_SOURCE_FOUND: ['No English source found', 'bad', 'OpenSubtitles returned no recognised English source for Malay AI.'],
    BYOK_NOT_CONFIGURED: ['Gemini key not configured', 'bad', 'Malay AI cannot run until BYOK configuration is valid.'],
    SUBTITLE_REQUEST_RETURNED_ZERO: ['No subtitle returned', 'bad', 'SmartSubs was requested but returned zero subtitle tracks.'],
    TRANSLATION_DELIVERED: ['Malay subtitle delivered', 'good', 'The translated Malay VTT was successfully returned to the player.'],
    TRANSLATION_FAILED: ['Translation failed', 'bad', 'The Malay translation request failed. Check the error event below.'],
    QUEUE_JOIN_WAITING: ['Waiting for queued translation', 'warn', 'The player selected Malay AI while the background Queue job is still running.'],
    TRANSLATION_REQUESTED_WAITING_FOR_RESULT: ['Translation requested', 'warn', 'The player requested Malay AI and SmartSubs is waiting for the result.'],
    TRANSLATION_PREPARING_IN_QUEUE: ['Translation preparing', 'warn', 'Malay AI is translating safely in Cloudflare Queue. Retry or select Malay AI again shortly.'],
    QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION: ['Malay AI ready in cache', 'good', 'Background Queue translation finished before player selection.'],
    QUEUE_PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION: ['Background translation failed', 'bad', 'Queue prefetch failed. Selecting Malay AI may still retry.'],
    QUEUE_PREFETCH_TRANSLATING: ['Background translation running', 'warn', 'Cloudflare Queue is translating Malay AI now.'],
    QUEUE_PREFETCH_QUEUED: ['Translation queued', 'warn', 'The Malay AI translation job is safely queued.'],
    PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION: ['Malay AI ready', 'good', 'Background translation completed and is waiting for player selection.'],
    PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION: ['Prefetch failed', 'bad', 'Background translation failed.'],
    PREFETCH_TRANSLATING: ['Prefetch translating', 'warn', 'Malay AI is translating in the background.'],
    SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION: ['Malay AI offered', 'good', 'SmartSubs returned a Malay AI track to the player.'],
    SUBTITLE_RETURNED: ['Subtitle returned', 'good', 'SmartSubs returned a subtitle track.']
  }
  const item = map[verdict] || [verdict, 'neutral', 'See the recent events for more detail.']
  return { title: item[0], tone: item[1], explanation: item[2] }
}

function renderConfiguredDiagnosePage(configId, events, control = { enabled: true, ready: false, error: '' }) {
  const controls = diagnosticControlHtml(control, control.ready, control.error)
  if (control.enabled === false) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>SmartSubsV2 Diagnose</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#101116;color:#f4f4f5;font-family:system-ui,-apple-system,sans-serif}.wrap{max-width:920px;margin:auto;padding:18px 12px 40px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:16px;margin-bottom:12px}h1{font-size:24px;margin:0 0 8px}.diagnose-heading{text-align:center;margin-bottom:20px}.diagnose-heading h1{margin:0 0 6px}.diagnose-heading .muted{font-variant-numeric:tabular-nums}h2{font-size:17px;margin:0 0 12px}.muted{color:#aeb1bb;font-size:13px}.status{display:flex;gap:10px;align-items:flex-start}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:5px 10px;font-weight:800;font-size:12px;letter-spacing:.02em}.good{background:#123b29;color:#a7f3d0}.warn{background:#493812;color:#fde68a}.bad{background:#4a1d24;color:#fecaca}.neutral{background:#30333d;color:#e5e7eb}.status-copy{flex:1}.status-title{font-size:20px;font-weight:800;margin-bottom:4px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.metric{background:#111319;border:1px solid #2b2e37;border-radius:12px;padding:12px}.metric .label{color:#aeb1bb;font-size:12px}.metric .value{font-size:18px;font-weight:800;margin-top:3px;word-break:break-word}.metric .sub{color:#aeb1bb;font-size:12px;margin-top:4px;word-break:break-word}.meta-row{display:grid;grid-template-columns:90px 42px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid #30333d;align-items:start}.meta-row:last-child{border-bottom:0}.meta-row .yes{color:#a7f3d0}.meta-row .no{color:#fca5a5}.meta-row small{color:#c7c9d1;word-break:break-word}.guide{font-size:15px;line-height:1.5}.event-card{border-top:1px solid #30333d;padding:14px 0}.event-card:first-child{border-top:0}.event-top{display:flex;gap:10px;justify-content:space-between;align-items:center;margin-bottom:8px}.event-top time{font-size:12px;color:#aeb1bb}.event-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900;letter-spacing:.06em}.event-title{font-size:15px;font-weight:800;margin-bottom:2px;text-transform:none}.event-machine{display:block;color:#8f93a1;font-size:10px;margin-bottom:5px}.event-summary{font-size:13px;color:#d7d8dd;line-height:1.45;word-break:break-word}.event-metrics{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.event-metrics span{background:#111319;border:1px solid #292c34;border-radius:7px;padding:4px 7px;font-size:11px;word-break:break-word}.event-metrics b{color:#aeb1bb;font-weight:600;margin-right:3px}.event-raw{margin-top:8px}.event-raw>summary{font-size:11px;color:#aeb1bb;font-weight:700;padding:3px 0}.event-detail{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.event-detail span{background:#0f1116;border-radius:7px;padding:4px 6px;font-size:11px;word-break:break-word}.event-detail b{color:#aeb1bb;font-weight:600}details summary{cursor:pointer;font-weight:800;padding:4px 0}code{color:#c9ffdc}@media(max-width:640px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.media-metric{grid-column:1/-1}.meta-row{grid-template-columns:82px 38px 1fr}.event-top{align-items:flex-start;flex-direction:column;gap:5px}}
input{display:block;width:100%;max-width:430px;min-height:44px;margin:10px 0;padding:10px;background:#101116;color:#fff;border:1px solid #59606b;border-radius:8px}button{min-height:44px;padding:10px 18px;border:0;border-radius:9px;background:#3879d7;color:#fff;font-weight:bold}button:disabled{opacity:.5}.bad-text{color:#fecaca}.diag-control-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.diag-control-row h2{margin:0}.diag-off-btn{background:#30333d;border:1px solid #59606b;font-size:12px;min-height:36px;padding:6px 12px;white-space:nowrap}
</style></head><body><main class="wrap"><section class="card"><header class="diagnose-heading"><h1>SmartSubsV2 Diagnose</h1><div class="muted">${escapeHtml(formatMalaysiaTime(Date.now()))}</div></header><div class="status"><span class="pill neutral">OFF</span><div class="status-copy"><div class="status-title">Diagnostics recording is off</div><div class="muted">Translation, Queue and cache still work normally.</div></div></div></section>${controls}<p class="muted">Old events remain in KV until their existing 24-hour expiry. No diagnostic history is read while OFF.</p></main></body></html>`
  }
  const sorted = [...events].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
  const verdict = deriveVerdict(sorted)
  const status = verdictPresentation(verdict)
  const lastSubtitle = sorted.find(item => item.event === 'subtitle-result') || null
  const lastDelivery = sorted.find(item => item.event === 'translation-delivered') || null
  const lastQueueComplete = sorted.find(item => item.event === 'queue-translation-complete') || null
  const lastTranslationComplete = lastQueueComplete ||
    sorted.find(item => item.event === 'prefetch-complete') ||
    null
  const lastFailure = sorted.find(item =>
    ['translation-failed', 'queue-translation-failed', 'prefetch-failed'].includes(item.event)
  ) || null
  // Translation events now retain the selected OpenSubtitles source ID in the
  // same existing diagnostic record. This changes presentation context only;
  // it does not add another KV event/read/write.
  const latestRequestTs = Number(lastSubtitle?.ts || 0)
  const latestSourceEvent = lastSubtitle ? sorted.find(item =>
    Number(item.ts || 0) >= latestRequestTs && item.sourceId && [
      'translation-request', 'player-translation-queued', 'queue-enqueued',
      'queue-translation-start', 'queue-translation-complete',
      'translation-pending', 'translation-delivered', 'translation-failed'
    ].includes(item.event)
  ) : null
  const selectedId = latestSourceEvent?.sourceId || lastSubtitle?.englishSelectedId || 'Not available'
  // Never reuse an older media's duration for the latest subtitle request.
  const deliveryForRequest = lastSubtitle && lastDelivery && Number(lastDelivery.ts || 0) >= latestRequestTs
    ? lastDelivery : null
  const coldForRequest = lastSubtitle && lastTranslationComplete && Number(lastTranslationComplete.ts || 0) >= latestRequestTs
    ? lastTranslationComplete : null
  const deliveryTime = deliveryForRequest?.totalMs
  const coldTime = coldForRequest?.totalMs
  const hasNativeMalay = Number(lastSubtitle?.malayCount || 0) > 0
  const activeFailure = lastFailure && (!lastDelivery || Number(lastFailure.ts || 0) > Number(lastDelivery.ts || 0)) ? lastFailure : null

  const guidance = activeFailure
    ? 'A recent failure was recorded. See the failure details and recent events below.' : ''

  const rawEvents = sorted.map(renderTechnicalEvent).join('') || '<p class="muted">No request events recorded in the last 24 hours.</p>'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubsV2 Diagnose</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#101116;color:#f4f4f5;font-family:system-ui,-apple-system,sans-serif}.wrap{max-width:920px;margin:auto;padding:18px 12px 40px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:16px;margin-bottom:12px}h1{font-size:24px;margin:0 0 8px}.diagnose-heading{text-align:center;margin-bottom:20px}.diagnose-heading h1{margin:0 0 6px}.diagnose-heading .muted{font-variant-numeric:tabular-nums}h2{font-size:17px;margin:0 0 12px}.muted{color:#aeb1bb;font-size:13px}.status{display:flex;gap:10px;align-items:flex-start}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:5px 10px;font-weight:800;font-size:12px;letter-spacing:.02em}.good{background:#123b29;color:#a7f3d0}.warn{background:#493812;color:#fde68a}.bad{background:#4a1d24;color:#fecaca}.neutral{background:#30333d;color:#e5e7eb}.status-copy{flex:1}.status-title{font-size:20px;font-weight:800;margin-bottom:4px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.metric{background:#111319;border:1px solid #2b2e37;border-radius:12px;padding:12px}.metric .label{color:#aeb1bb;font-size:12px}.metric .value{font-size:18px;font-weight:800;margin-top:3px;word-break:break-word}.metric .sub{color:#aeb1bb;font-size:12px;margin-top:4px;word-break:break-word}.meta-row{display:grid;grid-template-columns:90px 42px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid #30333d;align-items:start}.meta-row:last-child{border-bottom:0}.meta-row .yes{color:#a7f3d0}.meta-row .no{color:#fca5a5}.meta-row small{color:#c7c9d1;word-break:break-word}.guide{font-size:15px;line-height:1.5}.event-card{border-top:1px solid #30333d;padding:14px 0}.event-card:first-child{border-top:0}.event-top{display:flex;gap:10px;justify-content:space-between;align-items:center;margin-bottom:8px}.event-top time{font-size:12px;color:#aeb1bb}.event-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900;letter-spacing:.06em}.event-title{font-size:15px;font-weight:800;margin-bottom:2px;text-transform:none}.event-machine{display:block;color:#8f93a1;font-size:10px;margin-bottom:5px}.event-summary{font-size:13px;color:#d7d8dd;line-height:1.45;word-break:break-word}.event-metrics{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.event-metrics span{background:#111319;border:1px solid #292c34;border-radius:7px;padding:4px 7px;font-size:11px;word-break:break-word}.event-metrics b{color:#aeb1bb;font-weight:600;margin-right:3px}.event-raw{margin-top:8px}.event-raw>summary{font-size:11px;color:#aeb1bb;font-weight:700;padding:3px 0}.event-detail{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.event-detail span{background:#0f1116;border-radius:7px;padding:4px 6px;font-size:11px;word-break:break-word}.event-detail b{color:#aeb1bb;font-weight:600}details summary{cursor:pointer;font-weight:800;padding:4px 0}code{color:#c9ffdc}input{display:block;width:100%;max-width:430px;min-height:44px;margin:10px 0;padding:10px;background:#101116;color:#fff;border:1px solid #59606b;border-radius:8px}button{min-height:44px;padding:10px 18px;border:0;border-radius:9px;background:#3879d7;color:#fff;font-weight:bold}button:disabled{opacity:.5}.bad-text{color:#fecaca}.diag-control-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.diag-control-row h2{margin:0}.diag-off-btn{background:#30333d;border:1px solid #59606b;font-size:12px;min-height:36px;padding:6px 12px;white-space:nowrap}@media(max-width:640px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.media-metric{grid-column:1/-1}.meta-row{grid-template-columns:82px 38px 1fr}.event-top{align-items:flex-start;flex-direction:column;gap:5px}}
</style></head>
<body><main class="wrap">
<section class="card"><header class="diagnose-heading"><h1>SmartSubsV2 Diagnose</h1><div class="muted">${escapeHtml(formatMalaysiaTime(Date.now()))}</div></header><div class="status"><span class="pill ${status.tone}">${escapeHtml(status.tone === 'good' ? 'OK' : status.tone === 'bad' ? 'ERROR' : status.tone === 'warn' ? 'WAIT' : 'INFO')}</span><div class="status-copy"><div class="status-title">${escapeHtml(status.title)}</div><div class="muted">${escapeHtml(status.explanation)}</div></div></div><p class="muted">Latest subtitle request: ${escapeHtml(lastSubtitle ? formatMalaysiaTime(lastSubtitle.ts) : 'Not recorded')}</p></section>

${controls}

<section class="card"><h2>Overview</h2><div class="grid">
<div class="metric media-metric"><div class="label">Latest media</div><div class="value">${escapeHtml(compactMediaLabel(lastSubtitle))}</div></div>
<div class="metric"><div class="label">Malay AI</div><div class="value">${escapeHtml(compactMalayAutoStatus(lastSubtitle))}</div><div class="sub">${escapeHtml(lastSubtitle ? `${lastSubtitle.subtitleCount || 0} tracks returned` : 'No subtitle request')}</div></div>
<div class="metric"><div class="label">English source</div><div class="value">${escapeHtml(selectedId === 'Not available' ? '—' : selectedId)}</div></div>
<div class="metric"><div class="label">Delivery</div><div class="value">${deliveryTime === undefined ? '—' : formatDuration(deliveryTime)}</div><div class="sub">${escapeHtml(deliveryForRequest?.cache || 'Not recorded')}</div></div>
<div class="metric"><div class="label">Cold translation</div><div class="value">${coldTime === undefined ? '—' : formatDuration(coldTime)}</div><div class="sub">${coldTime === undefined ? 'Not recorded for this request' : 'Latest request'}</div></div>
${hasNativeMalay ? `<div class="metric"><div class="label">Native Malay</div><div class="value">Available</div></div>` : ''}
</div></section>

${guidance ? `<section class="card"><h2>Note</h2><div class="guide">${escapeHtml(guidance)}</div></section>` : ''}

${activeFailure ? `<section class="card"><h2>Latest failure</h2><div class="metric"><div class="label">${escapeHtml(activeFailure.event)}</div><div class="value">${escapeHtml(activeFailure.failureStage || activeFailure.status || 'Unknown stage')}</div><div class="sub">${escapeHtml(activeFailure.error || activeFailure.reason || '')}</div></div></section>` : ''}


<section class="card"><details><summary>Technical events (${sorted.length})</summary><p class="muted">Build ${BUILD_ID} | Verdict <code>${escapeHtml(verdict)}</code> | Events retained for up to 24 hours (MYT).</p>${rawEvents}</details></section>
</main></body></html>`
}
async function prefetchTranslation(options = {}) {
  const autoUrl = String(options.autoUrl || '')
  const env = options.env || {}
  const userConfig = options.userConfig || {}
  const secret = String(options.secret || '')
  const configId = String(options.configId || '')
  const getOrTranslateFn = options.getOrTranslateFn || cfGetOrTranslate
  const diagnosticFn = options.diagnosticFn || ((_kv, id, event) => recordConfiguredDiagnostic(env, id, event))
  const startedAt = nowMs()

  if (!autoUrl || !secret || !userConfig.apiKey) return null

  let match
  try {
    match = new URL(autoUrl).pathname.match(/\/translated\/([A-Za-z0-9_.-]+)\.vtt$/)
  } catch {
    return null
  }
  if (!match) return null

  let selectedSourceId = ''
  await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
    event: 'prefetch-start',
    status: 'background'
  }).catch(() => {})

  try {
    if (!env.SMARTSUBS_CACHE) throw new Error('SMARTSUBS_CACHE KV binding is not configured')
    const tokenData = decodeTranslationTokenData(match[1], secret)
    selectedSourceId = tokenData.sourceId
    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'translation-request',
      status: 'prefetch',
      sourceId: selectedSourceId
    }).catch(() => {})
    const result = await getOrTranslateFn({
      cache: getCache(env),
      upstreamUrl: tokenData.url,
      sourceId: tokenData.cacheId,
      model: userConfig.model,
      apiKey: userConfig.apiKey,
      cacheVersion: cacheVersion(env)
    })
    const totalMs = roundMs(nowMs() - startedAt)
    const repair = result.translationStats || {}
    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'prefetch-complete',
      sourceId: selectedSourceId,
      cache: result.status,
      status: 'ready',
      totalMs,
      expected: repair.expected,
      received: repair.received,
      missing: repair.missing,
      retryRecovered: repair.retryRecovered,
      fallbackCount: repair.fallbackCount,
      final: repair.final,
      semanticRetriesUsed: repair.semanticRetriesUsed,
      chunks: repair.chunks,
      geminiCalls: repair.geminiCalls,
      rateLimits: repair.rateLimits,
      transientRetries: repair.transientRetries,
      abortRetries: repair.abortRetries,
      retryWaitMs: repair.retryWaitMs,
      hedgeStarts: repair.hedgeStarts,
      hedgeReplicaWins: repair.hedgeReplicaWins,
      hedgeCancels: repair.hedgeCancels,
      chunkItems: repair.chunkItems,
      chunkChars: repair.chunkChars,
      concurrency: repair.concurrency
    }).catch(() => {})
    logPerf({
      milestone: 'M14.1',
      route: 'prefetch',
      cache: result.status,
      configId,
      totalMs
    })
    return result
  } catch (error) {
    const totalMs = roundMs(nowMs() - startedAt)
    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'prefetch-failed',
      sourceId: selectedSourceId || undefined,
      status: 'background-failed',
      error: safeMessage(error, userConfig.apiKey),
      totalMs
    }).catch(() => {})
    console.error(JSON.stringify({
      tag: 'SMARTSUBS_PREFETCH_ERROR',
      configId,
      message: safeMessage(error, userConfig.apiKey)
    }))
    return null
  }
}

const QUEUE_JOB_PREFIX = 'job:v1:'

function validTranslationCacheKey(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''))
}

function queueJobKey(cacheKey) {
  return `${QUEUE_JOB_PREFIX}${cacheKey}`
}

function queueJobTtlSeconds(env) {
  return Math.max(120, Math.min(3600, Number(env.QUEUE_JOB_TTL_SECONDS || 600)))
}

function queueJoinMaxMs(env) {
  return Math.max(5000, Math.min(60000, Number(env.QUEUE_JOIN_MAX_MS || 55000)))
}

function queueJoinPollMs(env) {
  return Math.max(500, Math.min(5000, Number(env.QUEUE_JOIN_POLL_MS || 1500)))
}

function playerQueuePollEarlyMs(env) {
  return Math.max(1000, Math.min(10000, Number(env.PLAYER_QUEUE_POLL_EARLY_MS || 6000)))
}

function playerQueuePollFastStartMs(env) {
  return Math.max(0, Math.min(30000, Number(env.PLAYER_QUEUE_POLL_FAST_START_MS || 12000)))
}

function playerQueuePollLateStartMs(env) {
  return Math.max(playerQueuePollFastStartMs(env), Math.min(60000, Number(env.PLAYER_QUEUE_POLL_LATE_START_MS || 25000)))
}

function playerQueuePollLateMs(env) {
  return Math.max(1000, Math.min(10000, Number(env.PLAYER_QUEUE_POLL_LATE_MS || 3000)))
}

function playerMoviePollStepMs(env) {
  return Math.max(1000, Math.min(10000, Number(env.PLAYER_MOVIE_POLL_STEP_MS || 7000)))
}

function playerMoviePollFastStartMs(env) {
  return Math.max(
    playerMoviePollStepMs(env),
    Math.min(30000, Number(env.PLAYER_MOVIE_POLL_FAST_START_MS || 21000))
  )
}

function playerMoviePollLateMs(env) {
  return Math.max(1000, Math.min(10000, Number(env.PLAYER_MOVIE_POLL_LATE_MS || 3000)))
}

function playerMovieQueuePollPlan(env, job, now = Date.now()) {
  const state = String(job?.state || '')
  const updatedAt = Number(job?.updatedAt || 0)
  const fastMs = queueJoinPollMs(env)

  if (state === 'ready') return { pollMs: fastMs, boundaryMs: 0, phase: 'movie-fast' }
  if (state === 'retrying' || state === 'failed') {
    return { pollMs: playerQueuePollLateMs(env), boundaryMs: 0, phase: 'movie-retry' }
  }

  if ((state === 'queued' || state === 'running') && updatedAt > 0) {
    const ageMs = Math.max(0, Number(now) - updatedAt)
    const stepMs = playerMoviePollStepMs(env)
    const fastStartMs = playerMoviePollFastStartMs(env)

    if (ageMs < fastStartMs) {
      const nextBoundaryMs = Math.min(
        fastStartMs,
        Math.max(stepMs, (Math.floor(ageMs / stepMs) + 1) * stepMs)
      )
      return {
        pollMs: stepMs,
        boundaryMs: Math.max(1, nextBoundaryMs - ageMs),
        phase: 'movie-sparse'
      }
    }

    // Movies normally have more cues/chunks. After 21s, reduce KV polling
    // while keeping the 33s movie long-poll responsive.
    return { pollMs: playerMoviePollLateMs(env), boundaryMs: 0, phase: 'movie-late' }
  }

  return { pollMs: playerMoviePollStepMs(env), boundaryMs: 0, phase: 'movie-sparse' }
}

function playerQueuePollPlan(env, job, now = Date.now(), mediaType = '') {
  if (String(mediaType || '').toLowerCase() === 'movie') {
    return playerMovieQueuePollPlan(env, job, now)
  }

  const state = String(job?.state || '')
  const updatedAt = Number(job?.updatedAt || 0)
  const fastMs = queueJoinPollMs(env)

  if (state === 'ready') return { pollMs: fastMs, boundaryMs: 0, phase: 'fast' }
  if (state === 'retrying' || state === 'failed') return { pollMs: playerQueuePollLateMs(env), boundaryMs: 0, phase: 'late' }

  if ((state === 'queued' || state === 'running') && updatedAt > 0) {
    const ageMs = Math.max(0, Number(now) - updatedAt)
    const fastStartMs = playerQueuePollFastStartMs(env)
    const lateStartMs = playerQueuePollLateStartMs(env)

    if (ageMs < fastStartMs) {
      return {
        pollMs: playerQueuePollEarlyMs(env),
        boundaryMs: Math.max(1, fastStartMs - ageMs),
        phase: 'early'
      }
    }
    if (ageMs < lateStartMs) {
      return {
        pollMs: fastMs,
        boundaryMs: Math.max(1, lateStartMs - ageMs),
        phase: 'fast'
      }
    }
    return { pollMs: playerQueuePollLateMs(env), boundaryMs: 0, phase: 'late' }
  }

  // While still queued, avoid burning KV reads before the consumer has started.
  return { pollMs: playerQueuePollEarlyMs(env), boundaryMs: 0, phase: 'early' }
}

function playerQueueWaitMaxMs(env, mediaType = '') {
  if (String(mediaType || '').toLowerCase() === 'movie') {
    return Math.max(2000, Math.min(34000, Number(env.PLAYER_MOVIE_QUEUE_WAIT_MAX_MS || 33000)))
  }
  return Math.max(2000, Math.min(30000, Number(env.PLAYER_QUEUE_WAIT_MAX_MS || 30000)))
}

function geminiChunkAbortRetryMs(env) {
  return Math.max(0, Math.min(5000, Number(env.GEMINI_CHUNK_ABORT_RETRY_MS ?? 1000) || 0))
}
function movieGeminiHedgeEnabled(env) {
  return !['0', 'false', 'off', 'no'].includes(String(env.GEMINI_MOVIE_HEDGE_ENABLED ?? 'true').toLowerCase())
}
function movieGeminiHedgeDelayMs(env) {
  return Math.max(20000, Math.min(44000, Number(env.GEMINI_MOVIE_HEDGE_DELAY_MS || 35000)))
}
function movieAdaptiveTargetChunks(env) {
  return Math.max(6, Math.min(16, Number(env.QUEUE_MOVIE_TARGET_CHUNKS || 10)))
}
function movieAdaptiveChunkItemsMin(env) {
  return Math.max(120, Math.min(200, Number(env.QUEUE_MOVIE_CHUNK_ITEMS_MIN || 160)))
}
function movieAdaptiveChunkItemsMax(env) {
  const minItems = movieAdaptiveChunkItemsMin(env)
  return Math.max(minItems, Math.min(240, Number(env.QUEUE_MOVIE_CHUNK_ITEMS_MAX || 200)))
}

function playerQueueGraceMs(env) {
  return Math.max(0, Math.min(1000, Number(env.PLAYER_QUEUE_GRACE_MS || 600)))
}

function deliveryRelayTtlMs(env) {
  return Math.max(60000, Math.min(600000, Number(env.DELIVERY_RELAY_TTL_MS || 120000)))
}

function deliveryRelayStub(env, cacheKey) {
  if (!validTranslationCacheKey(cacheKey)) return null
  const namespace = env.SMARTSUBS_DELIVERY
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') return null
  return namespace.get(namespace.idFromName(cacheKey))
}

async function readDeliveryRelay(env, cacheKey) {
  try {
    const stub = deliveryRelayStub(env, cacheKey)
    if (!stub || typeof stub.fetch !== 'function') return null
    const response = await stub.fetch('https://smartsubs-delivery.internal/vtt')
    if (!response.ok) return null
    const value = await response.text()
    return value.startsWith('WEBVTT') ? value : null
  } catch {
    return null
  }
}

async function writeDeliveryRelay(env, cacheKey, value) {
  try {
    const text = String(value || '')
    const stub = deliveryRelayStub(env, cacheKey)
    if (!stub || typeof stub.fetch !== 'function' || !text.startsWith('WEBVTT')) return false
    const response = await stub.fetch('https://smartsubs-delivery.internal/vtt', {
      method: 'PUT',
      headers: { 'content-type': 'text/vtt; charset=utf-8' },
      body: text
    })
    return response.ok
  } catch {
    return false
  }
}

async function readReadyTranslation(env, cache, cacheKey) {
  const cached = await cache.get(cacheKey).catch(() => null)
  if (cached) return { vtt: cached, source: 'HIT' }
  const relayed = await readDeliveryRelay(env, cacheKey)
  return relayed ? { vtt: relayed, source: 'DELIVERY_RELAY' } : null
}

export class TranslationDeliveryRelay {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }

  async fetch(request) {
    const path = new URL(request.url).pathname
    // Usage reports use a separate DO idFromName namespace, never a relay instance.
    if (path === '/usage' && request.method === 'POST') {
      let payload
      try { payload = await request.json() } catch { return new Response(null, { status: 400 }) }
      const saved = await storeMonitorReport(this.ctx.storage, payload)
      if (saved && !(await this.ctx.storage.getAlarm())) {
        await this.ctx.storage.setAlarm(Date.now() + 86400000)
      }
      return new Response(null, { status: saved ? 204 : 400 })
    }
    if (path === '/usage' && request.method === 'GET') {
      return new Response(JSON.stringify(await readMonitorReports(this.ctx.storage)), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      })
    }
    if (path === '/monitor' && request.method === 'GET') {
      const reports = await readMonitorReports(this.ctx.storage)
      const testState = await readMonitorTestState(this.ctx.storage, Date.now(), reports)
      return new Response(JSON.stringify({ reports, testState }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      })
    }
    if (path === '/test/start' && request.method === 'POST') {
      const result = await startMonitorTest(this.ctx.storage)
      if (result.ok && !(await this.ctx.storage.getAlarm())) {
        await this.ctx.storage.setAlarm(Date.now() + 86400000)
      }
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      })
    }
    if (path === '/test/end' && request.method === 'POST') {
      const result = await endMonitorTest(this.ctx.storage)
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      })
    }
    // This endpoint is reachable only from the Worker through the DO binding.
    // Never expose a public proxy for arbitrary DO paths.
    if (path === '/diagnostics/state' && request.method === 'GET') {
      const state = await this.ctx.storage.get('diagnostics:state')
      return new Response(JSON.stringify({
        enabled: state?.enabled === true,
        since: Number(state?.since) || 0
      }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    }
    if (path === '/diagnostics/state' && request.method === 'POST') {
      let payload
      try { payload = await request.json() } catch { return new Response(null, { status: 400 }) }
      if (payload?.enabled !== true && payload?.enabled !== false) return new Response(null, { status: 400 })
      const previous = await this.ctx.storage.get('diagnostics:state')
      const enabled = payload.enabled === true
      const since = enabled ? (previous?.enabled ? Number(previous.since) || Date.now() : Date.now()) : 0
      await this.ctx.storage.put('diagnostics:state', { enabled, since })
      return new Response(JSON.stringify({ enabled, since }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      })
    }
    if (path === '/diagnostics/state') return new Response(null, { status: 405 })

    if (request.method === 'PUT') {
      const value = await request.text()
      if (!value.startsWith('WEBVTT') || value.length > 2 * 1024 * 1024) {
        return new Response('Invalid VTT', { status: 400 })
      }
      const expiresAt = Date.now() + deliveryRelayTtlMs(this.env)
      await this.ctx.storage.put('result', { value, expiresAt })
      await this.ctx.storage.setAlarm(expiresAt)
      return new Response(null, { status: 204 })
    }

    if (request.method === 'GET') {
      const result = await this.ctx.storage.get('result')
      if (!result || typeof result.value !== 'string' || Number(result.expiresAt) <= Date.now()) {
        if (result) await this.ctx.storage.delete('result')
        return new Response(null, { status: 404 })
      }
      return new Response(result.value, {
        status: 200,
        headers: { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'no-store' }
      })
    }

    return new Response(null, { status: 405 })
  }

  async alarm() {
    // Relay instances have no usage entries. They retain their existing cleanup.
    await pruneMonitorReports(this.ctx.storage)
    const hasTests = await pruneMonitorTestHistory(this.ctx.storage)
    const remaining = await this.ctx.storage.list({ prefix: 'usage:', limit: 1 })
    if (remaining.size || hasTests) await this.ctx.storage.setAlarm(Date.now() + 86400000)
    else if ((await this.ctx.storage.get('diagnostics:state'))?.enabled !== true) await this.ctx.storage.deleteAll()
  }
}

function translationPreparingResponse() {
  return send(
    503,
    'text/plain; charset=utf-8',
    'Malay translation is being prepared. Retry shortly.',
    {
      noStore: true,
      headers: {
        'retry-after': '3',
        'x-smartsubs-error': 'translation-preparing',
        'x-smartsubs-build': BUILD_ID
      }
    }
  )
}

function queueParallelEnabled(env, attempts = 1) {
  const attempt = Math.max(1, Number(attempts || 1))
  if (attempt > 1) return false

  return (
    env.QUEUE_PARALLEL_CHUNK_ITEMS !== undefined ||
    env.QUEUE_PARALLEL_CHUNK_CHARS !== undefined ||
    env.QUEUE_PARALLEL_CONCURRENCY !== undefined
  )
}
function queueFinalEnabled(env, attempts = 1) {
  const attempt = Math.max(1, Number(attempts || 1))
  if (attempt > 1) return false

  return (
    env.QUEUE_FINAL_CHUNK_ITEMS !== undefined ||
    env.QUEUE_FINAL_CHUNK_CHARS !== undefined ||
    env.QUEUE_FINAL_CONCURRENCY !== undefined
  )
}


function normaliseRequestedQueueProfile(value) {
  const requested = String(value || '')
  return requested === 'user-selected-stable' || requested === 'user-selected-fast'
    ? 'user-selected-stable'
    : ''
}

function normaliseQueueRetryMode(value) {
  const mode = String(value || '')
  return mode === 'fast-transient' || mode === 'safe-fallback' ? mode : ''
}

function queueTranslationProfile(env, attempts = 1, requestedProfile = '', retryMode = '') {
  const attempt = Math.max(1, Number(attempts || 1))
  const requested = normaliseRequestedQueueProfile(requestedProfile)
  const recovery = normaliseQueueRetryMode(retryMode)
  if (attempt > 1 && recovery === 'fast-transient') return 'fast-transient-retry'
  if (attempt === 1 && requested === 'user-selected-stable') return 'user-selected-stable'
  if (queueFinalEnabled(env, attempts)) return 'quota-safe-final'
  if (queueParallelEnabled(env, attempts)) return 'parallel-3'
  return attempt > 1 ? 'fallback-stable' : 'm16-compatible'
}

function queueFailureStage(error) {
  const message = String(error?.message || error || '')

  if (/Subtitle source|No timed subtitle cues|source is too large/i.test(message)) return 'source'
  if (/Gemini HTTP|Gemini returned|AbortError|aborted|timeout/i.test(message)) return 'gemini'
  if (/translation count mismatch|structured translation|usable translated cues/i.test(message)) return 'validation'
  if (/cache|KV binding/i.test(message)) return 'cache'
  return 'unknown'
}

function queueTranslationOptions(env, attempts = 1, requestedProfile = '', retryMode = '') {
  const retryAttempt = Math.max(1, Number(attempts || 1))
  const requested = normaliseRequestedQueueProfile(requestedProfile)
  const recovery = normaliseQueueRetryMode(retryMode)

  // A first-attempt abort/timeout is commonly a transient Gemini stall rather than
  // sustained overload. Retry once with the same normal profile before falling back.
  if (retryAttempt > 1 && recovery === 'fast-transient') {
    return queueTranslationOptions(env, 1, requestedProfile, '')
  }

  if (retryAttempt === 1 && requested === 'user-selected-stable') {
    return {
      maxItems: Math.max(140, Math.min(200, Number(env.QUEUE_USER_SELECTED_CHUNK_ITEMS || 160))),
      maxChars: Math.max(16000, Math.min(24000, Number(env.QUEUE_USER_SELECTED_CHUNK_CHARS || 20000))),
      concurrency: Math.max(1, Math.min(5, Number(env.QUEUE_USER_SELECTED_CONCURRENCY || 5)))
    }
  }
  if (queueFinalEnabled(env, attempts)) {
    return {
      maxItems: Math.max(160, Math.min(220, Number(env.QUEUE_FINAL_CHUNK_ITEMS || 180))),
      maxChars: Math.max(20000, Math.min(30000, Number(env.QUEUE_FINAL_CHUNK_CHARS || 24000))),
      concurrency: Math.max(1, Math.min(5, Number(env.QUEUE_FINAL_CONCURRENCY || 3)))
    }
  }

  if (queueParallelEnabled(env, attempts)) {
    return {
      maxItems: Math.max(100, Math.min(180, Number(env.QUEUE_PARALLEL_CHUNK_ITEMS || 160))),
      maxChars: Math.max(12000, Math.min(24000, Number(env.QUEUE_PARALLEL_CHUNK_CHARS || 20000))),
      concurrency: Math.max(1, Math.min(3, Number(env.QUEUE_PARALLEL_CONCURRENCY || 3)))
    }
  }

  if (retryAttempt > 1) {
    return {
      maxItems: Math.max(120, Math.min(240, Number(env.QUEUE_FALLBACK_CHUNK_ITEMS || 180))),
      maxChars: Math.max(16000, Math.min(30000, Number(env.QUEUE_FALLBACK_CHUNK_CHARS || 24000))),
      concurrency: Math.max(1, Math.min(2, Number(env.QUEUE_FALLBACK_CONCURRENCY || 2)))
    }
  }

  return {
    maxItems: Math.max(180, Math.min(300, Number(env.QUEUE_TRANSLATION_CHUNK_ITEMS || 240))),
    maxChars: Math.max(24000, Math.min(40000, Number(env.QUEUE_TRANSLATION_CHUNK_CHARS || 30000))),
    concurrency: Math.max(1, Math.min(2, Number(env.QUEUE_TRANSLATION_CONCURRENCY || 2)))
  }
}

function translationCacheKey(tokenData, model, env) {
  return makeCacheKey(
    tokenData.url,
    model,
    cacheVersion(env),
    tokenData.cacheId
  )
}

async function readQueueJobState(env, cacheKey) {
  if (!validTranslationCacheKey(cacheKey)) return null
  const kv = env.SMARTSUBS_CACHE
  if (!kv || typeof kv.get !== 'function') return null

  try {
    const value = await kv.get(queueJobKey(cacheKey), { type: 'json' })
    if (!value) return null
    if (typeof value === 'string') return JSON.parse(value)
    return value
  } catch {
    return null
  }
}

async function writeQueueJobState(env, cacheKey, value = {}) {
  if (!validTranslationCacheKey(cacheKey)) return false
  const kv = env.SMARTSUBS_CACHE
  if (!kv || typeof kv.put !== 'function') return false

  const clean = {
    v: 1,
    state: String(value.state || ''),
    updatedAt: Date.now()
  }
  if (value.configId) clean.configId = String(value.configId).slice(0, 128)
  if (value.attempts !== undefined) clean.attempts = Math.max(0, Number(value.attempts || 0))
  const retryMode = normaliseQueueRetryMode(value.retryMode)
  if (retryMode) clean.retryMode = retryMode

  await kv.put(
    queueJobKey(cacheKey),
    JSON.stringify(clean),
    { expirationTtl: queueJobTtlSeconds(env) }
  )
  return true
}

function queueJobActive(job) {
  return Boolean(job && ['queued', 'running', 'retrying', 'ready'].includes(String(job.state || '')))
}

async function sleepMs(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForQueueCache(options = {}) {
  const env = options.env || {}
  const cache = options.cache
  const cacheKey = String(options.cacheKey || '')
  const sleepFn = options.sleepFn || sleepMs
  const nowFn = options.nowFn || Date.now
  const maxWaitMs = Math.max(0, Number(options.maxWaitMs ?? queueJoinMaxMs(env)))
  const pollMs = Math.max(1, Number(options.pollMs ?? queueJoinPollMs(env)))
  const adaptivePlayerPolling = options.playerAdaptivePolling === true
  const mediaType = String(options.mediaType || '').toLowerCase()
  const startedAt = nowFn()
  let polls = 0
  let job = options.initialJob || await readQueueJobState(env, cacheKey)

  while (queueJobActive(job)) {
    const now = nowFn()
    const elapsed = Math.max(0, now - startedAt)
    if (elapsed >= maxWaitMs) break

    let nextPollMs = pollMs
    if (adaptivePlayerPolling) {
      const plan = playerQueuePollPlan(env, job, now, mediaType)
      nextPollMs = Math.max(1, Number(plan.pollMs || pollMs))
      if (Number(plan.boundaryMs || 0) > 0) {
        nextPollMs = Math.min(nextPollMs, Math.max(1, Number(plan.boundaryMs)))
      }
    }

    const waitMs = Math.min(nextPollMs, Math.max(1, maxWaitMs - elapsed))
    await sleepFn(waitMs)
    polls++

    const ready = await readReadyTranslation(env, cache, cacheKey)
    if (ready) {
      return {
        vtt: ready.vtt,
        waitMs: Math.max(0, nowFn() - startedAt),
        polls,
        jobStatus: String(job?.state || 'unknown'),
        outcome: 'hit',
        cacheSource: ready.source,
        graceWaitMs: 0,
        graceHit: false
      }
    }

    if (polls === 1 || polls % 3 === 0) {
      job = await readQueueJobState(env, cacheKey)
      if (job && job.state === 'failed') break
    }
  }

  const finalReady = await readReadyTranslation(env, cache, cacheKey)
  if (finalReady) {
    return {
      vtt: finalReady.vtt,
      waitMs: Math.max(0, nowFn() - startedAt),
      polls,
      jobStatus: String(job?.state || 'unknown'),
      outcome: 'hit',
      cacheSource: finalReady.source,
      graceWaitMs: 0,
      graceHit: false
    }
  }

  const graceMs = Math.max(0, Math.min(1000, Number(options.graceMs || 0)))
  if (graceMs > 0 && queueJobActive(job)) {
    const graceStartedAt = nowFn()
    await sleepFn(graceMs)
    const graceReady = await readReadyTranslation(env, cache, cacheKey)
    const graceWaitMs = Math.max(0, nowFn() - graceStartedAt)

    if (graceReady) {
      return {
        vtt: graceReady.vtt,
        waitMs: Math.max(0, nowFn() - startedAt),
        polls,
        jobStatus: String(job?.state || 'unknown'),
        outcome: 'hit',
        cacheSource: graceReady.source,
        graceWaitMs,
        graceHit: true
      }
    }

    return {
      vtt: null,
      waitMs: Math.max(0, nowFn() - startedAt),
      polls,
      jobStatus: String(job?.state || 'missing'),
      outcome: job && job.state === 'failed' ? 'failed' : 'timeout',
      graceWaitMs,
      graceHit: false
    }
  }

  return {
    vtt: null,
    waitMs: Math.max(0, nowFn() - startedAt),
    polls,
    jobStatus: String(job?.state || 'missing'),
    outcome: job && job.state === 'failed' ? 'failed' : 'timeout',
    graceWaitMs: 0,
    graceHit: false
  }
}

function parseAutoTranslationToken(autoUrl) {
  const value = String(autoUrl || '')
  if (!value) return ''
  try {
    const match = new URL(value).pathname.match(/\/translated\/([A-Za-z0-9_.-]+)\.vtt$/)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

async function enqueuePrefetchTranslation(options = {}) {
  const autoUrl = String(options.autoUrl || '')
  const env = options.env || {}
  const configToken = String(options.configToken || '')
  const configId = String(options.configId || '')
  const diagnosticFn = options.diagnosticFn || ((_kv, id, event) => recordConfiguredDiagnostic(env, id, event))
  const translationToken = parseAutoTranslationToken(autoUrl)
  const cacheKey = String(options.cacheKey || '')
  const sourceId = String(options.sourceId || '')
  const requestedProfile = normaliseRequestedQueueProfile(options.queueProfile)

  if (!translationToken || !configToken || !configId) return false

  if (validTranslationCacheKey(cacheKey)) {
    const cached = await getCache(env).get(cacheKey).catch(() => null)
    if (cached) {
      return true
    }

    const job = await readQueueJobState(env, cacheKey)
    if (queueJobActive(job) && job.state !== 'ready') {
      await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
        event: 'queue-deduped',
        status: job.state,
        sourceId: sourceId || undefined
      }).catch(() => {})
      return true
    }
  }

  const queue = env.SMARTSUBS_TRANSLATION_QUEUE
  if (!queue || typeof queue.send !== 'function') {
    if (validTranslationCacheKey(cacheKey)) {
      await writeQueueJobState(env, cacheKey, {
        state: 'failed',
        configId
      }).catch(() => {})
    }
    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'queue-enqueue-failed',
      status: 'queue-missing',
      sourceId: sourceId || undefined
    }).catch(() => {})
    return false
  }

  try {
    if (validTranslationCacheKey(cacheKey)) {
      await writeQueueJobState(env, cacheKey, {
        state: 'queued',
        configId,
        attempts: 0
      })
    }

    await queue.send({
      v: 1,
      configToken,
      translationToken,
      configId,
      cacheKey: validTranslationCacheKey(cacheKey) ? cacheKey : '',
      profile: requestedProfile,
      queuedAt: Date.now()
    })

    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'queue-enqueued',
      status: 'queued',
      sourceId: sourceId || undefined,
      profile: requestedProfile || 'background-default'
    }).catch(() => {})
    return true
  } catch (error) {
    if (validTranslationCacheKey(cacheKey)) {
      await writeQueueJobState(env, cacheKey, {
        state: 'failed',
        configId
      }).catch(() => {})
    }
    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'queue-enqueue-failed',
      status: 'queue-send-failed',
      sourceId: sourceId || undefined,
      error: safeMessage(error, '')
    }).catch(() => {})
    return false
  }
}
async function processQueueMessage(body, env, options = {}) {
  const payload = body && typeof body === 'object' ? body : {}
  const secret = serverSecret(env)
  const configToken = String(payload.configToken || '')
  const translationToken = String(payload.translationToken || '')
  const configId = String(payload.configId || '')
  env.__kvUsageTracker?.setConfigId(configId)
  const attempts = Math.max(1, Number(options.attempts || 1))
  const diagnosticFn = options.diagnosticFn || ((_kv, id, event) => recordConfiguredDiagnostic(env, id, event))
  const getOrTranslateFn = options.getOrTranslateFn || cfGetOrTranslate
  const startedAt = nowMs()
  const epochNowFn = typeof options.epochNowFn === 'function' ? options.epochNowFn : Date.now
  const queuedAt = Number(payload.queuedAt || 0)
  const queueDelayMs = queuedAt > 0 ? Math.max(0, roundMs(epochNowFn() - queuedAt)) : 0
  const requestedProfile = normaliseRequestedQueueProfile(payload.profile)
  let retryMode = ''
  let queueProfile = null
  let queueProfileName = ''

  if (!secret) throw new Error('SmartSubs server secret is not configured')
  if (payload.v !== 1 || !configToken || !translationToken || !configId) {
    throw new Error('Invalid SmartSubs queue message')
  }
  if (configToken.length > 2048 || translationToken.length > 8192 || configId.length > 128) {
    throw new Error('Invalid SmartSubs queue message size')
  }

  let userConfig = null
  let cacheKey = ''
  let selectedSourceId = ''
  try {
    userConfig = decodeUserConfigToken(configToken, { secret })
    const tokenData = decodeTranslationTokenData(translationToken, secret)
    selectedSourceId = tokenData.sourceId
    env.__kvUsageTracker?.setMedia(tokenData.media)
    const expectedCacheKey = translationCacheKey(tokenData, userConfig.model, env)
    const suppliedCacheKey = String(payload.cacheKey || '')

    if (suppliedCacheKey && suppliedCacheKey !== expectedCacheKey) {
      throw new Error('Invalid SmartSubs queue cache key')
    }
    cacheKey = expectedCacheKey

    if (attempts > 1) {
      const previousJob = await readQueueJobState(env, cacheKey)
      retryMode = normaliseQueueRetryMode(previousJob?.retryMode)
    }
    queueProfile = queueTranslationOptions(env, attempts, requestedProfile, retryMode)
    queueProfileName = queueTranslationProfile(env, attempts, requestedProfile, retryMode)

    await writeQueueJobState(env, cacheKey, {
      state: 'running',
      configId,
      attempts,
      retryMode
    }).catch(() => {})

    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'queue-translation-start',
      sourceId: selectedSourceId,
      status: 'consumer',
      attempts,
      profile: queueProfileName,
      retryMode: retryMode || undefined,
      queueDelayMs,
      mediaType: tokenData.media?.type,
      movieAdaptiveChunking: tokenData.media?.type === 'movie' && queueProfileName !== 'fallback-stable',
      movieTargetChunks: movieAdaptiveTargetChunks(env),
      movieChunkItemsMin: movieAdaptiveChunkItemsMin(env),
      movieChunkItemsMax: movieAdaptiveChunkItemsMax(env),
      chunkItems: queueProfile.maxItems,
      chunkChars: queueProfile.maxChars,
      concurrency: queueProfile.concurrency
    }).catch(() => {})

    if (!env.SMARTSUBS_CACHE) throw new Error('SMARTSUBS_CACHE KV binding is not configured')

    const result = await getOrTranslateFn({
      cache: getCache(env),
      upstreamUrl: tokenData.url,
      sourceId: tokenData.cacheId,
      model: userConfig.model,
      apiKey: userConfig.apiKey,
      cacheVersion: cacheVersion(env),
      translateOptions: queueProfile,
      translateContext: {
        mediaType: tokenData.media?.type,
        movieAdaptiveChunking: tokenData.media?.type === 'movie' && queueProfileName !== 'fallback-stable',
        movieTargetChunks: movieAdaptiveTargetChunks(env),
        movieChunkItemsMin: movieAdaptiveChunkItemsMin(env),
        movieChunkItemsMax: movieAdaptiveChunkItemsMax(env),
        abortRetryDelayMs: geminiChunkAbortRetryMs(env),
        movieHedgeEnabled: movieGeminiHedgeEnabled(env),
        movieHedgeDelayMs: movieGeminiHedgeDelayMs(env)
      }
    })

    env.__kvUsageTracker?.setCacheResult(result.status)
    const deliveryRelayStored = await writeDeliveryRelay(env, cacheKey, result.vtt)

    await writeQueueJobState(env, cacheKey, {
      state: 'ready',
      configId,
      attempts
    }).catch(() => {})

    const totalMs = roundMs(nowMs() - startedAt)
    const repair = result.translationStats || {}

    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'queue-translation-complete',
      sourceId: selectedSourceId,
      cache: result.status,
      status: 'ready',
      attempts,
      profile: queueProfileName,
      retryMode: retryMode || undefined,
      totalMs,
      expected: repair.expected,
      received: repair.received,
      missing: repair.missing,
      retryRecovered: repair.retryRecovered,
      fallbackCount: repair.fallbackCount,
      final: repair.final,
      semanticRetriesUsed: repair.semanticRetriesUsed,
      chunks: repair.chunks,
      geminiCalls: repair.geminiCalls,
      rateLimits: repair.rateLimits,
      transientRetries: repair.transientRetries,
      abortRetries: repair.abortRetries,
      retryWaitMs: repair.retryWaitMs,
      hedgeStarts: repair.hedgeStarts,
      hedgeReplicaWins: repair.hedgeReplicaWins,
      hedgeCancels: repair.hedgeCancels,
      mediaType: tokenData.media?.type,
      movieAdaptiveChunking: tokenData.media?.type === 'movie' && queueProfileName !== 'fallback-stable',
      movieTargetChunks: movieAdaptiveTargetChunks(env),
      movieChunkItemsMin: movieAdaptiveChunkItemsMin(env),
      movieChunkItemsMax: movieAdaptiveChunkItemsMax(env),
      chunkItems: repair.chunkItems,
      chunkChars: repair.chunkChars,
      concurrency: repair.concurrency,
      queueDelayMs,
      delivery: deliveryRelayStored ? 'relay-stored' : 'kv-only',
      sourceFetchMs: repair.sourceFetchMs,
      parseMs: repair.parseMs,
      sourceBytes: repair.sourceBytes,
      cueCount: repair.cueCount,
      pipelineMs: repair.pipelineMs,
      translationWallMs: repair.translationWallMs,
      chunkTimeline: repair.chunkTimeline,
      maxChunkMs: repair.maxChunkMs,
      avgChunkMs: repair.avgChunkMs,
      sumChunkMs: repair.sumChunkMs,
      geminiCallMs: repair.geminiCallMs,
      geminiStatuses: repair.geminiStatuses,
      geminiPromptChars: repair.geminiPromptChars,
      geminiFinishReasons: repair.geminiFinishReasons,
      geminiInputTokens: repair.geminiInputTokens,
      geminiOutputTokens: repair.geminiOutputTokens,
      geminiTotalTokens: repair.geminiTotalTokens,
      geminiInputTokensTotal: repair.geminiInputTokensTotal,
      geminiOutputTokensTotal: repair.geminiOutputTokensTotal,
      geminiTotalTokensTotal: repair.geminiTotalTokensTotal,
      sdhRemoved: repair.sdhRemoved
    }).catch(() => {})

    logPerf({
      milestone: 'M20R2',
      route: 'queue-consumer',
      cache: result.status,
      configId,
      totalMs
    })

    return result
  } catch (error) {
    if (validTranslationCacheKey(cacheKey)) {
      await writeQueueJobState(env, cacheKey, {
        state: 'failed',
        configId,
        attempts
      }).catch(() => {})
    }

    const perf = error?.smartsubsPerf || {}
    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'queue-translation-failed',
      sourceId: selectedSourceId || undefined,
      status: 'consumer-failed',
      attempts,
      profile: queueProfileName,
      retryMode: retryMode || undefined,
      queueDelayMs,
      failureStage: queueFailureStage(error),
      error: safeMessage(error, userConfig?.apiKey || ''),
      totalMs: roundMs(nowMs() - startedAt),
      sourceFetchMs: perf.sourceFetchMs,
      parseMs: perf.parseMs,
      sourceBytes: perf.sourceBytes,
      cueCount: perf.cueCount,
      pipelineMs: perf.pipelineMs,
      translationWallMs: perf.translationWallMs,
      chunkTimeline: perf.chunkTimeline,
      maxChunkMs: perf.maxChunkMs,
      avgChunkMs: perf.avgChunkMs,
      sumChunkMs: perf.sumChunkMs,
      abortRetries: perf.abortRetries,
      hedgeStarts: perf.hedgeStarts,
      hedgeReplicaWins: perf.hedgeReplicaWins,
      hedgeCancels: perf.hedgeCancels,
      geminiCallMs: perf.geminiCallMs,
      geminiStatuses: perf.geminiStatuses,
      geminiPromptChars: perf.geminiPromptChars,
      geminiFinishReasons: perf.geminiFinishReasons,
      geminiInputTokens: perf.geminiInputTokens,
      geminiOutputTokens: perf.geminiOutputTokens,
      geminiTotalTokens: perf.geminiTotalTokens,
      geminiInputTokensTotal: perf.geminiInputTokensTotal,
      geminiOutputTokensTotal: perf.geminiOutputTokensTotal,
      geminiTotalTokensTotal: perf.geminiTotalTokensTotal,
      sdhRemoved: perf.sdhRemoved
    }).catch(() => {})
    throw error
  }
}
function queueRetryPolicy(error, attempts = 1) {
  const attempt = Math.max(1, Number(attempts || 1))
  const message = String(error?.message || error || '')
  const failureStage = queueFailureStage(error)
  const rateLimited = /Gemini HTTP 429/i.test(message)
  const serverOverload = /Gemini HTTP (408|5\d\d)/i.test(message)
  const transientAbort = failureStage === 'gemini' && !rateLimited && !serverOverload && /aborted|aborterror|timeout/i.test(message)

  if (attempt === 1 && transientAbort) {
    return {
      delaySeconds: 2,
      retryMode: 'fast-transient',
      policy: 'fast-transient-retry'
    }
  }

  if (rateLimited) {
    return {
      delaySeconds: attempt === 1 ? 30 : Math.min(60, attempt * 10),
      retryMode: 'safe-fallback',
      policy: 'rate-limit-safe-fallback'
    }
  }

  if (serverOverload) {
    return {
      delaySeconds: attempt === 1 ? 10 : Math.min(60, attempt * 10),
      retryMode: 'safe-fallback',
      policy: 'server-safe-fallback'
    }
  }

  if (attempt === 2) {
    return {
      delaySeconds: 10,
      retryMode: 'safe-fallback',
      policy: 'second-failure-safe-fallback'
    }
  }

  return {
    delaySeconds: Math.min(60, attempt * 10),
    retryMode: 'safe-fallback',
    policy: 'standard-safe-fallback'
  }
}

async function handleQueue(batch, env, options = {}) {
  const processFn = options.processFn || processQueueMessage

  for (const message of batch?.messages || []) {
    const tracker = options.trackUsage ? createKvUsageTracker({ phase: 'queue', attempt: message.attempts }) : null
    const messageEnv = tracker ? trackedEnvironment(env, tracker) : env
    tracker?.setConfigId(message?.body?.configId)
    try {
      await processFn(message.body, messageEnv, {
        attempts: message.attempts
      })
      if (typeof message.ack === 'function') message.ack()
    } catch (error) {
      const text = String(error?.message || error || '')
      const permanent = /Gemini HTTP (401|403)|Invalid SmartSubs queue message|Invalid SmartSubs queue cache key|Invalid user config token|Invalid translation token/i.test(text)
      const cacheKey = String(message?.body?.cacheKey || '')
      const configId = String(message?.body?.configId || '')

      if (permanent) {
        if (validTranslationCacheKey(cacheKey)) {
          await writeQueueJobState(messageEnv, cacheKey, {
            state: 'failed',
            configId,
            attempts: message.attempts
          }).catch(() => {})
        }
        await recordConfiguredDiagnostic(messageEnv, configId, {
          event: 'queue-retry-stopped',
          status: 'permanent',
          attempts: message.attempts,
          failureStage: queueFailureStage(error),
          reason: safeMessage(error, '')
        }).catch(() => {})
        if (typeof message.ack === 'function') message.ack()
      } else if (typeof message.retry === 'function') {
        const attempts = Math.max(1, Number(message.attempts || 1))
        const retryPolicy = queueRetryPolicy(error, attempts)
        const retryDelaySeconds = retryPolicy.delaySeconds
        if (validTranslationCacheKey(cacheKey)) {
          await writeQueueJobState(messageEnv, cacheKey, {
            state: 'retrying',
            configId,
            attempts,
            retryMode: retryPolicy.retryMode
          }).catch(() => {})
        }
        await recordConfiguredDiagnostic(messageEnv, configId, {
          event: 'queue-retry-scheduled',
          status: 'retrying',
          attempts,
          nextAttempt: attempts + 1,
          retryDelaySeconds,
          retryMode: retryPolicy.retryMode,
          retryPolicy: retryPolicy.policy,
          failureStage: queueFailureStage(error),
          reason: safeMessage(error, '')
        }).catch(() => {})
        message.retry({ delaySeconds: retryDelaySeconds })
      }
    } finally {
      tracker?.flush()
      if (tracker) await publishKvUsage(env, tracker).catch(() => {})
    }
  }
}
function shouldPrefetchAutoResult(_result, _autoUrl) {
  // V2 multi-candidate mode is strictly on-demand. Subtitle discovery must never
  // enqueue Gemini work before the player requests a specific translated track.
  return false
}

async function configuredRequest(request, env, token, suffix, executionCtx = null) {
  const secret = serverSecret(env)
  if (!secret) return send(503, 'text/plain; charset=utf-8', 'SmartSubs server secret is not configured', { noStore: true })

  let userConfig
  try {
    userConfig = decodeUserConfigToken(token, { secret })
  } catch {
    return send(401, 'text/plain; charset=utf-8', 'Invalid SmartSubs configuration', { noStore: true })
  }

  const configId = tokenFingerprint(token)
  env.__kvUsageTracker?.setConfigId(configId)

  if (request.method === 'GET' && suffix === '/manifest.json') {
    return json(createConfiguredManifest(), 200, { noStore: true })
  }

  if (request.method === 'GET' && suffix === '/configure') {
    return new Response(null, {
      status: 302,
      headers: { location: '/configure', 'cache-control': 'no-store' }
    })
  }

  if (request.method === 'POST' && (suffix === '/kv-monitor/test/start' || suffix === '/kv-monitor/test/end')) {
    const stub = monitorStub(env, configId)
    if (!stub) return send(503, 'text/plain; charset=utf-8', 'KV Monitor is not available', { noStore: true })
    // The configured token must already have passed verification above.
    const action = suffix.endsWith('/start') ? 'start' : 'end'
    try {
      const response = await stub.fetch(`https://smartsubs-monitor.internal/test/${action}`, { method: 'POST' })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        return send(response.status, 'text/plain; charset=utf-8', String(result.reason || 'Monitor test action failed'), { noStore: true })
      }
      return new Response(null, { status: 303, headers: {
        location: new URL(request.url).pathname.replace(/\/test\/(start|end)$/, ''),
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer'
      } })
    } catch {
      return send(503, 'text/plain; charset=utf-8', 'Monitor test is temporarily unavailable', { noStore: true })
    }
  }

  if (request.method === 'GET' && suffix === '/kv-monitor') {
    const stub = monitorStub(env, configId)
    if (!stub) return send(503, 'text/plain; charset=utf-8', 'KV Monitor requires SMARTSUBS_DELIVERY Durable Object binding', { noStore: true })
    try {
      const response = await stub.fetch('https://smartsubs-monitor.internal/monitor')
      if (!response.ok) throw new Error('Monitor not ready')
      const { reports, testState } = await response.json()
      return send(200, 'text/html; charset=utf-8', renderKvMonitor(reports, testState), {
        noStore: true, csp: true,
        headers: { 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' }
      })
    } catch {
      return send(503, 'text/plain; charset=utf-8', 'KV Monitor is temporarily unavailable', { noStore: true })
    }
  }

  if (request.method === 'GET' && suffix === '/diagnose') {
    const state = await diagnosticState(env, configId)
    const events = state.enabled
      ? (await readDiagnostics(env.SMARTSUBS_CACHE, configId).catch(() => [])).filter(item => Number(item.ts) >= state.since)
      : []
    return send(200, 'text/html; charset=utf-8', renderConfiguredDiagnosePage(configId, events, {
      ...state, ready: diagnosticAdminReady(env) && Boolean(monitorStub(env, configId))
    }), { noStore: true, csp: true, headers: { 'x-robots-tag': 'noindex, nofollow' } })
  }

  if (request.method === 'POST' && suffix === '/diagnose/toggle') {
    // A configured addon URL is shared with the player, and is NOT admin authentication.
    // Turning ON requires the separate Cloudflare secret. OFF is deliberately public
    // to anyone who can access this configured addon URL, as requested by the owner.
    const adminKey = String(env.SMARTSUBS_DIAG_ADMIN_KEY || '')
    if (!diagnosticAdminReady(env)) return send(503, 'text/plain; charset=utf-8', 'Diagnostic admin key is not configured', { noStore: true })
    // Browser metadata (Origin / Sec-Fetch-Site) can vary in privacy browsers,
    // embedded players and proxy deployments. It is not authentication.
    // Authenticate every ON request using the separate server-side admin key below;
    // never save the key in a cookie, GET parameter, or diagnostics log.
    if (Number(request.headers.get('content-length') || 0) > 2048) return send(413, 'text/plain; charset=utf-8', 'Form too large', { noStore: true })
    let form
    try {
      if (!String(request.headers.get('content-type') || '').startsWith('application/x-www-form-urlencoded')) throw new Error('Unsupported form')
      const text = await request.text()
      if (text.length > 2048) throw new Error('Form too large')
      form = new URLSearchParams(text)
    } catch { return send(400, 'text/plain; charset=utf-8', 'Invalid form', { noStore: true }) }
    const action = form.get('action')
    if (!['on', 'off'].includes(action) ||
        (action === 'on' && !validDiagnosticAdminKey(form.get('adminKey'), adminKey))) {
      return send(403, 'text/plain; charset=utf-8', 'Invalid admin key or action', { noStore: true })
    }
    const stub = monitorStub(env, configId)
    if (!stub) return send(503, 'text/plain; charset=utf-8', 'Diagnostics switch requires SMARTSUBS_DELIVERY', { noStore: true })
    try {
      const response = await stub.fetch('https://smartsubs-monitor.internal/diagnostics/state', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: action === 'on' })
      })
      if (!response.ok) throw new Error('State update failed')
    } catch { return send(503, 'text/plain; charset=utf-8', 'Diagnostics switch unavailable. Try again.', { noStore: true }) }
    return new Response(null, { status: 303, headers: {
      location: new URL(request.url).pathname.replace(/\/toggle$/, ''),
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer'
    } })
  }

  const translationMatch = request.method === 'GET' && suffix.match(/^\/translated\/([A-Za-z0-9_.-]+)\.vtt$/)
  if (translationMatch) {
    const startedAt = nowMs()
    let selectedSourceId = ''

    try {
      if (!env.SMARTSUBS_CACHE) throw new Error('SMARTSUBS_CACHE KV binding is not configured')

      const tokenData = decodeTranslationTokenData(translationMatch[1], secret)
      selectedSourceId = tokenData.sourceId
      await recordConfiguredDiagnostic(env, configId, {
        event: 'translation-request',
        status: 'player',
        sourceId: selectedSourceId,
        ...translationRequestProbe(request)
      }).catch(() => {})
      env.__kvUsageTracker?.setMedia(tokenData.media)
      const cache = getCache(env)
      const cacheKey = translationCacheKey(tokenData, userConfig.model, env)
      let joinWaitMs = 0
      let joinPolls = 0
      let joinGraceMs = 0
      let joinGraceHit = false
      let joinStatus = ''
      let result = null

      const ready = await readReadyTranslation(env, cache, cacheKey)
      if (ready) {
        result = {
          vtt: ready.vtt,
          cacheKey,
          status: ready.source,
          translationStats: null
        }
        joinStatus = ready.source === 'DELIVERY_RELAY' ? 'delivery-relay-hit' : 'cache-hit'
      } else {
        const job = await readQueueJobState(env, cacheKey)
        if (queueJobActive(job)) {
          await recordConfiguredDiagnostic(env, configId, {
            event: 'queue-join-start',
            sourceId: selectedSourceId,
            status: job.state
          }).catch(() => {})

          const joined = await waitForQueueCache({
            env,
            cache,
            cacheKey,
            initialJob: job,
            maxWaitMs: playerQueueWaitMaxMs(env, tokenData.media?.type),
            graceMs: playerQueueGraceMs(env),
            playerAdaptivePolling: true,
            mediaType: tokenData.media?.type
          })

          joinWaitMs = joined.waitMs
          joinPolls = joined.polls
          joinGraceMs = Number(joined.graceWaitMs || 0)
          joinGraceHit = joined.graceHit === true
          joinStatus = joined.graceHit ? 'queue-join-grace-hit' : joined.outcome

          if (joined.vtt) {
            result = {
              vtt: joined.vtt,
              cacheKey,
              status: joined.cacheSource === 'DELIVERY_RELAY' ? 'DELIVERY_RELAY' : 'QUEUE_JOIN',
              translationStats: null
            }
            await recordConfiguredDiagnostic(env, configId, {
              event: 'queue-join-hit',
              sourceId: selectedSourceId,
              status: joined.jobStatus,
              waitMs: joinWaitMs,
              polls: joinPolls,
              graceMs: joinGraceMs,
              graceHit: joinGraceHit
            }).catch(() => {})
            if (joinGraceHit) {
              await recordConfiguredDiagnostic(env, configId, {
                event: 'queue-grace-hit',
                sourceId: selectedSourceId,
                status: joined.jobStatus,
                waitMs: joinWaitMs,
                graceMs: joinGraceMs
              }).catch(() => {})
            }
          } else if (joined.outcome !== 'failed') {
            await recordConfiguredDiagnostic(env, configId, {
              event: 'translation-pending',
              sourceId: selectedSourceId,
              status: joined.jobStatus,
              waitMs: joinWaitMs,
              polls: joinPolls,
              graceMs: joinGraceMs,
              graceHit: joinGraceHit,
              reason: joined.outcome
            }).catch(() => {})

            return translationPreparingResponse()
          }
        }
      }

      if (!result) {
        if (!await rateLimitAllowed(env.SMARTSUBS_GENERATE_LIMITER, `generate:${configId}`)) {
          return rateLimitedResponse('translation generation')
        }

        const queued = await enqueuePrefetchTranslation({
          autoUrl: request.url,
          env,
          configToken: token,
          configId,
          cacheKey,
          sourceId: selectedSourceId,
          queueProfile: 'user-selected-stable'
        })

        if (queued) {
          await recordConfiguredDiagnostic(env, configId, {
            event: 'player-translation-queued',
            sourceId: selectedSourceId,
            status: 'queued'
          }).catch(() => {})

          const joined = await waitForQueueCache({
            env,
            cache,
            cacheKey,
            maxWaitMs: playerQueueWaitMaxMs(env, tokenData.media?.type),
            graceMs: playerQueueGraceMs(env),
            playerAdaptivePolling: true,
            mediaType: tokenData.media?.type
          })

          joinWaitMs = joined.waitMs
          joinPolls = joined.polls
          joinGraceMs = Number(joined.graceWaitMs || 0)
          joinGraceHit = joined.graceHit === true
          joinStatus = joined.outcome === 'hit'
            ? (joined.graceHit ? 'player-queue-grace-hit' : 'player-queue-hit')
            : `player-queue-${joined.outcome}`

          if (joined.vtt) {
            if (joinGraceHit) {
              await recordConfiguredDiagnostic(env, configId, {
                event: 'queue-grace-hit',
                sourceId: selectedSourceId,
                status: joined.jobStatus || 'queued',
                waitMs: joinWaitMs,
                graceMs: joinGraceMs
              }).catch(() => {})
            }
            result = {
              vtt: joined.vtt,
              cacheKey,
              status: joined.cacheSource === 'DELIVERY_RELAY' ? 'DELIVERY_RELAY' : 'QUEUE_JOIN',
              translationStats: null
            }
          } else if (joined.outcome !== 'failed') {
            await recordConfiguredDiagnostic(env, configId, {
              event: 'translation-pending',
              sourceId: selectedSourceId,
              status: joined.jobStatus || 'queued',
              waitMs: joinWaitMs,
              polls: joinPolls,
              graceMs: joinGraceMs,
              graceHit: joinGraceHit,
              reason: joined.outcome
            }).catch(() => {})

            return translationPreparingResponse()
          }
        }

        if (!result) {
          joinStatus = joinStatus || 'direct-fallback'
          result = await cfGetOrTranslate({
            cache,
            upstreamUrl: tokenData.url,
            sourceId: tokenData.cacheId,
            model: userConfig.model,
            apiKey: userConfig.apiKey,
            cacheVersion: cacheVersion(env)
          })
        }
      }
      env.__kvUsageTracker?.setCacheResult(result.status)
      const totalMs = roundMs(nowMs() - startedAt)
      logPerf({
        milestone: 'M20R2',
        route: 'translated',
        cache: result.status,
        cacheId: result.cacheKey.slice(0, 16),
        configId,
        totalMs
      })

      const repair = result.translationStats || {}
      await recordConfiguredDiagnostic(env, configId, {
        event: 'translation-delivered',
        sourceId: selectedSourceId,
        cache: result.status,
        totalMs,
        waitMs: joinWaitMs,
        polls: joinPolls,
        graceMs: joinGraceMs,
        graceHit: joinGraceHit,
        joinStatus,
        expected: repair.expected,
        received: repair.received,
        missing: repair.missing,
        retryRecovered: repair.retryRecovered,
        fallbackCount: repair.fallbackCount,
        final: repair.final,
        semanticRetriesUsed: repair.semanticRetriesUsed,
        chunks: repair.chunks,
        geminiCalls: repair.geminiCalls,
        rateLimits: repair.rateLimits,
        transientRetries: repair.transientRetries,
        retryWaitMs: repair.retryWaitMs,
        chunkItems: repair.chunkItems,
        chunkChars: repair.chunkChars,
        concurrency: repair.concurrency
      }).catch(() => {})

      return send(200, 'text/vtt; charset=utf-8', result.vtt, {
        cacheControl: 'private, max-age=86400, immutable',
        headers: {
          'x-smartsubs-cache': result.status,
          'x-smartsubs-version': manifest.version,
          'x-smartsubs-build': BUILD_ID
        }
      })
    } catch (error) {
      console.error(JSON.stringify({
        tag: 'SMARTSUBS_TRANSLATION_ERROR',
        configId,
        message: safeMessage(error, userConfig.apiKey)
      }))
      const classified = classifyTranslationError(error)
      await recordConfiguredDiagnostic(env, configId, {
        event: 'translation-failed',
        sourceId: selectedSourceId || undefined,
        status: classified.code,
        error: safeMessage(error, userConfig.apiKey),
        totalMs: roundMs(nowMs() - startedAt)
      }).catch(() => {})

      return send(
        classified.status,
        'text/plain; charset=utf-8',
        classified.publicMessage,
        {
          noStore: true,
          headers: {
            'x-smartsubs-error': classified.code,
            'retry-after': classified.retryAfter,
            'x-smartsubs-build': BUILD_ID
          }
        }
      )
    }
  }
  if (request.method === 'GET') {
    const args = parseSubtitleArgs(suffix)
    if (args) {
      if (!await rateLimitAllowed(env.SMARTSUBS_SUBTITLE_LIMITER, `subtitle:${configId}`)) {
        return rateLimitedResponse('subtitle')
      }

      await recordConfiguredDiagnostic(env, configId, {
        event: 'subtitle-request',
        type: args.type,
        id: args.id
      }).catch(() => {})
      const result = await handleSubtitles(args, {
        apiKey: userConfig.apiKey,
        model: userConfig.model,
        includeEnglishTracks: true,
        publicBaseUrl: configuredBase(request, token),
        tokenSecret: secret,
        media: { type: args.type, id: args.id },
        onDiagnostic: event => recordConfiguredDiagnostic(env, configId, event)
      })

      const aiCandidateCount = Number(result?.aiCandidateCount || 0)
      if (aiCandidateCount > 0) {
        await recordConfiguredDiagnostic(env, configId, {
          event: 'auto-prefetch-skipped',
          status: 'on-demand',
          reason: result.autoPrefetchReason || 'on-demand-candidate-selection',
          aiCandidateCount
        }).catch(() => {})
      }

      return json(result, 200, { headers: { 'x-smartsubs-build': BUILD_ID } })
    }
  }

  return send(404, 'text/plain; charset=utf-8', 'Not found')
}

async function handleRequest(request, env, executionCtx = null) {
  const url = new URL(request.url)
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type'
      }
    })
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    const cache = getCache(env)
    return json({
      ok: true,
      version: manifest.version,
      milestone: 'v1.0',
      build: BUILD_ID,
      diagnose: true,
      platform: 'cloudflare-workers',
      byok: true,
      secretConfigured: Boolean(serverSecret(env)),
      kvConfigured: Boolean(env.SMARTSUBS_CACHE),
      queueConfigured: Boolean(env.SMARTSUBS_TRANSLATION_QUEUE),
      rateLimitConfigured: Boolean(env.SMARTSUBS_SUBTITLE_LIMITER && env.SMARTSUBS_GENERATE_LIMITER),
      publicReady: publicReady(env),
      finalRelease: true,
      model: geminiModel(env),
      cache: cache.stats()
    }, 200, { noStore: true, headers: { 'x-smartsubs-build': BUILD_ID } })
  }

  if (request.method === 'GET' && url.pathname === '/diagnose') {
    return send(200, 'text/html; charset=utf-8', renderRootDiagnosePage(), { noStore: true, csp: true })
  }

  if (request.method === 'GET' && url.pathname === '/manifest.json') {
    return json(manifest)
  }

  if (request.method === 'GET' && url.pathname === '/configure') {
    return send(200, 'text/html; charset=utf-8', renderConfigurePage({
      secretReady: Boolean(serverSecret(env)),
      model: geminiModel(env)
    }), { noStore: true, csp: true })
  }

  if (request.method === 'POST' && url.pathname === '/configure') {
    let apiKey = ''
    try {
      const secret = serverSecret(env)
      if (!secret) throw new Error('Server secret is not configured')
      const form = await readConfigureForm(request)
      apiKey = String(form.geminiApiKey || '').trim()
      await validateGeminiApiKey(apiKey, { model: geminiModel(env) })
      const token = createUserConfigToken(apiKey, {
        secret,
        model: geminiModel(env)
      })
      const urls = buildConfiguredUrls(requestBase(request), token)
      logPerf({
        milestone: 'v1.0',
        route: 'configure',
        result: 'validated',
        configId: tokenFingerprint(token)
      })
      return send(200, 'text/html; charset=utf-8', renderConfigurePage({
        secretReady: true,
        model: geminiModel(env),
        manifestUrl: urls.manifestUrl,
        diagnoseUrl: `${urls.configuredBaseUrl}/diagnose`,
        installUrl: urls.installUrl,
      }), { noStore: true, csp: true })
    } catch (error) {
      console.error(JSON.stringify({
        tag: 'SMARTSUBS_CONFIG_ERROR',
        message: safeMessage(error, apiKey)
      }))
      return send(400, 'text/html; charset=utf-8', renderConfigurePage({
        secretReady: Boolean(serverSecret(env)),
        model: geminiModel(env),
        error: safeMessage(error, apiKey)
      }), { noStore: true, csp: true })
    }
  }

  const configuredMatch = url.pathname.match(/^\/c\/([^/]+)(\/.*)$/)
  if (configuredMatch) {
    if (configuredMatch[1].length > 4096 || configuredMatch[2].length > 16384) {
      return send(414, 'text/plain; charset=utf-8', 'SmartSubs request URL is too long', { noStore: true })
    }

    let token
    try {
      token = decodeURIComponent(configuredMatch[1])
    } catch {
      return send(400, 'text/plain; charset=utf-8', 'Invalid SmartSubs configuration', { noStore: true })
    }

    if (token.length > 4096) {
      return send(400, 'text/plain; charset=utf-8', 'Invalid SmartSubs configuration', { noStore: true })
    }

    return configuredRequest(request, env, token, configuredMatch[2], executionCtx)
  }

  if (request.method === 'GET' && parseSubtitleArgs(url.pathname)) {
    return json({ subtitles: [], cacheMaxAge: 60 })
  }

  return send(404, 'text/plain; charset=utf-8', 'Not found')
}

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url)
    const configured = url.pathname.match(/^\/c\/[^/]+(\/.*)$/)
    const args = configured ? parseSubtitleArgs(configured[1]) : null
    const phase = args ? 'subtitle-list' : configured?.[1].startsWith('/translated/') ? 'player-translation' : 'other'
    const tracker = createKvUsageTracker({ phase, media: args && { type: args.type, id: args.id } })
    const messageEnv = trackedEnvironment(env, tracker)
    try {
      return await handleRequest(request, messageEnv, executionCtx)
    } catch (error) {
      console.error(JSON.stringify({
        tag: 'SMARTSUBS_CF_FATAL',
        message: safeMessage(error, '')
      }))
      return send(500, 'text/plain; charset=utf-8', 'SmartSubs internal error', { noStore: true })
    } finally {
      tracker.flush()
      // A monitor failure must never prevent subtitles from being delivered.
      // waitUntil avoids delaying the player's subtitle request.
      if (executionCtx?.waitUntil) executionCtx.waitUntil(publishKvUsage(env, tracker).catch(() => {}))
      else await publishKvUsage(env, tracker).catch(() => {})
    }
  },
  async queue(batch, env) {
    await handleQueue(batch, env, { trackUsage: true })
  }
}

export { BUILD_ID, handleRequest, parseSubtitleArgs, safeMessage, translationRequestProbe, classifyTranslationError, renderConfiguredDiagnosePage, prefetchTranslation, parseAutoTranslationToken, enqueuePrefetchTranslation, processQueueMessage, handleQueue, normaliseRequestedQueueProfile, queueTranslationProfile, queueTranslationOptions, translationCacheKey, readQueueJobState, writeQueueJobState, queueJobActive, waitForQueueCache, queueFailureStage, queueRetryPolicy, normaliseQueueRetryMode, queueFinalEnabled, rateLimitAllowed, rateLimitedResponse, publicReady, shouldPrefetchAutoResult, playerQueueWaitMaxMs, playerQueueGraceMs, playerQueuePollEarlyMs, playerQueuePollFastStartMs, playerQueuePollLateStartMs, playerQueuePollLateMs, playerMoviePollStepMs, playerMoviePollFastStartMs, playerMoviePollLateMs, playerMovieQueuePollPlan, playerQueuePollPlan, movieAdaptiveTargetChunks, movieAdaptiveChunkItemsMin, movieAdaptiveChunkItemsMax, deliveryRelayTtlMs, readDeliveryRelay, writeDeliveryRelay, readReadyTranslation, translationPreparingResponse }
