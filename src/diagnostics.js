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
    'type', 'id', 'result', 'error', 'cache', 'status', 'sourceId',
    'upstreamCount', 'malayCount', 'subtitleCount',
    'malayCandidateCount', 'malaySelectedId', 'malaySelectedScore', 'malayTop',
    'nativeConfidence', 'nativeConfidenceReason', 'nativeScoreUplift', 'nativeDecision',
    'autoFallbackOffered', 'autoPrefetch', 'autoPrefetchReason', 'geminiPrefetchAvoided',
    'englishFound', 'englishTrackCount', 'aiCandidateCount', 'byokConfigured', 'autoReady', 'languages', 'totalMs',
    'englishConfidence', 'englishConfidenceReason', 'englishScoreUplift',
    'sourceFilenameProvided', 'sourceVideoHashProvided', 'sourceVideoSizeProvided',
    'sourceFilename', 'requestExtraKeys', 'englishCandidateCount', 'englishSelectedId',
    'englishSelectedScore', 'englishSelectionStable', 'englishTop', 'englishSourceIds',
    'expected', 'received', 'missing', 'retryRecovered', 'fallbackCount', 'final',
    'semanticRetriesUsed', 'chunks', 'geminiCalls', 'rateLimits', 'transientRetries',
    'retryWaitMs', 'chunkItems', 'chunkChars', 'concurrency', 'attempts', 'waitMs', 'polls', 'joinStatus', 'reason', 'profile', 'retryMode', 'retryPolicy', 'delivery',
    'queueDelayMs', 'sourceFetchMs', 'parseMs', 'sourceBytes', 'cueCount', 'pipelineMs',
    'translationWallMs', 'chunkTimeline', 'maxChunkMs', 'avgChunkMs', 'sumChunkMs',
    'geminiCallMs', 'geminiStatuses', 'geminiPromptChars',
    'geminiFinishReasons', 'geminiInputTokens', 'geminiOutputTokens', 'geminiTotalTokens',
    'geminiInputTokensTotal', 'geminiOutputTokensTotal', 'geminiTotalTokensTotal',
    'sdhRemoved', 'failureStage',
    'retryDelaySeconds', 'nextAttempt', 'abortRetries',
    'hedgeStarts', 'hedgeReplicaWins', 'hedgeCancels',
    'mediaType', 'movieAdaptiveChunking', 'movieTargetChunks',
    'movieChunkItemsMin', 'movieChunkItemsMax'
  ]
  const fullGeminiArrays = new Set([
    'geminiCallMs', 'geminiStatuses', 'geminiPromptChars',
    'geminiFinishReasons', 'geminiInputTokens', 'geminiOutputTokens', 'geminiTotalTokens'
  ])
  for (const key of allowed) {
    const value = event[key]
    if (value === undefined) continue
    if (typeof value === 'boolean' || typeof value === 'number') output[key] = value
    else if (Array.isArray(value)) {
      const items = fullGeminiArrays.has(key) ? value : value.slice(0, 8)
      output[key] = items.map(item => safeText(item, 32))
    } else output[key] = safeText(value)
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

  if (!lastSubtitle) return 'NO_SUBTITLE_REQUEST_SEEN'
  if (lastSubtitle.result === 'native-malay') return 'NATIVE_MALAY_RETURNED'
  if (lastSubtitle.result === 'error') return 'SUBTITLE_REQUEST_FAILED'
  if (Number(lastSubtitle.subtitleCount || 0) === 0) {
    if (lastSubtitle.englishFound === false) return 'NO_ENGLISH_SOURCE_FOUND'
    if (lastSubtitle.byokConfigured === false) return 'BYOK_NOT_CONFIGURED'
    return 'SUBTITLE_REQUEST_RETURNED_ZERO'
  }

  const subtitleTs = Number(lastSubtitle.ts || 0)
  const lastTranslationRequest = rows.find(item =>
    item.event === 'translation-request' && item.status !== 'prefetch' && Number(item.ts || 0) >= subtitleTs
  ) || null
  const selectedSourceId = String(lastTranslationRequest?.sourceId || '')
  const selectionTs = Number(lastTranslationRequest?.ts || subtitleTs)
  const currentSelectionEvent = eventName => rows.find(item =>
    item.event === eventName &&
    Number(item.ts || 0) >= selectionTs &&
    (!selectedSourceId || String(item.sourceId || '') === selectedSourceId)
  ) || null

  // Once the player selects another AI candidate in the same episode, that
  // selection becomes the status boundary. Older delivery/queue events from a
  // previously selected source must not keep the hero stuck on the old track.
  if (lastTranslationRequest) {
    if (currentSelectionEvent('translation-delivered')) return 'TRANSLATION_DELIVERED'
    if (currentSelectionEvent('translation-failed')) return 'TRANSLATION_FAILED'
    if (currentSelectionEvent('translation-pending')) return 'TRANSLATION_PREPARING_IN_QUEUE'
    if (currentSelectionEvent('player-translation-queued')) return 'TRANSLATION_PREPARING_IN_QUEUE'
    if (currentSelectionEvent('queue-join-start')) return 'QUEUE_JOIN_WAITING'
    return 'TRANSLATION_REQUESTED_WAITING_FOR_RESULT'
  }

  const afterSubtitle = eventName => rows.find(item =>
    item.event === eventName && Number(item.ts || 0) >= subtitleTs
  ) || null
  const lastPrefetchTranslationRequest = rows.find(item =>
    item.event === 'translation-request' && item.status === 'prefetch' && Number(item.ts || 0) >= subtitleTs
  ) || null

  if (afterSubtitle('translation-delivered')) return 'TRANSLATION_DELIVERED'
  if (afterSubtitle('translation-failed')) return 'TRANSLATION_FAILED'
  if (afterSubtitle('queue-translation-complete')) return 'QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION'
  if (afterSubtitle('queue-translation-failed')) return 'QUEUE_PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION'
  if (afterSubtitle('queue-translation-start')) return 'QUEUE_PREFETCH_TRANSLATING'
  if (afterSubtitle('queue-enqueued')) return 'QUEUE_PREFETCH_QUEUED'
  if (afterSubtitle('prefetch-complete')) return 'PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION'
  if (afterSubtitle('prefetch-failed')) return 'PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION'
  if (lastPrefetchTranslationRequest) return 'PREFETCH_TRANSLATING'
  if (lastSubtitle.result === 'native-malay-with-auto-fallback') return 'NATIVE_MALAY_WITH_AUTO_FALLBACK'
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
