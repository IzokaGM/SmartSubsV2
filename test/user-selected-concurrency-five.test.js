'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { translateCues } = require('../src/translator')

test('deployed user-selected first attempt uses concurrency five while fallback stays two', async () => {
  const {
    queueTranslationOptions,
    queueTranslationProfile
  } = await import('../src/cloudflare-worker.mjs')
  const env = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8')).vars

  assert.equal(env.QUEUE_USER_SELECTED_CONCURRENCY, '5')
  assert.equal(queueTranslationProfile(env, 1, 'user-selected-stable'), 'user-selected-stable')
  assert.deepEqual(
    queueTranslationOptions(env, 1, 'user-selected-stable'),
    { maxItems: 160, maxChars: 20000, concurrency: 5 }
  )

  assert.equal(queueTranslationProfile(env, 2, 'user-selected-stable'), 'fallback-stable')
  assert.deepEqual(
    queueTranslationOptions(env, 2, 'user-selected-stable'),
    { maxItems: 180, maxChars: 24000, concurrency: 2 }
  )
})

test('fast transient retry keeps user-selected concurrency five', async () => {
  const { queueTranslationOptions, queueTranslationProfile } = await import('../src/cloudflare-worker.mjs')
  const env = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8')).vars

  assert.equal(
    queueTranslationProfile(env, 2, 'user-selected-stable', 'fast-transient'),
    'fast-transient-retry'
  )
  assert.deepEqual(
    queueTranslationOptions(env, 2, 'user-selected-stable', 'fast-transient'),
    { maxItems: 160, maxChars: 20000, concurrency: 5 }
  )
})

test('user-selected translation can actually run five Gemini chunks concurrently', async () => {
  const { queueTranslationOptions } = await import('../src/cloudflare-worker.mjs')
  const env = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8')).vars
  const options = queueTranslationOptions(env, 1, 'user-selected-stable')
  const cues = Array.from({ length: 900 }, (_, i) => ({
    time: '00:00:00.000 --> 00:00:01.000',
    text: `line-${i}`
  }))

  let active = 0
  let maxActive = 0
  let stats
  const output = await translateCues(cues, {
    ...options,
    translateTextsFn: async texts => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 8))
      active--
      return texts.map(text => `BM:${text}`)
    },
    onTranslationStats: value => { stats = value }
  })

  assert.equal(output.length, 900)
  assert.equal(stats.chunks, 6)
  assert.equal(stats.concurrency, 5)
  assert.equal(maxActive, 5)
})
