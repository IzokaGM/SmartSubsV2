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

function renderConfiguredDiagnosePage(configId, events) {
  const verdict = deriveVerdict(events)
  const rows = events.map(item => {
    const timestamp = Number(item.ts || 0)
    const time = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : 'unknown'
    const detail = Object.entries(item)
      .filter(([key]) => !['ts', 'event'].includes(key))
      .map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(Array.isArray(value) ? value.join(',') : value)}`)
      .join(' | ')
    return `<tr><td>${escapeHtml(time)}</td><td>${escapeHtml(item.event)}</td><td>${detail}</td></tr>`
  }).join('') || '<tr><td colspan="3">No request events recorded in the last 24 hours.</td></tr>'

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubs Diagnose</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#101116;color:#f4f4f5;font-family:system-ui,sans-serif}.wrap{max-width:980px;margin:auto;padding:24px 14px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:18px;margin-bottom:14px}.verdict{font-size:20px;font-weight:800;color:#c9ffdc;word-break:break-word}.muted{color:#aeb1bb;font-size:13px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;vertical-align:top;padding:9px;border-bottom:1px solid #30333d;word-break:break-word}th{color:#c7c9d1}.codes{display:grid;gap:5px;font-size:13px}code{color:#c9ffdc}</style></head>
<body><main class="wrap"><section class="card"><h1>SmartSubs Diagnose</h1><div class="verdict">${escapeHtml(verdict)}</div><p class="muted">Build ${BUILD_ID} | Config ${escapeHtml(configId)} | Events kept for up to 24 hours.</p></section>
<section class="card"><div class="codes"><div><code>NO_SUBTITLE_REQUEST_SEEN</code>: Nuvio has not requested this configured SmartSubs addon.</div><div><code>NO_ENGLISH_SOURCE_FOUND</code>: SmartSubs was requested but OpenSubtitles returned no recognised English source.</div><div><code>SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION</code>: SmartSubs returned an auto Malay entry but background translation has not completed yet.</div><div><code>PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION</code>: Malay Auto is already translated and cached before player selection.</div><div><code>PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION</code>: Background translation failed, but selecting Malay Auto can still retry normally.</div><div><code>QUEUE_PREFETCH_QUEUED</code>: Translation job is safely stored in Cloudflare Queue.</div><div><code>QUEUE_PREFETCH_TRANSLATING</code>: Queue consumer is translating before player selection.</div><div><code>QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION</code>: Queue translation finished and Malay VTT is cached.</div><div><code>QUEUE_PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION</code>: Queue translation failed and may retry.</div><div><code>QUEUE_JOIN_WAITING</code>: Player selected Malay Auto while Queue translation is still running, so SmartSubs is waiting for the cached result instead of starting Gemini again.</div><div><code>TRANSLATION_DELIVERED</code>: translated VTT was successfully returned.</div><div><code>TRANSLATION_FAILED</code>: the translated VTT request reached SmartSubs but translation failed.</div></div></section>
<section class="card"><h2>Recent events</h2><table><thead><tr><th>Time UTC</th><th>Event</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></section></main></body></html>`
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


function queueTranslationProfile(env, attempts = 1) {
  if (queueFinalEnabled(env, attempts)) return 'quota-safe-final'
  if (queueParallelEnabled(env, attempts)) return 'parallel-3'
  return Math.max(1, Number(attempts || 1)) > 1 ? 'fallback-stable' : 'm16-compatible'
}

function queueFailureStage(error) {
  const message = String(error?.message || error || '')

  if (/Subtitle source|No timed subtitle cues|source is too large/i.test(message)) return 'source'
  if (/Gemini HTTP|Gemini returned|AbortError|aborted|timeout/i.test(message)) return 'gemini'
  if (/translation count mismatch|structured translation|usable translated cues/i.test(message)) return 'validation'
  if (/cache|KV binding/i.test(message)) return 'cache'
  return 'unknown'
}

function queueTranslationOptions(env, attempts = 1) {
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

  const retryAttempt = Math.max(1, Number(attempts || 1))
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
      queuedAt: Date.now()
    })

    await diagnosticFn(env.SMARTSUBS_CACHE, configId, {
      event: 'queue-enqueued',
      status: 'queued'
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
  const queueProfile = queueTranslationOptions(env, attempts)
  const queueProfileName = queueTranslationProfile(env, attempts)

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
            initialJob: job
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
          } else {
            await recordDiagnostic(env.SMARTSUBS_CACHE, configId, {
              event: joined.outcome === 'failed' ? 'queue-join-fallback' : 'queue-join-timeout',
              status: joined.jobStatus,
              waitMs: joinWaitMs,
              polls: joinPolls,
              reason: joined.outcome
            }).catch(() => {})
          }
        }
      }

      if (!result) {
        if (!joinStatus) joinStatus = 'direct'

        if (!await rateLimitAllowed(env.SMARTSUBS_GENERATE_LIMITER, `generate:${configId}`)) {
          return rateLimitedResponse('translation generation')
        }

        result = await cfGetOrTranslate({
          cache,
          upstreamUrl: tokenData.url,
          sourceId: tokenData.cacheId,
          model: userConfig.model,
          apiKey: userConfig.apiKey,
          cacheVersion: cacheVersion(env)
        })
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

      if (autoUrl) {
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

export { BUILD_ID, handleRequest, parseSubtitleArgs, safeMessage, classifyTranslationError, renderConfiguredDiagnosePage, prefetchTranslation, parseAutoTranslationToken, enqueuePrefetchTranslation, processQueueMessage, handleQueue, queueTranslationOptions, translationCacheKey, readQueueJobState, writeQueueJobState, queueJobActive, waitForQueueCache, queueFailureStage, queueFinalEnabled, rateLimitAllowed, rateLimitedResponse, publicReady }
