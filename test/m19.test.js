'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const {
  requestGemini,
  translateCues,
  translateSubtitleUrl
} = require('../src/translator')

function cue(i) {
  return {
    time: `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:59.000`,
    text: `line-${i}`
  }
}

test('M19 records Gemini latency, status and prompt size', async () => {
  let now = 1000
  const metrics = {
    geminiCalls: 0,
    rateLimits: 0,
    transientRetries: 0,
    retryWaitMs: 0
  }

  await requestGemini('hello world', {
    apiKey: 'fake',
    model: 'gemini-test',
    nowFn: () => now,
    fetchImpl: async () => {
      now += 137
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"translations":[]}' }] } }] })
      }
    },
    requestMetrics: metrics
  })

  assert.deepEqual(metrics.geminiCallMs, [137])
  assert.deepEqual(metrics.geminiStatuses, [200])
  assert.deepEqual(metrics.geminiPromptChars, [11])
})

test('M19 parallel chunk timeline exposes duration and wall time', async () => {
  const cues = Array.from({ length: 650 }, (_, i) => cue(i))
  let stats

  const output = await translateCues(cues, {
    maxItems: 160,
    maxChars: 20000,
    concurrency: 3,
    translateTextsFn: async (texts, options) => {
      await new Promise(resolve => setTimeout(resolve, 4))
      await options.onTranslationStats({
        expected: texts.length,
        received: texts.length,
        missing: 0,
        retryRecovered: 0,
        fallbackCount: 0,
        final: texts.length,
        semanticRetriesUsed: 0
      })
      return texts.map(text => `BM:${text}`)
    },
    onTranslationStats: value => {
      stats = value
    }
  })

  assert.equal(output.length, 650)
  assert.equal(stats.chunks, 5)
  assert.equal(stats.chunkTimeline.length, 5)
  assert.match(stats.chunkTimeline[0], /^1:\d+\+\d+$/)
  assert.ok(stats.translationWallMs >= 0)
  assert.ok(stats.maxChunkMs >= 0)
  assert.ok(stats.avgChunkMs >= 0)
  assert.ok(stats.sumChunkMs >= stats.maxChunkMs)
})

test('M19 source fetch and parse timing merge into translation stats', async () => {
  const source = [
    '1',
    '00:00:01,000 --> 00:00:02,000',
    'Hello',
    '',
    '2',
    '00:00:03,000 --> 00:00:04,000',
    'World',
    ''
  ].join('\n')

  let stats

  const vtt = await translateSubtitleUrl('https://example.test/sub.srt', {
    apiKey: 'fake',
    model: 'gemini-test',
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from(source)
    }),
    translateTextsFn: async (texts, options) => {
      await options.onTranslationStats({
        expected: texts.length,
        received: texts.length,
        missing: 0,
        retryRecovered: 0,
        fallbackCount: 0,
        final: texts.length,
        semanticRetriesUsed: 0
      })
      return texts.map(text => `BM:${text}`)
    },
    onTranslationStats: value => {
      stats = value
    }
  })

  assert.match(vtt, /^WEBVTT/)
  assert.equal(stats.cueCount, 2)
  assert.equal(stats.sourceBytes, Buffer.byteLength(source, 'utf8'))
  assert.ok(stats.sourceFetchMs >= 0)
  assert.ok(stats.parseMs >= 0)
  assert.ok(stats.pipelineMs >= stats.sourceFetchMs)
})

test('M19 Queue completion includes queue delay and detailed metrics', async () => {
  const { processQueueMessage } = await import('../src/cloudflare-worker.mjs')
  const { createTranslationToken } = require('../src/token')
  const { createUserConfigToken } = require('../src/user-config')

  const secret = 'm19-secret'
  const events = []
  const configToken = createUserConfigToken('A'.repeat(32), {
    secret,
    model: 'gemini-test'
  })
  const translationToken = createTranslationToken(
    'https://example.test/source.srt',
    secret,
    'source-m19'
  )

  await processQueueMessage({
    v: 1,
    configToken,
    translationToken,
    configId: 'm19-config',
    queuedAt: 1000
  }, {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: {},
    SMARTSUBS_CACHE_VERSION: 'm19-test',
    QUEUE_PARALLEL_CHUNK_ITEMS: '160',
    QUEUE_PARALLEL_CHUNK_CHARS: '20000',
    QUEUE_PARALLEL_CONCURRENCY: '3'
  }, {
    attempts: 1,
    epochNowFn: () => 3500,
    diagnosticFn: async (_kv, _id, event) => {
      events.push(event)
      return true
    },
    getOrTranslateFn: async () => ({
      vtt: 'WEBVTT\n',
      cacheKey: 'a'.repeat(64),
      status: 'MISS',
      translationStats: {
        expected: 886,
        received: 886,
        missing: 0,
        retryRecovered: 0,
        fallbackCount: 0,
        final: 886,
        semanticRetriesUsed: 0,
        chunks: 6,
        geminiCalls: 6,
        rateLimits: 0,
        transientRetries: 0,
        retryWaitMs: 0,
        chunkItems: 160,
        chunkChars: 20000,
        concurrency: 3,
        sourceFetchMs: 312,
        parseMs: 4,
        sourceBytes: 64000,
        cueCount: 886,
        pipelineMs: 24000,
        translationWallMs: 23200,
        chunkTimeline: ['1:0+9100', '2:0+10200', '3:0+9800', '4:9100+9000', '5:9800+8700', '6:10200+8400'],
        maxChunkMs: 10200,
        avgChunkMs: 9200,
        sumChunkMs: 55200,
        geminiCallMs: [9000, 10100, 9700, 8900, 8600, 8300],
        geminiStatuses: [200, 200, 200, 200, 200, 200],
        geminiPromptChars: [12000, 11800, 12100, 11900, 11700, 9300]
      }
    })
  })

  const started = events.find(event => event.event === 'queue-translation-start')
  const completed = events.find(event => event.event === 'queue-translation-complete')

  assert.equal(started.queueDelayMs, 2500)
  assert.equal(completed.queueDelayMs, 2500)
  assert.equal(completed.translationWallMs, 23200)
  assert.equal(completed.maxChunkMs, 10200)
  assert.equal(completed.chunkTimeline.length, 6)
  assert.equal(completed.geminiCallMs.length, 6)
})

test('M19 Queue retry records why next attempt was scheduled', async () => {
  const { handleQueue } = await import('../src/cloudflare-worker.mjs')

  const recorded = []
  const kv = {
    async put(key, value) {
      if (String(key).startsWith('diag:v1:')) {
        recorded.push(JSON.parse(String(value)))
      }
    }
  }
  const retries = []

  await handleQueue({
    messages: [{
      body: {
        configId: 'retry-config',
        cacheKey: '',
        v: 1
      },
      attempts: 2,
      retry(options) {
        retries.push(options)
      }
    }]
  }, {
    SMARTSUBS_CACHE: kv
  }, {
    processFn: async () => {
      throw new Error('Gemini HTTP 503')
    }
  })

  assert.deepEqual(retries, [{ delaySeconds: 20 }])

  const event = recorded.find(item => item.event === 'queue-retry-scheduled')
  assert.ok(event)
  assert.equal(event.attempts, 2)
  assert.equal(event.nextAttempt, 3)
  assert.equal(event.retryDelaySeconds, 20)
  assert.equal(event.failureStage, 'gemini')
})

test('M19 keeps M17 speed settings unchanged', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.vars.QUEUE_PARALLEL_CHUNK_ITEMS, '160')
  assert.equal(config.vars.QUEUE_PARALLEL_CHUNK_CHARS, '20000')
  assert.equal(config.vars.QUEUE_PARALLEL_CONCURRENCY, '3')
  assert.equal(config.vars.QUEUE_FALLBACK_CHUNK_ITEMS, '180')
  assert.equal(config.vars.QUEUE_FALLBACK_CHUNK_CHARS, '24000')
  assert.equal(config.vars.QUEUE_FALLBACK_CONCURRENCY, '2')
  assert.equal(config.queues.consumers[0].max_concurrency, 1)
})
