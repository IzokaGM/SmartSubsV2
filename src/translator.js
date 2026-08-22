'use strict'

const config = require('./config')

function normaliseTimestampLine(line) {
  return String(line)
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/(\d{2}:\d{2}),(\d{3})/g, '$1.$2')
}

function parseTimedCues(source) {
  const text = String(source || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = text.split(/\n{2,}/)
  const cues = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const timeIndex = lines.findIndex(line => line.includes('-->'))
    if (timeIndex < 0) continue
    const cueText = lines.slice(timeIndex + 1).join('\n').trim()
    if (!cueText) continue
    cues.push({ time: normaliseTimestampLine(lines[timeIndex].trim()), text: cueText })
  }
  if (!cues.length) throw new Error('No timed subtitle cues found')
  return cues
}

function chunkCues(cues, maxItems = config.translationChunkItems, maxChars = config.translationChunkChars) {
  const chunks = []
  let current = []
  let chars = 0
  for (const cue of cues) {
    const size = cue.text.length
    if (current.length && (current.length >= maxItems || chars + size > maxChars)) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(cue)
    chars += size
  }
  if (current.length) chunks.push(current)
  return chunks
}

function extractGeminiText(body) {
  const parts = body?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) throw new Error('Gemini returned no content')
  const text = parts.map(part => part && part.text || '').join('')
  if (!text) throw new Error('Gemini returned empty content')
  return text
}

function isTransientStatus(status) {
  const code = Number(status || 0)
  return code === 408 || code === 429 || code >= 500
}

function retryDelayMs(attempt, baseMs, jitterFn = Math.random) {
  const base = Math.max(1, Number(baseMs || 750))
  const exponential = base * (2 ** Math.max(0, attempt))
  const jitter = Math.floor(Math.max(0, Number(jitterFn())) * Math.max(1, base / 2))
  return exponential + jitter
}

function retryAfterMs(response, nowFn = Date.now) {
  const raw = response?.headers?.get?.('retry-after')
  if (!raw) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60000, Math.round(seconds * 1000))
  }
  const timestamp = Date.parse(String(raw))
  if (!Number.isFinite(timestamp)) return 0
  return Math.max(0, Math.min(60000, timestamp - Number(nowFn())))
}

function createTranslationPlan(cues, options = {}) {
  const rows = Array.isArray(cues) ? cues : []
  const totalChars = rows.reduce((sum, cue) => sum + String(cue?.text || '').length, 0)

  const explicitItems = Number(options.maxItems)
  const explicitChars = Number(options.maxChars)
  const explicitConcurrency = Number(options.concurrency)

  const configuredItems = Math.max(1, Number(config.translationChunkItems || 180))
  const configuredChars = Math.max(1000, Number(config.translationChunkChars || 24000))
  const configuredConcurrency = Math.max(
    1,
    Math.min(3, Number(config.translationConcurrency || 2))
  )

  const maxItems = Number.isFinite(explicitItems) && explicitItems > 0
    ? explicitItems
    : configuredItems

  const maxChars = Number.isFinite(explicitChars) && explicitChars > 0
    ? explicitChars
    : configuredChars

  const concurrency = Number.isFinite(explicitConcurrency) && explicitConcurrency > 0
    ? Math.max(1, Math.min(3, explicitConcurrency))
    : configuredConcurrency

  return { maxItems, maxChars, concurrency, totalChars }
}
async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function indexedResponseSchema() {
  return {
    type: 'OBJECT',
    properties: {
      translations: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'INTEGER' },
            text: { type: 'STRING' }
          },
          required: ['id', 'text']
        }
      }
    },
    required: ['translations']
  }
}

function metricNow(options = {}) {
  const fn = typeof options.nowFn === 'function' ? options.nowFn : Date.now
  const value = Number(fn())
  return Number.isFinite(value) ? value : Date.now()
}

function metricMs(value) {
  const number = Number(value)
  return Math.max(0, Math.round(Number.isFinite(number) ? number : 0))
}

function pushMetric(metrics, key, value, maxItems = 16) {
  if (!metrics) return
  if (!Array.isArray(metrics[key])) metrics[key] = []
  if (metrics[key].length < maxItems) metrics[key].push(value)
}

async function requestGemini(prompt, options = {}) {
  const apiKey = options.apiKey || ''
  const model = options.model || config.geminiModel
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = options.timeoutMs || config.geminiTimeoutMs
  const retries = Math.max(0, Number(options.retries ?? config.geminiRetries))
  const retryBaseMs = Math.max(1, Number(options.retryBaseMs ?? config.geminiRetryBaseMs))
  const sleepFn = options.sleepFn || sleep
  const jitterFn = options.jitterFn || Math.random
  const metrics = options.requestMetrics || null

  if (!apiKey) throw new Error('Gemini BYOK key is not configured')

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const callStartedAt = metricNow(options)
    let recorded = false

    const recordCall = status => {
      if (!metrics || recorded) return
      recorded = true
      pushMetric(metrics, 'geminiCallMs', metricMs(metricNow(options) - callStartedAt))
      pushMetric(metrics, 'geminiStatuses', status)
      pushMetric(metrics, 'geminiPromptChars', String(prompt || '').length)
    }

    try {
      if (metrics) metrics.geminiCalls = Number(metrics.geminiCalls || 0) + 1

      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: options.responseSchema || indexedResponseSchema(),
              thinkingConfig: { thinkingLevel: 'minimal' }
            }
          }),
          signal: controller.signal
        }
      )

      const status = Number(response.status || (response.ok ? 200 : 0))

      if (response.ok) {
        const body = await response.json()
        recordCall(status || 200)
        return body
      }

      recordCall(status)

      if (metrics && status === 429) {
        metrics.rateLimits = Number(metrics.rateLimits || 0) + 1
      }

      if (attempt < retries && isTransientStatus(status)) {
        const waitMs = Math.max(
          retryDelayMs(attempt, retryBaseMs, jitterFn),
          retryAfterMs(response)
        )

        if (metrics) {
          metrics.transientRetries = Number(metrics.transientRetries || 0) + 1
          metrics.retryWaitMs = Number(metrics.retryWaitMs || 0) + waitMs
        }

        await sleepFn(waitMs)
        continue
      }

      throw new Error(`Gemini HTTP ${status}`)
    } catch (error) {
      recordCall(error?.name === 'AbortError' ? 'ABORT' : 'ERROR')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
function buildIndexedPrompt(items) {
  return [
    'Translate these English subtitle cues into natural, concise Malaysian Bahasa Melayu for film and television viewers.',
    'Use contemporary Malaysian vocabulary and expressions. Avoid unintended Indonesian vocabulary or sentence structures unless the dialogue specifically refers to Indonesia or an Indonesian character.',
    'Use surrounding cues as context. Keep pronouns, relationships, tone, humour, slang, recurring terminology and character voices consistent across the batch.',
    'Translate the intended meaning, emotion and level of formality instead of translating word for word. Preserve the original intensity of insults, profanity, threats and emotional dialogue without censoring or exaggerating them.',
    'Choose pronouns such as saya, awak, anda, aku, kau, kami and kita according to the relationship, setting and tone. Do not insert particles such as lah, kan or weh unless the original tone supports them.',
    'Keep translations concise and comfortable to read as subtitles. Do not unnecessarily expand short dialogue. Preserve line breaks where practical and avoid creating more lines than the source cue.',
    'Keep character names, place names, brand names, numbers, speaker markers, musical symbols, HTML tags and ASS-style formatting tags intact where appropriate. Translate meaningful sound descriptions and on-screen text when intended for the viewer.',
    'Do not add explanations, translator notes, censorship, invented context or extra dialogue.',
    'Every input object has a numeric id. Return exactly one translated object with the SAME id for every input cue.',
    'Never renumber, merge, split, duplicate or omit ids.',
    '',
    JSON.stringify(items)
  ].join('\n')
}

function parseIndexedTranslations(body, requestedItems) {
  let parsed
  try {
    parsed = JSON.parse(extractGeminiText(body))
  } catch {
    throw new Error('Gemini returned invalid structured translation')
  }

  const rows = parsed && parsed.translations
  if (!Array.isArray(rows)) throw new Error('Gemini returned invalid structured translation')

  const requestedIds = new Set(requestedItems.map(item => item.id))
  const byId = new Map()

  // Backward compatibility for old structured mocks and older Gemini responses.
  if (rows.every(value => typeof value === 'string')) {
    rows.slice(0, requestedItems.length).forEach((value, index) => {
      const text = String(value)
      if (text.trim()) byId.set(requestedItems[index].id, text)
    })
    return byId
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = Number(row.id)
    if (!Number.isInteger(id) || !requestedIds.has(id) || byId.has(id)) continue
    const text = String(row.text == null ? '' : row.text)
    if (!text.trim()) continue
    byId.set(id, text)
  }
  return byId
}

async function translateIndexedItems(items, options = {}) {
  if (!Array.isArray(items) || !items.length) {
    return {
      translations: [],
      stats: { expected: 0, received: 0, missing: 0, retryRecovered: 0, fallbackCount: 0, final: 0 }
    }
  }

  const normalised = items.map((item, index) => ({
    id: Number.isInteger(item.id) ? item.id : index,
    text: String(item.text == null ? '' : item.text)
  }))
  const maxSemanticRetries = Math.max(0, Math.min(2, Number(options.semanticRetries ?? 1)))
  const resolved = new Map()
  let firstReceived = 0
  let missingInitial = normalised.length
  let semanticRetriesUsed = 0
  let remaining = normalised

  for (let phase = 0; phase <= maxSemanticRetries && remaining.length; phase++) {
    if (phase > 0) semanticRetriesUsed++
    const body = await requestGemini(buildIndexedPrompt(remaining), options)
    const batch = parseIndexedTranslations(body, remaining)

    if (phase === 0) {
      firstReceived = batch.size
      missingInitial = normalised.length - firstReceived
    }

    for (const [id, text] of batch) resolved.set(id, text)
    remaining = normalised.filter(item => !resolved.has(item.id))
  }

  if (resolved.size === 0) {
    throw new Error(`Gemini returned no usable translated cues: expected ${normalised.length}`)
  }

  const retryRecovered = Math.max(0, resolved.size - firstReceived)
  const fallbackCount = remaining.length
  for (const item of remaining) resolved.set(item.id, item.text)

  const translations = normalised.map(item => resolved.get(item.id))
  const stats = {
    expected: normalised.length,
    received: firstReceived,
    missing: missingInitial,
    retryRecovered,
    fallbackCount,
    final: translations.length,
    semanticRetriesUsed
  }
  return { translations, stats }
}

async function translateTexts(texts, options = {}) {
  if (!Array.isArray(texts) || !texts.length) return []
  const items = texts.map((text, id) => ({ id, text: String(text) }))
  const result = await translateIndexedItems(items, options)
  if (typeof options.onTranslationStats === 'function') {
    await options.onTranslationStats(result.stats)
  }
  return result.translations
}

function aggregateTranslationStats(statsList, expected) {
  const rows = statsList.filter(Boolean)
  if (!rows.length) {
    return { expected, received: expected, missing: 0, retryRecovered: 0, fallbackCount: 0, final: expected, chunks: 0 }
  }
  return {
    expected,
    received: rows.reduce((sum, row) => sum + Number(row.received || 0), 0),
    missing: rows.reduce((sum, row) => sum + Number(row.missing || 0), 0),
    retryRecovered: rows.reduce((sum, row) => sum + Number(row.retryRecovered || 0), 0),
    fallbackCount: rows.reduce((sum, row) => sum + Number(row.fallbackCount || 0), 0),
    final: rows.reduce((sum, row) => sum + Number(row.final || 0), 0),
    semanticRetriesUsed: rows.reduce((sum, row) => sum + Number(row.semanticRetriesUsed || 0), 0),
    chunks: rows.length
  }
}

async function translateCues(cues, options = {}) {
  const plan = createTranslationPlan(cues, options)
  const chunks = chunkCues(cues, plan.maxItems, plan.maxChars)
  const concurrency = plan.concurrency
  const translateFn = options.translateTextsFn || translateTexts
  const results = new Array(chunks.length)
  const chunkStats = new Array(chunks.length)
  const chunkStartMs = new Array(chunks.length)
  const chunkMs = new Array(chunks.length)
  const translationStartedAt = metricNow(options)
  const requestMetrics = options.requestMetrics || {
    geminiCalls: 0,
    rateLimits: 0,
    transientRetries: 0,
    abortRetries: 0,
    retryWaitMs: 0,
    geminiCallMs: [],
    geminiStatuses: [],
    geminiPromptChars: []
  }

  function perfSnapshot() {
    const completed = chunkMs.filter(Number.isFinite)
    const sumChunkMs = completed.reduce((sum, value) => sum + Number(value || 0), 0)
    const maxChunkMs = completed.length ? Math.max(...completed) : 0
    const avgChunkMs = completed.length ? Math.round(sumChunkMs / completed.length) : 0

    return {
      translationWallMs: metricMs(metricNow(options) - translationStartedAt),
      chunkTimeline: chunks.map((_, index) => {
        const start = Number.isFinite(chunkStartMs[index]) ? chunkStartMs[index] : 0
        const duration = Number.isFinite(chunkMs[index]) ? chunkMs[index] : 'open'
        return `${index + 1}:${start}+${duration}`
      }),
      maxChunkMs,
      avgChunkMs,
      sumChunkMs,
      abortRetries: Number(requestMetrics.abortRetries || 0),
      geminiCallMs: Array.isArray(requestMetrics.geminiCallMs) ? requestMetrics.geminiCallMs : [],
      geminiStatuses: Array.isArray(requestMetrics.geminiStatuses) ? requestMetrics.geminiStatuses : [],
      geminiPromptChars: Array.isArray(requestMetrics.geminiPromptChars) ? requestMetrics.geminiPromptChars : []
    }
  }

  let nextIndex = 0

  async function worker() {
    while (true) {
      const index = nextIndex++
      if (index >= chunks.length) return

      const startedAt = metricNow(options)
      chunkStartMs[index] = metricMs(startedAt - translationStartedAt)

      const childOptions = {
        ...options,
        requestMetrics,
        onTranslationStats: stats => {
          chunkStats[index] = stats
        }
      }

      let abortRetriesForChunk = 0
      try {
        while (true) {
          try {
            results[index] = await translateFn(
              chunks[index].map(cue => cue.text),
              childOptions
            )
            break
          } catch (error) {
            const aborted = (
              error?.name === 'AbortError' ||
              /aborted|aborterror|timeout/i.test(String(error?.message || error || ''))
            )

            if (!aborted || abortRetriesForChunk >= 1) throw error

            abortRetriesForChunk++
            const waitMs = Math.max(0, Math.min(1000, Number(options.abortRetryDelayMs ?? 100)))

            requestMetrics.abortRetries = Number(requestMetrics.abortRetries || 0) + 1
            requestMetrics.transientRetries = Number(requestMetrics.transientRetries || 0) + 1
            requestMetrics.retryWaitMs = Number(requestMetrics.retryWaitMs || 0) + waitMs

            if (waitMs > 0) {
              const retrySleepFn = options.sleepFn || sleep
              await retrySleepFn(waitMs)
            }
          }
        }
      } finally {
        chunkMs[index] = metricMs(metricNow(options) - startedAt)
      }
    }
  }

  const workerCount = Math.min(concurrency, Math.max(1, chunks.length))

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } catch (error) {
    try {
      error.smartsubsPerf = {
        ...(error.smartsubsPerf || {}),
        ...perfSnapshot()
      }
    } catch {}
    throw error
  }

  const translated = results.flat()

  if (translated.length !== cues.length) {
    const error = new Error(
      `Gemini translation count mismatch after chunk merge: expected ${cues.length}, got ${translated.length}`
    )
    error.smartsubsPerf = perfSnapshot()
    throw error
  }

  if (typeof options.onTranslationStats === 'function') {
    const aggregate = aggregateTranslationStats(chunkStats, cues.length)

    await options.onTranslationStats({
      ...aggregate,
      chunks: chunks.length,
      geminiCalls: Number(requestMetrics.geminiCalls || 0),
      rateLimits: Number(requestMetrics.rateLimits || 0),
      transientRetries: Number(requestMetrics.transientRetries || 0),
      abortRetries: Number(requestMetrics.abortRetries || 0),
      retryWaitMs: Number(requestMetrics.retryWaitMs || 0),
      chunkItems: plan.maxItems,
      chunkChars: plan.maxChars,
      concurrency,
      ...perfSnapshot()
    })
  }

  return cues.map((cue, index) => ({
    ...cue,
    text: translated[index]
  }))
}
function cuesToVtt(cues) {
  return `WEBVTT\n\n${cues.map(cue => `${cue.time}\n${cue.text}`).join('\n\n')}\n`
}

async function fetchSubtitleText(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = options.timeoutMs || config.subtitleTimeoutMs
  const maxBytes = options.maxBytes || config.maxSubtitleBytes
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'text/vtt,text/plain,application/x-subrip,*/*;q=0.5',
        'user-agent': 'SmartSubs/1.0.0'
      },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`Subtitle source HTTP ${response.status}`)
    const contentLength = Number(response.headers?.get?.('content-length') || 0)
    if (contentLength && contentLength > maxBytes) throw new Error('Subtitle source is too large')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error('Subtitle source is too large')
    return buffer.toString('utf8')
  } finally {
    clearTimeout(timeout)
  }
}

async function translateSubtitleUrl(url, options = {}) {
  const pipelineStartedAt = metricNow(options)
  const fetchStartedAt = metricNow(options)
  const source = await fetchSubtitleText(url, options)
  const sourceFetchMs = metricMs(metricNow(options) - fetchStartedAt)

  const parseStartedAt = metricNow(options)
  const cues = parseTimedCues(source)
  const parseMs = metricMs(metricNow(options) - parseStartedAt)
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  const originalOnStats = options.onTranslationStats
  let translationStats = null

  try {
    const translated = await translateCues(cues, {
      ...options,
      onTranslationStats: stats => {
        translationStats = stats
      }
    })

    const merged = {
      ...(translationStats || {}),
      sourceFetchMs,
      parseMs,
      sourceBytes,
      cueCount: cues.length,
      pipelineMs: metricMs(metricNow(options) - pipelineStartedAt)
    }

    if (typeof originalOnStats === 'function') {
      await originalOnStats(merged)
    }

    return cuesToVtt(translated)
  } catch (error) {
    try {
      error.smartsubsPerf = {
        ...(error.smartsubsPerf || {}),
        sourceFetchMs,
        parseMs,
        sourceBytes,
        cueCount: cues.length,
        pipelineMs: metricMs(metricNow(options) - pipelineStartedAt)
      }
    } catch {}
    throw error
  }
}
module.exports = {
  normaliseTimestampLine,
  parseTimedCues,
  chunkCues,
  extractGeminiText,
  isTransientStatus,
  retryDelayMs,
  retryAfterMs,
  createTranslationPlan,
  requestGemini,
  buildIndexedPrompt,
  parseIndexedTranslations,
  translateIndexedItems,
  translateTexts,
  aggregateTranslationStats,
  translateCues,
  cuesToVtt,
  fetchSubtitleText,
  translateSubtitleUrl
}
