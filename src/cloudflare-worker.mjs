import manifest from './manifest.js'
import configuredManifestModule from './configured-manifest.js'
import subtitlesModule from './subtitles.js'
import tokenModule from './token.js'
import userConfigModule from './user-config.js'
import configureModule from './configure.js'
import perfModule from './perf.js'
import diagnosticsModule from './diagnostics.js'
import { CloudflareTranslationCache, cfGetOrTranslate, makeCacheKey } from './cf-cache.mjs'

const { createConfiguredManifest } = configuredManifestModule
const { handleSubtitles } = subtitlesModule
const { decodeTranslationTokenData } = tokenModule
const { createUserConfigToken, decodeUserConfigToken, tokenFingerprint } = userConfigModule
const { buildConfiguredUrls, validateGeminiApiKey, renderConfigurePage, escapeHtml } = configureModule
const { nowMs, roundMs, logPerf } = perfModule
const { recordDiagnostic, readDiagnostics, deriveVerdict } = diagnosticsModule

const BUILD_ID = 'final-stable-m20r3'
const caches = new WeakMap()

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
  let cache = caches.get(binding)
  if (!cache) {
    cache = new CloudflareTranslationCache({
      kv: binding,
      ttlMs: cacheTtlMs(env),
      version: cacheVersion(env)
    })
    caches.set(binding, cache)
  }
  return cache
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubs Diagnose</title><style>:root{color-scheme:dark}body{margin:0;background:#101116;color:#f4f4f5;font-family:system-ui,sans-serif}.wrap{max-width:720px;margin:auto;padding:28px 18px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:20px}code{word-break:break-all;color:#c9ffdc}</style></head><body><main class="wrap"><section class="card"><h1>SmartSubs Diagnose</h1><p>Build: <code>${BUILD_ID}</code></p><p>Open diagnose through your configured SmartSubs URL:</p><code>https://.../c/YOUR_CONFIG_TOKEN/diagnose</code><p>The config token is required so diagnostics stay isolated to that SmartSubs installation.</p></section></main></body></html>`
}

function formatMalaysiaTime(timestamp) {
  const value = Number(timestamp || 0)
  if (!Number.isFinite(value) || value <= 0) return 'Unknown time'
  try {
    return `${new Intl.DateTimeFormat('en-MY', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(value))} MYT`
  } catch {
    return `${new Date(value).toISOString()} UTC`
  }
}

function formatDuration(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return 'Not available'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

function parseEnglishTop(values = []) {
  if (!Array.isArray(values)) return []
  return values.map(value => {
    const text = String(value || '')
    const match = text.match(/^(\d+):([^:]+):(-?\d+(?:\.\d+)?)$/)
    if (!match) return { raw: text }
    return {
      rank: Number(match[1]),
      id: match[2],
      score: Number(match[3])
    }
  })
}

function syncAssessment(lastSubtitle) {
  if (!lastSubtitle) {
    return {
      level: 'UNKNOWN',
      tone: 'neutral',
      reason: 'No subtitle request has been recorded yet.'
    }
  }

  const ranked = parseEnglishTop(lastSubtitle.englishTop)
  const top = ranked[0]
  const second = ranked[1]
  const gap = top && second && Number.isFinite(top.score) && Number.isFinite(second.score)
    ? top.score - second.score
    : null
  const candidates = Number(lastSubtitle.englishCandidateCount || ranked.length || 0)

  if (lastSubtitle.sourceVideoHashProvided) {
    return {
      level: 'STRONG',
      tone: 'good',
      reason: 'Player supplied a video hash, which gives SmartSubs a strong sync signal.'
    }
  }

  if (lastSubtitle.sourceVideoSizeProvided && lastSubtitle.sourceFilenameProvided) {
    return {
      level: 'GOOD',
      tone: 'good',
      reason: 'Player supplied both filename and video size, giving the selector useful release evidence.'
    }
  }

  if (candidates > 1 && gap !== null && gap <= 5 && !lastSubtitle.sourceVideoSizeProvided) {
    return {
      level: 'HIGH RISK',
      tone: 'bad',
      reason: `Top English candidates are almost tied${gap !== null ? ` by only ${gap} point${gap === 1 ? '' : 's'}` : ''}, with no video hash or size. Sync may depend heavily on OpenSubtitles ordering.`
    }
  }

  if (!lastSubtitle.sourceVideoHashProvided && !lastSubtitle.sourceVideoSizeProvided) {
    return {
      level: 'LIMITED',
      tone: 'warn',
      reason: lastSubtitle.sourceFilenameProvided
        ? 'Only the player filename is available. If it is a provider label rather than a real release filename, sync confidence is limited.'
        : 'The player supplied no filename, video hash, or video size for release matching.'
    }
  }

  return {
    level: 'MODERATE',
    tone: 'warn',
    reason: 'Some source metadata is available, but SmartSubs does not have a high-confidence video hash match.'
  }
}

function verdictPresentation(verdict) {
  const map = {
    NO_SUBTITLE_REQUEST_SEEN: ['Waiting for subtitle request', 'neutral', 'The player has not requested this configured SmartSubsV2 addon yet.'],
    NATIVE_MALAY_RETURNED: ['Native Malay returned', 'good', 'SmartSubsV2 returned an existing Malay subtitle without Gemini translation.'],
    NATIVE_MALAY_WITH_AUTO_FALLBACK: ['Native Malay + Auto fallback', 'warn', 'Native Malay sync evidence is weak. Malay Auto is available, but Gemini is not used unless you select it.'],
    SUBTITLE_REQUEST_FAILED: ['Subtitle request failed', 'bad', 'SmartSubsV2 received the request but the subtitle request failed.'],
    NO_ENGLISH_SOURCE_FOUND: ['No English source found', 'bad', 'OpenSubtitles returned no recognised English source for Malay Auto.'],
    BYOK_NOT_CONFIGURED: ['Gemini key not configured', 'bad', 'Malay Auto cannot run until BYOK configuration is valid.'],
    SUBTITLE_REQUEST_RETURNED_ZERO: ['No subtitle returned', 'bad', 'SmartSubsV2 was requested but returned zero subtitle tracks.'],
    TRANSLATION_DELIVERED: ['Malay subtitle delivered', 'good', 'The translated Malay VTT was successfully returned to the player.'],
    TRANSLATION_FAILED: ['Translation failed', 'bad', 'The Malay translation request failed. Check the error event below.'],
    QUEUE_JOIN_WAITING: ['Waiting for queued translation', 'warn', 'The player selected Malay Auto while the background Queue job is still running.'],
    TRANSLATION_REQUESTED_WAITING_FOR_RESULT: ['Translation requested', 'warn', 'The player requested Malay Auto and SmartSubsV2 is waiting for the result.'],
    TRANSLATION_PREPARING_IN_QUEUE: ['Translation preparing', 'warn', 'Malay Auto is translating safely in Cloudflare Queue. Retry or select Malay Auto again shortly.'],
    QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION: ['Malay Auto ready in cache', 'good', 'Background Queue translation finished before player selection.'],
    QUEUE_PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION: ['Background translation failed', 'bad', 'Queue prefetch failed. Selecting Malay Auto may still retry.'],
    QUEUE_PREFETCH_TRANSLATING: ['Background translation running', 'warn', 'Cloudflare Queue is translating Malay Auto now.'],
    QUEUE_PREFETCH_QUEUED: ['Translation queued', 'warn', 'The Malay Auto translation job is safely queued.'],
    PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION: ['Malay Auto ready', 'good', 'Background translation completed and is waiting for player selection.'],
    PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION: ['Prefetch failed', 'bad', 'Background translation failed.'],
    PREFETCH_TRANSLATING: ['Prefetch translating', 'warn', 'Malay Auto is translating in the background.'],
    SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION: ['Malay Auto offered', 'good', 'SmartSubsV2 returned a Malay Auto track to the player.'],
    SUBTITLE_RETURNED: ['Subtitle returned', 'good', 'SmartSubsV2 returned a subtitle track.']
  }
  const item = map[verdict] || [verdict, 'neutral', 'See the recent events for more detail.']
  return { title: item[0], tone: item[1], explanation: item[2] }
}

function renderConfiguredDiagnosePage(configId, events) {
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
  const latest = sorted[0] || null
  const sync = syncAssessment(lastSubtitle)
  const ranked = parseEnglishTop(lastSubtitle?.englishTop)
  const selectedId = lastSubtitle?.englishSelectedId || 'Not available'
  const sourceName = lastSubtitle?.sourceFilename || 'Not provided'
  const candidateCount = Number(lastSubtitle?.englishCandidateCount || ranked.length || 0)
  const topScore = Number(lastSubtitle?.englishSelectedScore)
  const cacheEvent = lastDelivery || lastTranslationComplete
  const cacheStatus = cacheEvent?.cache || 'Not seen yet'
  const cacheTime = cacheEvent?.totalMs
  const coldTime = lastTranslationComplete?.totalMs
  const pipelineTime = lastTranslationComplete?.pipelineMs
  const wallTime = lastTranslationComplete?.translationWallMs
  const nativeConfidence = lastSubtitle?.nativeConfidence || (Number(lastSubtitle?.malayCount || 0) > 0 ? 'UNKNOWN' : 'NONE')
  const nativeDecision = lastSubtitle?.nativeDecision || 'Not applicable'
  const nativeId = lastSubtitle?.malaySelectedId || 'Not available'
  const nativeScore = Number(lastSubtitle?.malaySelectedScore)

  const topCandidates = ranked.length
    ? ranked.map(item => {
        if (item.raw) return `<div class="candidate">${escapeHtml(item.raw)}</div>`
        const selected = String(item.id) === String(selectedId)
        return `<div class="candidate${selected ? ' selected' : ''}"><span>#${item.rank}</span><strong>${escapeHtml(item.id)}</strong><span>score ${escapeHtml(item.score)}</span>${selected ? '<em>SELECTED</em>' : ''}</div>`
      }).join('')
    : '<div class="muted">No ranked English candidates recorded.</div>'

  const metadataItems = [
    ['Filename', lastSubtitle?.sourceFilenameProvided, sourceName],
    ['Video hash', lastSubtitle?.sourceVideoHashProvided, lastSubtitle?.sourceVideoHashProvided ? 'Provided' : 'Not provided'],
    ['Video size', lastSubtitle?.sourceVideoSizeProvided, lastSubtitle?.sourceVideoSizeProvided ? 'Provided' : 'Not provided']
  ].map(([label, available, detail]) =>
    `<div class="meta-row"><span>${escapeHtml(label)}</span><strong class="${available ? 'yes' : 'no'}">${available ? 'YES' : 'NO'}</strong><small>${escapeHtml(detail)}</small></div>`
  ).join('')

  let guidance = 'Run a title and refresh this page after the subtitle list appears.'
  if (lastSubtitle) {
    if (lastSubtitle.nativeDecision === 'dual-fallback') {
      guidance = 'Native Malay sync evidence is weak. Try Native Malay first. Malay Auto is available as a fallback, and Gemini translation starts only if you select Malay Auto.'
    } else if (sync.tone === 'bad') {
      guidance = `English source sync is uncertain. Selected source ${selectedId} should be compared with a known synced OpenSubtitles track before changing Gemini settings.`
    } else if (lastFailure) {
      guidance = `A recent failure was recorded at ${escapeHtml(lastFailure.failureStage || lastFailure.event)}. Check the failure card and raw events.`
    } else if (lastDelivery?.cache === 'HIT') {
      guidance = 'Subtitle delivery is healthy and came from cache. Any timing problem is more likely source selection than translation speed.'
    } else if (status.tone === 'good') {
      guidance = 'Delivery looks healthy. If subtitles are out of sync, focus on the English source ID and sync confidence section.'
    }
  }

  const rawEvents = sorted.map(item => {
    const detail = Object.entries(item)
      .filter(([key]) => !['ts', 'event'].includes(key))
      .map(([key, value]) => `<span><b>${escapeHtml(key)}</b>=${escapeHtml(Array.isArray(value) ? value.join(',') : value)}</span>`)
      .join('')
    return `<article class="event-card"><div class="event-head"><time>${escapeHtml(formatMalaysiaTime(item.ts))}</time><code>${escapeHtml(item.event)}</code></div><div class="event-detail">${detail || '<span>No details</span>'}</div></article>`
  }).join('') || '<p class="muted">No request events recorded in the last 24 hours.</p>'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubsV2 Diagnose</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#101116;color:#f4f4f5;font-family:system-ui,-apple-system,sans-serif}.wrap{max-width:920px;margin:auto;padding:18px 12px 40px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:16px;margin-bottom:12px}h1{font-size:24px;margin:0 0 8px}h2{font-size:17px;margin:0 0 12px}.muted{color:#aeb1bb;font-size:13px}.status{display:flex;gap:10px;align-items:flex-start}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:5px 10px;font-weight:800;font-size:12px;letter-spacing:.02em}.good{background:#123b29;color:#a7f3d0}.warn{background:#493812;color:#fde68a}.bad{background:#4a1d24;color:#fecaca}.neutral{background:#30333d;color:#e5e7eb}.status-copy{flex:1}.status-title{font-size:20px;font-weight:800;margin-bottom:4px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.metric{background:#111319;border:1px solid #2b2e37;border-radius:12px;padding:12px}.metric .label{color:#aeb1bb;font-size:12px}.metric .value{font-size:18px;font-weight:800;margin-top:3px;word-break:break-word}.metric .sub{color:#aeb1bb;font-size:12px;margin-top:4px;word-break:break-word}.candidate{display:grid;grid-template-columns:34px 1fr auto auto;gap:8px;align-items:center;padding:9px 10px;border-bottom:1px solid #30333d;font-size:13px}.candidate:last-child{border-bottom:0}.candidate.selected{background:#16271e}.candidate em{font-style:normal;font-size:10px;font-weight:800;color:#a7f3d0}.meta-row{display:grid;grid-template-columns:90px 42px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid #30333d;align-items:start}.meta-row:last-child{border-bottom:0}.meta-row .yes{color:#a7f3d0}.meta-row .no{color:#fca5a5}.meta-row small{color:#c7c9d1;word-break:break-word}.guide{font-size:15px;line-height:1.5}.event-card{border-top:1px solid #30333d;padding:12px 0}.event-card:first-child{border-top:0}.event-head{display:flex;gap:10px;justify-content:space-between;align-items:center;margin-bottom:7px}.event-head time{font-size:12px;color:#aeb1bb}.event-head code{font-size:12px;color:#c9ffdc}.event-detail{display:flex;flex-wrap:wrap;gap:6px}.event-detail span{background:#111319;border-radius:7px;padding:4px 6px;font-size:11px;word-break:break-word}.event-detail b{color:#aeb1bb;font-weight:600}details summary{cursor:pointer;font-weight:800;padding:4px 0}code{color:#c9ffdc}@media(max-width:640px){.grid{grid-template-columns:1fr}.candidate{grid-template-columns:28px 1fr auto}.candidate em{grid-column:2}.meta-row{grid-template-columns:82px 38px 1fr}.event-head{align-items:flex-start;flex-direction:column;gap:4px}}
</style></head>
<body><main class="wrap">
<section class="card"><h1>SmartSubsV2 Diagnose</h1><div class="status"><span class="pill ${status.tone}">${escapeHtml(status.tone === 'good' ? 'OK' : status.tone === 'bad' ? 'PROBLEM' : status.tone === 'warn' ? 'CHECK' : 'INFO')}</span><div class="status-copy"><div class="status-title">${escapeHtml(status.title)}</div><div class="muted">${escapeHtml(status.explanation)}</div><div class="muted">Verdict code: <code>${escapeHtml(verdict)}</code></div></div></div><p class="muted">Malaysia time (MYT, Asia/Kuala_Lumpur) | Build ${BUILD_ID} | ${sorted.length} events retained for up to 24 hours.</p></section>

<section class="card"><h2>Quick diagnosis</h2><div class="grid">
<div class="metric"><div class="label">Latest media</div><div class="value">${escapeHtml(lastSubtitle ? `${lastSubtitle.type || ''} ${lastSubtitle.id || ''}`.trim() : 'No request')}</div><div class="sub">${escapeHtml(lastSubtitle ? formatMalaysiaTime(lastSubtitle.ts) : 'Waiting for player')}</div></div>
<div class="metric"><div class="label">Subtitle result</div><div class="value">${escapeHtml(lastSubtitle?.result || 'Not available')}</div><div class="sub">${escapeHtml(lastSubtitle ? `${lastSubtitle.subtitleCount || 0} returned | ${lastSubtitle.languages || 'language unknown'}` : '')}</div></div>
<div class="metric"><div class="label">Native Malay decision</div><div class="value">${escapeHtml(nativeDecision)}</div><div class="sub">source ${escapeHtml(nativeId)} | confidence ${escapeHtml(nativeConfidence)}${Number.isFinite(nativeScore) ? ` | score ${escapeHtml(nativeScore)}` : ''}</div></div>
<div class="metric"><div class="label">Selected English source</div><div class="value">${escapeHtml(selectedId)}</div><div class="sub">${Number.isFinite(topScore) ? `score ${escapeHtml(topScore)}` : 'score unavailable'} | ${candidateCount} candidates</div></div>
<div class="metric"><div class="label">Sync confidence</div><div class="value"><span class="pill ${sync.tone}">${escapeHtml(sync.level)}</span></div><div class="sub">${escapeHtml(sync.reason)}</div></div>
<div class="metric"><div class="label">Latest delivery cache</div><div class="value">${escapeHtml(cacheStatus)}</div><div class="sub">${cacheTime !== undefined ? formatDuration(cacheTime) : 'No delivery timing yet'}</div></div>
<div class="metric"><div class="label">Cold translation</div><div class="value">${coldTime !== undefined ? formatDuration(coldTime) : 'Not seen yet'}</div><div class="sub">${pipelineTime !== undefined ? `pipeline ${formatDuration(pipelineTime)}` : ''}${wallTime !== undefined ? ` | Gemini wall ${formatDuration(wallTime)}` : ''}</div></div>
</div></section>

<section class="card"><h2>What this means</h2><div class="guide">${escapeHtml(guidance)}</div></section>

<section class="card"><h2>Player sync metadata</h2>${metadataItems}</section>

<section class="card"><h2>English candidates</h2><p class="muted">SmartSubs selected <strong>${escapeHtml(selectedId)}</strong>. A very small score gap without hash or size means selection confidence is weak.</p>${topCandidates}</section>

${lastFailure ? `<section class="card"><h2>Latest failure</h2><div class="metric"><div class="label">${escapeHtml(lastFailure.event)}</div><div class="value">${escapeHtml(lastFailure.failureStage || lastFailure.status || 'Unknown stage')}</div><div class="sub">${escapeHtml(lastFailure.error || lastFailure.reason || '')}</div></div></section>` : ''}

<section class="card"><details><summary>Verdict reference</summary><p class="muted">Legacy diagnostic codes retained for compatibility and deep debugging.</p><div class="event-detail"><span><code>NO_SUBTITLE_REQUEST_SEEN</code></span><span><code>NO_ENGLISH_SOURCE_FOUND</code></span><span><code>NATIVE_MALAY_WITH_AUTO_FALLBACK</code></span><span><code>SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION</code></span><span><code>PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION</code></span><span><code>PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION</code></span><span><code>QUEUE_PREFETCH_QUEUED</code></span><span><code>QUEUE_PREFETCH_TRANSLATING</code></span><span><code>QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION</code></span><span><code>QUEUE_PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION</code></span><span><code>QUEUE_JOIN_WAITING</code></span><span><code>TRANSLATION_PREPARING_IN_QUEUE</code></span><span><code>TRANSLATION_DELIVERED</code></span><span><code>TRANSLATION_FAILED</code></span></div></details></section>

<section class="card"><details><summary>Raw recent events</summary><p class="muted">Shown in Malaysia time. Use this only when the summary above is not enough.</p>${rawEvents}</details></section>
</main></body></html>`
}
async function prefetchTranslation(options = {}) {
  const autoUrl = String(options.autoUrl || '')
  const env = options.env || {}
  const userConfig = options.userConfig || {}
  const secret = String(options.secret || '')
  const configId = String(options.configId || '')
  const getOrTranslateFn = options.getOrTranslateFn || cfGetOrTranslate
  const diagnosticFn = options.diagnosticFn || recordDiagnostic
  const startedAt = nowMs()

  if (!autoUrl || !secret || !userConfig.apiKey) return null

  let match
  try {
    match = new URL(autoUrl).pathname.match(/\/translated\/([A-Za-z0-9_.-]+)\.vtt$/)
  } catch {
    return null
  }
  if (!match) return null

  await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
    event: 'prefetch-start',
    status: 'background'
  }).catch(() => {})

  try {
    if (!env.SMARTSUBS_CACHE) throw new Error('SMARTSUBS_CACHE KV binding is not configured')
    const tokenData = decodeTranslationTokenData(match[1], secret)
    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'translation-request',
      status: 'prefetch'
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

function playerQueueWaitMaxMs(env) {
  return Math.max(2000, Math.min(10000, Number(env.PLAYER_QUEUE_WAIT_MAX_MS || 5000)))
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
  return String(value || '') === 'user-selected-fast'
    ? 'user-selected-fast'
    : ''
}

function queueTranslationProfile(env, attempts = 1, requestedProfile = '') {
  const attempt = Math.max(1, Number(attempts || 1))
  const requested = normaliseRequestedQueueProfile(requestedProfile)
  if (attempt === 1 && requested === 'user-selected-fast') return 'user-selected-fast'
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

function queueTranslationOptions(env, attempts = 1, requestedProfile = '') {
  const retryAttempt = Math.max(1, Number(attempts || 1))
  const requested = normaliseRequestedQueueProfile(requestedProfile)

  if (retryAttempt === 1 && requested === 'user-selected-fast') {
    return {
      maxItems: Math.max(140, Math.min(200, Number(env.QUEUE_USER_SELECTED_CHUNK_ITEMS || 160))),
      maxChars: Math.max(16000, Math.min(24000, Number(env.QUEUE_USER_SELECTED_CHUNK_CHARS || 20000))),
      concurrency: Math.max(1, Math.min(4, Number(env.QUEUE_USER_SELECTED_CONCURRENCY || 4)))
    }
  }
  if (queueFinalEnabled(env, attempts)) {
    return {
      maxItems: Math.max(160, Math.min(220, Number(env.QUEUE_FINAL_CHUNK_ITEMS || 180))),
      maxChars: Math.max(20000, Math.min(30000, Number(env.QUEUE_FINAL_CHUNK_CHARS || 24000))),
      concurrency: Math.max(1, Math.min(3, Number(env.QUEUE_FINAL_CONCURRENCY || 3)))
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
  const startedAt = nowFn()
  let polls = 0
  let job = options.initialJob || await readQueueJobState(env, cacheKey)

  while (queueJobActive(job)) {
    const elapsed = Math.max(0, nowFn() - startedAt)
    if (elapsed >= maxWaitMs) break

    const waitMs = Math.min(pollMs, Math.max(1, maxWaitMs - elapsed))
    await sleepFn(waitMs)
    polls++

    const cached = await cache.get(cacheKey).catch(() => null)
    if (cached) {
      return {
        vtt: cached,
        waitMs: Math.max(0, nowFn() - startedAt),
        polls,
        jobStatus: String(job?.state || 'unknown'),
        outcome: 'hit'
      }
    }

    if (polls === 1 || polls % 3 === 0) {
      job = await readQueueJobState(env, cacheKey)
      if (job && job.state === 'failed') break
    }
  }

  const finalCached = await cache.get(cacheKey).catch(() => null)
  if (finalCached) {
    return {
      vtt: finalCached,
      waitMs: Math.max(0, nowFn() - startedAt),
      polls,
      jobStatus: String(job?.state || 'unknown'),
      outcome: 'hit'
    }
  }

  return {
    vtt: null,
    waitMs: Math.max(0, nowFn() - startedAt),
    polls,
    jobStatus: String(job?.state || 'missing'),
    outcome: job && job.state === 'failed' ? 'failed' : 'timeout'
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
  const diagnosticFn = options.diagnosticFn || recordDiagnostic
  const translationToken = parseAutoTranslationToken(autoUrl)
  const cacheKey = String(options.cacheKey || '')
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
        status: job.state
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
      status: 'queue-missing'
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
  const attempts = Math.max(1, Number(options.attempts || 1))
  const diagnosticFn = options.diagnosticFn || recordDiagnostic
  const getOrTranslateFn = options.getOrTranslateFn || cfGetOrTranslate
  const startedAt = nowMs()
  const epochNowFn = typeof options.epochNowFn === 'function' ? options.epochNowFn : Date.now
  const queuedAt = Number(payload.queuedAt || 0)
  const queueDelayMs = queuedAt > 0 ? Math.max(0, roundMs(epochNowFn() - queuedAt)) : 0
  const requestedProfile = normaliseRequestedQueueProfile(payload.profile)
  const queueProfile = queueTranslationOptions(env, attempts, requestedProfile)
  const queueProfileName = queueTranslationProfile(env, attempts, requestedProfile)

  if (!secret) throw new Error('SmartSubs server secret is not configured')
  if (payload.v !== 1 || !configToken || !translationToken || !configId) {
    throw new Error('Invalid SmartSubs queue message')
  }
  if (configToken.length > 2048 || translationToken.length > 8192 || configId.length > 128) {
    throw new Error('Invalid SmartSubs queue message size')
  }

  let userConfig = null
  let cacheKey = ''
  try {
    userConfig = decodeUserConfigToken(configToken, { secret })
    const tokenData = decodeTranslationTokenData(translationToken, secret)
    const expectedCacheKey = translationCacheKey(tokenData, userConfig.model, env)
    const suppliedCacheKey = String(payload.cacheKey || '')

    if (suppliedCacheKey && suppliedCacheKey !== expectedCacheKey) {
      throw new Error('Invalid SmartSubs queue cache key')
    }
    cacheKey = expectedCacheKey

    await writeQueueJobState(env, cacheKey, {
      state: 'running',
      configId,
      attempts
    }).catch(() => {})

    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'queue-translation-start',
      status: 'consumer',
      attempts,
      profile: queueProfileName,
      queueDelayMs,
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
      translateOptions: queueProfile
    })

    await writeQueueJobState(env, cacheKey, {
      state: 'ready',
      configId,
      attempts
    }).catch(() => {})

    const totalMs = roundMs(nowMs() - startedAt)
    const repair = result.translationStats || {}

    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'queue-translation-complete',
      cache: result.status,
      status: 'ready',
      attempts,
      profile: queueProfileName,
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
      chunkItems: repair.chunkItems,
      chunkChars: repair.chunkChars,
      concurrency: repair.concurrency,
      queueDelayMs,
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
      geminiPromptChars: repair.geminiPromptChars
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
      status: 'consumer-failed',
      attempts,
      profile: queueProfileName,
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
      geminiCallMs: perf.geminiCallMs,
      geminiStatuses: perf.geminiStatuses,
      geminiPromptChars: perf.geminiPromptChars
    }).catch(() => {})
    throw error
  }
}
async function handleQueue(batch, env, options = {}) {
  const processFn = options.processFn || processQueueMessage

  for (const message of batch?.messages || []) {
    try {
      await processFn(message.body, env, {
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
          await writeQueueJobState(env, cacheKey, {
            state: 'failed',
            configId,
            attempts: message.attempts
          }).catch(() => {})
        }
        await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
          event: 'queue-retry-stopped',
          status: 'permanent',
          attempts: message.attempts,
          failureStage: queueFailureStage(error),
          reason: safeMessage(error, '')
        }).catch(() => {})
        if (typeof message.ack === 'function') message.ack()
      } else if (typeof message.retry === 'function') {
        const attempts = Math.max(1, Number(message.attempts || 1))
        if (validTranslationCacheKey(cacheKey)) {
          await writeQueueJobState(env, cacheKey, {
            state: 'retrying',
            configId,
            attempts
          }).catch(() => {})
        }
        const retryDelaySeconds = Math.min(60, attempts * 10)
        await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
          event: 'queue-retry-scheduled',
          status: 'retrying',
          attempts,
          nextAttempt: attempts + 1,
          retryDelaySeconds,
          failureStage: queueFailureStage(error),
          reason: safeMessage(error, '')
        }).catch(() => {})
        message.retry({ delaySeconds: retryDelaySeconds })
      }
    }
  }
}
function shouldPrefetchAutoResult(result, autoUrl) {
  return Boolean(autoUrl) && result?.autoPrefetch !== false
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

  if (request.method === 'GET' && suffix === '/manifest.json') {
    return json(createConfiguredManifest(), 200, { noStore: true })
  }

  if (request.method === 'GET' && suffix === '/configure') {
    return new Response(null, {
      status: 302,
      headers: { location: '/configure', 'cache-control': 'no-store' }
    })
  }

  if (request.method === 'GET' && suffix === '/diagnose') {
    const events = await readDiagnostics(env.SMARTSUBS_CACHE, configId).catch(() => [])
    return send(200, 'text/html; charset=utf-8', renderConfiguredDiagnosePage(configId, events), { noStore: true, csp: true })
  }

  const translationMatch = request.method === 'GET' && suffix.match(/^\/translated\/([A-Za-z0-9_.-]+)\.vtt$/)
  if (translationMatch) {
    const startedAt = nowMs()
    await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
      event: 'translation-request',
      status: 'player'
    }).catch(() => {})

    try {
      if (!env.SMARTSUBS_CACHE) throw new Error('SMARTSUBS_CACHE KV binding is not configured')

      const tokenData = decodeTranslationTokenData(translationMatch[1], secret)
      const cache = getCache(env)
      const cacheKey = translationCacheKey(tokenData, userConfig.model, env)
      let joinWaitMs = 0
      let joinPolls = 0
      let joinStatus = ''
      let result = null

      const cached = await cache.get(cacheKey).catch(() => null)
      if (cached) {
        result = {
          vtt: cached,
          cacheKey,
          status: 'HIT',
          translationStats: null
        }
        joinStatus = 'cache-hit'
      } else {
        const job = await readQueueJobState(env, cacheKey)
        if (queueJobActive(job)) {
          await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
            event: 'queue-join-start',
            status: job.state
          }).catch(() => {})

          const joined = await waitForQueueCache({
            env,
            cache,
            cacheKey,
            initialJob: job,
            maxWaitMs: playerQueueWaitMaxMs(env)
          })

          joinWaitMs = joined.waitMs
          joinPolls = joined.polls
          joinStatus = joined.outcome

          if (joined.vtt) {
            result = {
              vtt: joined.vtt,
              cacheKey,
              status: 'QUEUE_JOIN',
              translationStats: null
            }
            await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
              event: 'queue-join-hit',
              status: joined.jobStatus,
              waitMs: joinWaitMs,
              polls: joinPolls
            }).catch(() => {})
          } else if (joined.outcome !== 'failed') {
            await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
              event: 'translation-pending',
              status: joined.jobStatus,
              waitMs: joinWaitMs,
              polls: joinPolls,
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
          queueProfile: 'user-selected-fast'
        })

        if (queued) {
          await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
            event: 'player-translation-queued',
            status: 'queued'
          }).catch(() => {})

          const joined = await waitForQueueCache({
            env,
            cache,
            cacheKey,
            maxWaitMs: playerQueueWaitMaxMs(env)
          })

          joinWaitMs = joined.waitMs
          joinPolls = joined.polls
          joinStatus = joined.outcome === 'hit'
            ? 'player-queue-hit'
            : `player-queue-${joined.outcome}`

          if (joined.vtt) {
            result = {
              vtt: joined.vtt,
              cacheKey,
              status: 'QUEUE_JOIN',
              translationStats: null
            }
          } else if (joined.outcome !== 'failed') {
            await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
              event: 'translation-pending',
              status: joined.jobStatus || 'queued',
              waitMs: joinWaitMs,
              polls: joinPolls,
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
      await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
        event: 'translation-delivered',
        cache: result.status,
        totalMs,
        waitMs: joinWaitMs,
        polls: joinPolls,
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
      await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
        event: 'translation-failed',
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

      await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
        event: 'subtitle-request',
        type: args.type,
        id: args.id
      }).catch(() => {})
      const result = await handleSubtitles(args, {
        apiKey: userConfig.apiKey,
        model: userConfig.model,
        publicBaseUrl: configuredBase(request, token),
        tokenSecret: secret,
        onDiagnostic: event => recordDiagnostic(env.SMARTSUBS_CACHE, configId, event)
      })

      const autoUrl = result?.subtitles?.find(item =>
        item && item.lang === 'msa' && typeof item.url === 'string' && item.url.includes('/translated/')
      )?.url

      if (autoUrl && result?.autoPrefetch === false) {
        await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
          event: 'auto-prefetch-skipped',
          status: 'quota-protected',
          reason: result.autoPrefetchReason || 'user-selection-required'
        }).catch(() => {})
      }

      if (shouldPrefetchAutoResult(result, autoUrl)) {
        const translationToken = parseAutoTranslationToken(autoUrl)
        let autoCacheKey = ''

        if (translationToken) {
          try {
            const tokenData = decodeTranslationTokenData(translationToken, secret)
            autoCacheKey = translationCacheKey(tokenData, userConfig.model, env)
          } catch {}
        }

        await enqueuePrefetchTranslation({
          autoUrl,
          env,
          configToken: token,
          configId,
          cacheKey: autoCacheKey
        })
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
    try {
      return await handleRequest(request, env, executionCtx)
    } catch (error) {
      console.error(JSON.stringify({
        tag: 'SMARTSUBS_CF_FATAL',
        message: safeMessage(error, '')
      }))
      return send(500, 'text/plain; charset=utf-8', 'SmartSubs internal error', { noStore: true })
    }
  },
  async queue(batch, env) {
    await handleQueue(batch, env)
  }
}

export { BUILD_ID, handleRequest, parseSubtitleArgs, safeMessage, classifyTranslationError, renderConfiguredDiagnosePage, prefetchTranslation, parseAutoTranslationToken, enqueuePrefetchTranslation, processQueueMessage, handleQueue, normaliseRequestedQueueProfile, queueTranslationProfile, queueTranslationOptions, translationCacheKey, readQueueJobState, writeQueueJobState, queueJobActive, waitForQueueCache, queueFailureStage, queueFinalEnabled, rateLimitAllowed, rateLimitedResponse, publicReady, shouldPrefetchAutoResult, playerQueueWaitMaxMs, translationPreparingResponse }
