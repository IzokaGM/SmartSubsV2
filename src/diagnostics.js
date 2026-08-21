'use strict'

const PREFIX = 'diag:v1:'
const TTL_SECONDS = 24 * 60 * 60
const MAX_EVENTS = 50

function safeText(value, max = 160) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
}

function sanitiseEvent(event = {}) {
  const output = {
    ts: Number(event.ts || Date.now()),
    event: safeText(event.event, 48)
  }
  const allowed = [
    'type', 'id', 'result', 'error', 'cache', 'status',
    'upstreamCount', 'malayCount', 'subtitleCount',
    'englishFound', 'byokConfigured', 'autoReady', 'languages', 'totalMs',
    'expected', 'received', 'missing', 'retryRecovered', 'fallbackCount', 'final',
    'semanticRetriesUsed', 'chunks', 'geminiCalls', 'rateLimits', 'transientRetries',
    'retryWaitMs', 'chunkItems', 'chunkChars', 'concurrency', 'attempts', 'waitMs', 'polls', 'joinStatus', 'reason', 'profile',
    'queueDelayMs', 'sourceFetchMs', 'parseMs', 'sourceBytes', 'cueCount', 'pipelineMs',
    'translationWallMs', 'chunkTimeline', 'maxChunkMs', 'avgChunkMs', 'sumChunkMs',
    'geminiCallMs', 'geminiStatuses', 'geminiPromptChars', 'failureStage',
    'retryDelaySeconds', 'nextAttempt', 'abortRetries'
  ]
  for (const key of allowed) {
    const value = event[key]
    if (value === undefined) continue
    if (typeof value === 'boolean' || typeof value === 'number') output[key] = value
    else if (Array.isArray(value)) output[key] = value.slice(0, 8).map(item => safeText(item, 32))
    else output[key] = safeText(value)
  }
  return output
}

function keyPrefix(configId) {
  return `${PREFIX}${safeText(configId, 64)}:`
}

async function recordDiagnostic(kv, configId, event = {}) {
  if (!kv || typeof kv.put !== 'function' || !configId) return false
  const clean = sanitiseEvent(event)
  const stamp = String(clean.ts).padStart(13, '0')
  const nonce = Math.random().toString(36).slice(2, 9)
  const key = `${keyPrefix(configId)}${stamp}:${nonce}`
  await kv.put(key, JSON.stringify(clean), { expirationTtl: TTL_SECONDS })
  return true
}

async function readDiagnostics(kv, configId, limit = MAX_EVENTS) {
  if (!kv || typeof kv.list !== 'function' || typeof kv.get !== 'function' || !configId) return []
  const wanted = Math.max(1, Math.min(MAX_EVENTS, Number(limit) || MAX_EVENTS))
  const listing = await kv.list({ prefix: keyPrefix(configId), limit: 1000 })
  const keys = (Array.isArray(listing && listing.keys) ? listing.keys : [])
    .sort((a, b) => String(b.name).localeCompare(String(a.name)))
    .slice(0, wanted)
  const rows = await Promise.all(keys.map(async item => {
    try {
      const raw = await kv.get(item.name)
      if (!raw) return null
      return JSON.parse(raw)
    } catch {
      return null
    }
  }))
  return rows.filter(Boolean).sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
}

function deriveVerdict(events = []) {
  const rows = [...events].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
  const lastSubtitle = rows.find(item => item.event === 'subtitle-result')
  const lastTranslationFailed = rows.find(item => item.event === 'translation-failed')
  const lastTranslationDelivered = rows.find(item => item.event === 'translation-delivered')
  const lastTranslationRequest = rows.find(
    item => item.event === 'translation-request' && item.status !== 'prefetch'
  )
  const lastPrefetchTranslationRequest = rows.find(
    item => item.event === 'translation-request' && item.status === 'prefetch'
  )
  const lastPrefetchComplete = rows.find(item => item.event === 'prefetch-complete')
  const lastPrefetchFailed = rows.find(item => item.event === 'prefetch-failed')
  const lastQueueComplete = rows.find(item => item.event === 'queue-translation-complete')
  const lastQueueFailed = rows.find(item => item.event === 'queue-translation-failed')
  const lastQueueStart = rows.find(item => item.event === 'queue-translation-start')
  const lastQueueEnqueued = rows.find(item => item.event === 'queue-enqueued')
  const lastQueueJoinStart = rows.find(item => item.event === 'queue-join-start')

  if (!lastSubtitle) return 'NO_SUBTITLE_REQUEST_SEEN'
  if (lastSubtitle.result === 'native-malay') return 'NATIVE_MALAY_RETURNED'
  if (lastSubtitle.result === 'error') return 'SUBTITLE_REQUEST_FAILED'
  if (Number(lastSubtitle.subtitleCount || 0) === 0) {
    if (lastSubtitle.englishFound === false) return 'NO_ENGLISH_SOURCE_FOUND'
    if (lastSubtitle.byokConfigured === false) return 'BYOK_NOT_CONFIGURED'
    return 'SUBTITLE_REQUEST_RETURNED_ZERO'
  }
  if (lastTranslationDelivered && Number(lastTranslationDelivered.ts) >= Number(lastSubtitle.ts)) return 'TRANSLATION_DELIVERED'
  if (lastTranslationFailed && Number(lastTranslationFailed.ts) >= Number(lastSubtitle.ts)) return 'TRANSLATION_FAILED'
  if (lastQueueJoinStart && Number(lastQueueJoinStart.ts) >= Number(lastSubtitle.ts)) return 'QUEUE_JOIN_WAITING'
  if (lastTranslationRequest && Number(lastTranslationRequest.ts) >= Number(lastSubtitle.ts)) return 'TRANSLATION_REQUESTED_WAITING_FOR_RESULT'
  if (lastQueueComplete && Number(lastQueueComplete.ts) >= Number(lastSubtitle.ts)) return 'QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION'
  if (lastQueueFailed && Number(lastQueueFailed.ts) >= Number(lastSubtitle.ts)) return 'QUEUE_PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION'
  if (lastQueueStart && Number(lastQueueStart.ts) >= Number(lastSubtitle.ts)) return 'QUEUE_PREFETCH_TRANSLATING'
  if (lastQueueEnqueued && Number(lastQueueEnqueued.ts) >= Number(lastSubtitle.ts)) return 'QUEUE_PREFETCH_QUEUED'
  if (lastPrefetchComplete && Number(lastPrefetchComplete.ts) >= Number(lastSubtitle.ts)) return 'PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION'
  if (lastPrefetchFailed && Number(lastPrefetchFailed.ts) >= Number(lastSubtitle.ts)) return 'PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION'
  if (lastPrefetchTranslationRequest && Number(lastPrefetchTranslationRequest.ts) >= Number(lastSubtitle.ts)) return 'PREFETCH_TRANSLATING'
  if (lastSubtitle.autoReady) return 'SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION'
  return 'SUBTITLE_RETURNED'
}

module.exports = {
  TTL_SECONDS,
  MAX_EVENTS,
  sanitiseEvent,
  recordDiagnostic,
  readDiagnostics,
  deriveVerdict
}
