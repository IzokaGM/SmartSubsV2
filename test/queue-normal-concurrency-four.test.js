'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { translateCues } = require('../src/translator')

test('normal Queue uses 160/20000/5, retry remains 180/24000/2', async () => {
  const { queueTranslationOptions, queueTranslationProfile } = await import('../src/cloudflare-worker.mjs')
  const env = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8')).vars
  assert.equal(queueTranslationProfile(env, 1), 'quota-safe-final')
  assert.deepEqual(queueTranslationOptions(env, 1), { maxItems: 160, maxChars: 20000, concurrency: 5 })
  assert.deepEqual(queueTranslationOptions(env, 2), { maxItems: 180, maxChars: 24000, concurrency: 2 })
  assert.equal(env.QUEUE_PARALLEL_CONCURRENCY, '3')
  assert.equal(env.QUEUE_USER_SELECTED_CONCURRENCY, '5')
})

test('normal five-chunk episode runs up to five Gemini requests at once, with no extra calls', async () => {
  const cues = Array.from({ length: 754 }, (_, i) => ({
    time: '00:00:00.000 --> 00:00:01.000',
    text: `line-${i}`
  }))
  const { queueTranslationOptions } = await import('../src/cloudflare-worker.mjs')
  const env = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8')).vars
  const options = queueTranslationOptions(env, 1)
  let calls = 0, active = 0, maxActive = 0, stats
  const result = await translateCues(cues, {
    ...options,
    translateTextsFn: async texts => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 8))
      active--
      return texts.map(text => `BM:${text}`)
    },
    onTranslationStats: value => { stats = value }
  })
  assert.equal(calls, 5)
  assert.equal(maxActive, 5)
  assert.equal(stats.concurrency, 5)
  assert.equal(stats.chunks, 5)
  assert.equal(result.length, 754)
  assert.equal(result[0].text, 'BM:line-0')
  assert.equal(result[753].text, 'BM:line-753')
})
