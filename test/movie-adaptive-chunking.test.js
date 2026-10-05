'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createTranslationPlan, chunkCues } = require('../src/translator')

function cues(count, chars = 12) {
  return Array.from({ length: count }, (_, index) => ({
    time: `00:00:${String(index % 60).padStart(2, '0')}.000 --> 00:00:${String((index + 1) % 60).padStart(2, '0')}.000`,
    text: 'x'.repeat(chars)
  }))
}

function movieOptions(extra = {}) {
  return {
    maxItems: 160,
    maxChars: 20000,
    concurrency: 5,
    mediaType: 'movie',
    movieAdaptiveChunking: true,
    movieTargetChunks: 10,
    movieChunkItemsMin: 160,
    movieChunkItemsMax: 200,
    ...extra
  }
}

test('movie adaptive chunking targets about 10 chunks within the 160-200 item guardrail', () => {
  assert.equal(createTranslationPlan(cues(1500), movieOptions()).maxItems, 160)
  assert.equal(createTranslationPlan(cues(1755), movieOptions()).maxItems, 176)
  assert.equal(createTranslationPlan(cues(1992), movieOptions()).maxItems, 200)
  assert.equal(createTranslationPlan(cues(2367), movieOptions()).maxItems, 200)
})

test('1755-cue movie becomes 10 chunks at Con5 instead of 11 chunks', () => {
  const rows = cues(1755)
  const plan = createTranslationPlan(rows, movieOptions())
  const chunks = chunkCues(rows, plan.maxItems, plan.maxChars)
  assert.equal(plan.maxItems, 176)
  assert.equal(plan.concurrency, 5)
  assert.equal(plan.maxChars, 20000)
  assert.equal(chunks.length, 10)
})

test('series keeps the existing explicit 160 item profile', () => {
  const plan = createTranslationPlan(cues(1755), {
    ...movieOptions(),
    mediaType: 'series'
  })
  assert.equal(plan.maxItems, 160)
  assert.equal(chunkCues(cues(1755), plan.maxItems, plan.maxChars).length, 11)
})

test('safe fallback can disable movie adaptive chunking and keep its 180 item profile', () => {
  const plan = createTranslationPlan(cues(1755), movieOptions({
    maxItems: 180,
    concurrency: 2,
    movieAdaptiveChunking: false
  }))
  assert.equal(plan.maxItems, 180)
  assert.equal(plan.concurrency, 2)
})

test('queue consumer enables adaptive chunking for movie normal path and passes configured target', async () => {
  const { processQueueMessage } = await import('../src/cloudflare-worker.mjs')
  const { createTranslationToken } = require('../src/token')
  const { createUserConfigToken } = require('../src/user-config')
  const secret = 'movie-adaptive-secret'
  const configToken = createUserConfigToken('A'.repeat(32), { secret, model: 'gemini-test' })
  const translationToken = createTranslationToken(
    'https://example.test/movie.srt', secret, 'movie-source', { type: 'movie', id: '123' }
  )
  let seen = null

  await processQueueMessage({
    v: 1,
    configToken,
    translationToken,
    configId: 'movie-adaptive',
    profile: 'user-selected-stable'
  }, {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: {},
    QUEUE_USER_SELECTED_CHUNK_ITEMS: '160',
    QUEUE_USER_SELECTED_CHUNK_CHARS: '20000',
    QUEUE_USER_SELECTED_CONCURRENCY: '5',
    QUEUE_FALLBACK_CHUNK_ITEMS: '180',
    QUEUE_FALLBACK_CHUNK_CHARS: '24000',
    QUEUE_FALLBACK_CONCURRENCY: '2',
    QUEUE_MOVIE_TARGET_CHUNKS: '10',
    QUEUE_MOVIE_CHUNK_ITEMS_MIN: '160',
    QUEUE_MOVIE_CHUNK_ITEMS_MAX: '200'
  }, {
    attempts: 1,
    diagnosticFn: async () => true,
    getOrTranslateFn: async options => {
      seen = options.translateContext
      return { vtt: 'WEBVTT\n', status: 'MISS', translationStats: {} }
    }
  })

  assert.equal(seen.mediaType, 'movie')
  assert.equal(seen.movieAdaptiveChunking, true)
  assert.equal(seen.movieTargetChunks, 10)
  assert.equal(seen.movieChunkItemsMin, 160)
  assert.equal(seen.movieChunkItemsMax, 200)
})

test('queue consumer keeps safe fallback non-adaptive', async () => {
  const { processQueueMessage } = await import('../src/cloudflare-worker.mjs')
  const { createTranslationToken } = require('../src/token')
  const { createUserConfigToken } = require('../src/user-config')
  const secret = 'movie-fallback-secret'
  const configToken = createUserConfigToken('B'.repeat(32), { secret, model: 'gemini-test' })
  const translationToken = createTranslationToken(
    'https://example.test/movie.srt', secret, 'movie-fallback-source', { type: 'movie', id: '456' }
  )
  let seen = null

  await processQueueMessage({
    v: 1,
    configToken,
    translationToken,
    configId: 'movie-fallback',
    profile: 'user-selected-stable'
  }, {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: {},
    QUEUE_FALLBACK_CHUNK_ITEMS: '180',
    QUEUE_FALLBACK_CHUNK_CHARS: '24000',
    QUEUE_FALLBACK_CONCURRENCY: '2'
  }, {
    attempts: 2,
    diagnosticFn: async () => true,
    getOrTranslateFn: async options => {
      seen = options.translateContext
      return { vtt: 'WEBVTT\n', status: 'MISS', translationStats: {} }
    }
  })

  assert.equal(seen.mediaType, 'movie')
  assert.equal(seen.movieAdaptiveChunking, false)
})
