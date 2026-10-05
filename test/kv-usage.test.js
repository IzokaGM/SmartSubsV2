'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createTranslationToken, decodeTranslationTokenData } = require('../src/token')
const { buildAutoSubtitle } = require('../src/subtitles')
const { createUserConfigToken } = require('../src/user-config')

test('media identity is signed into newly generated links; legacy links still decode', () => {
  const { url } = buildAutoSubtitle(
    { url: 'https://example.test/en.srt', id: 'english1' },
    { publicBaseUrl: 'https://smartsubs.test', tokenSecret: 'example-secret', media: { type: 'series', id: 'tt123:1:6' } }
  )
  const media = decodeTranslationTokenData(url.split('/translated/')[1].slice(0, -4), 'example-secret').media
  assert.deepEqual(media, { type: 'series', id: 'tt123:1:6' })
  assert.equal(decodeTranslationTokenData(createTranslationToken('https://example.test/en.srt', 'example-secret'), 'example-secret').media, null)
})

test('tracker records exact KV calls by category, successes and failures without extra writes', async () => {
  const { createKvUsageTracker, trackedEnvironment } = await import('../src/kv-usage.mjs')
  const calls = []
  const reports = []
  const kv = {
    async get(key) { calls.push(['get', key]); return 'ok' },
    async put(key) { calls.push(['put', key]); if (key.startsWith('job:')) throw new Error('429') },
    async list() { calls.push(['list']); return { keys: [] } },
    async delete(key) { calls.push(['delete', key]) }
  }
  const tracker = createKvUsageTracker({
    phase: 'subtitle-list', media: { type: 'series', id: 'tt999:2:3' }, logger: value => reports.push(JSON.parse(value))
  })
  const env = trackedEnvironment({ SMARTSUBS_CACHE: kv }, tracker)
  assert.equal(await env.SMARTSUBS_CACHE.get('a'.repeat(64)), 'ok')
  await env.SMARTSUBS_CACHE.put('diag:v1:abcdef:item', 'diagnostic')
  await assert.rejects(env.SMARTSUBS_CACHE.put('job:v1:somejob', 'queued'), /429/)
  await env.SMARTSUBS_CACHE.list({ prefix: 'diag:v1:abcdef:' })
  await env.SMARTSUBS_CACHE.delete('a'.repeat(64))
  tracker.flush()
  assert.equal(calls.length, 5)
  assert.equal(reports.length, 1)
  const report = reports[0]
  assert.deepEqual(report.media, { type: 'series', id: 'tt999:2:3', season: 2, episode: 3 })
  assert.deepEqual(report.attempted, { get: 1, put: 2, list: 1, delete: 1 })
  assert.deepEqual(report.failed, { get: 0, put: 1, list: 0, delete: 0 })
  assert.deepEqual(report.categories.diagnostics, { get: 0, put: 1, list: 1, delete: 0 })
  assert.equal(report.categories['translation-cache'].get, 1)
  assert.equal(report.categories['queue-state'].put, 1)
  assert.equal(report.categories['translation-cache'].delete, 1)
  assert.equal(JSON.stringify(report).includes('somejob'), false)
  assert.equal(JSON.stringify(report).includes('diagnostic'), true) // category, not the payload
})

test('real Worker cached playback is attributed to episode; repeated playback preserves memory cache', async () => {
  const { default: worker, translationCacheKey } = await import('../src/cloudflare-worker.mjs')
  const secret = 'integration-secret'
  const model = 'gemini-integration'
  const configToken = createUserConfigToken('a'.repeat(35), { secret, model })
  const token = createTranslationToken('https://example.test/sub.srt', secret, 'eng-99', { type: 'series', id: 'tt123:1:6' })
  const key = translationCacheKey(decodeTranslationTokenData(token, secret), model, {})
  const calls = []
  const kv = {
    async get(k, options) {
      calls.push(['get', k])
      if (k === key && options?.type === 'json') {
        return { v: 1, cacheVersion: 'm8-v1', value: 'WEBVTT\n\nHai', expiresAt: Date.now() + 90000 }
      }
      return null
    },
    async put(k) { calls.push(['put', k]) },
    async list() { calls.push(['list']); return { keys: [] } },
    async delete(k) { calls.push(['delete', k]) }
  }
  const path = `https://smartsubs.test/c/${configToken}/translated/${token}.vtt`
  const env = { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: kv }
  const logs = []
  const original = console.log
  console.log = line => { if (line.includes('SMARTSUBS_KV_USAGE')) logs.push(JSON.parse(line)) }
  try {
    const response1 = await worker.fetch(new Request(path), env)
    const response2 = await worker.fetch(new Request(path), env)
    assert.equal(response1.status, 200)
    assert.equal(response2.status, 200)
    assert.equal(await response2.text(), 'WEBVTT\n\nHai')
  } finally {
    console.log = original
  }
  assert.equal(logs.length, 2)
  assert.deepEqual(logs[0].media, { type: 'series', id: 'tt123:1:6', season: 1, episode: 6 })
  assert.equal(logs[0].phase, 'player-translation')
  assert.equal(logs[0].attempted.get, 1)
  assert.equal(logs[0].attempted.put, 0) // Diagnostics is OFF by default.
  assert.equal(logs[1].attempted.get, 0) // Memory cache was not disabled by tracking.
  assert.equal(logs[1].attempted.put, 0)
  assert.equal(calls.filter(item => item[0] === 'get').length, 1)
})

test('queue usage is flushed separately for each message, including retry-path writes', async () => {
  const { handleQueue } = await import('../src/cloudflare-worker.mjs')
  const old = console.log
  const logs = []
  console.log = line => { if (line.includes('SMARTSUBS_KV_USAGE')) logs.push(JSON.parse(line)) }
  const calls = []
  const kv = {
    async put(key) { calls.push(key) },
    async get() { return null },
    async list() { return { keys: [] } },
    async delete() {}
  }
  const batch = { messages: [{ body: { cacheKey: 'a'.repeat(64), configId: 'cfg' }, attempts: 2, retry() {} }] }
  try {
    await handleQueue(batch, { SMARTSUBS_CACHE: kv }, {
      trackUsage: true,
      processFn: async (_body, env) => {
        await env.SMARTSUBS_CACHE.put('diag:v1:cfg:test', 'event')
        throw new Error('temporary')
      }
    })
  } finally { console.log = old }
  assert.equal(logs.length, 1)
  assert.equal(logs[0].phase, 'queue')
  assert.equal(logs[0].attempt, 2)
  assert.equal(logs[0].attempted.put, 2) // Explicit mock write + Queue retry state; Diagnostics defaults OFF.
  assert.equal(logs[0].mediaKnown, false) // Legacy/unidentifiable input must not be guessed.
  assert.equal(calls.length, 2)
})
