'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createUserConfigToken } = require('../src/user-config')

function mockStorage() {
  const data = new Map()
  let alarm = null
  return {
    async get(key) { return data.get(key) },
    async put(key, value) { data.set(key, value) },
    async delete(key) { data.delete(key) },
    async deleteAll() { data.clear() },
    async list({ prefix, limit } = {}) {
      return new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix)).slice(0, limit || Infinity))
    },
    async getAlarm() { return alarm },
    async setAlarm(time) { alarm = time },
    _data: data
  }
}

function snapshot(type, id, phase, counts, requestId = randomUUID()) {
  const categories = {
    'translation-cache': { get: counts.get || 0, put: 0 },
    'queue-state': { get: 0, put: 0 },
    diagnostics: { get: 0, put: counts.put || 0 },
    other: { get: 0, put: 0 }
  }
  return { requestId, timestamp: new Date().toISOString(), phase, media: { type, id },
    attempted: { get: counts.get || 0, put: counts.put || 0 },
    succeeded: { get: counts.get || 0, put: counts.put || 0 },
    failed: { get: 0, put: 0 }, categories }
}

test('Durable Object aggregates requests by episode/day; deduplicates by requestId and keeps stages distinct', async () => {
  const { TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const doStorage = mockStorage()
  const relay = new TranslationDeliveryRelay({ storage: doStorage }, {})
  const a = snapshot('series', 'tt1196946:2:2', 'subtitle-list', { get: 2, put: 4 })
  const b = snapshot('series', 'tt1196946:2:2', 'queue', { get: 3, put: 5 })
  const c = snapshot('series', 'tt1196946:2:1', 'player-translation', { get: 0, put: 2 })
  for (const [index, report] of [a, a, b, c].entries()) {
    const status = (await relay.fetch(new Request('https://internal/usage', {
      method: 'POST', body: JSON.stringify(report)
    }))).status
    assert.equal(status, index === 1 ? 400 : 204)
  }
  const response = await relay.fetch(new Request('https://internal/usage'))
  const rows = await response.json()
  assert.equal(rows.length, 2)
  const s2e2 = rows.find(item => item.media.id === 'tt1196946:2:2')
  assert.equal(s2e2.requests, 2)
  assert.deepEqual([s2e2.attempted.get, s2e2.attempted.put], [5, 9])
  assert.equal(s2e2.phases.queue.requests, 1)
  assert.equal(s2e2.categories.diagnostics.put, 9)
  assert.ok(await doStorage.getAlarm())
})

test('Private monitor reads only configured user reports, and does no Workers KV operation', async () => {
  const { default: worker, TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const { tokenFingerprint } = require('../src/user-config')
  const secret = 'monitor-test-secret'
  const tokenA = createUserConfigToken('a'.repeat(36), { secret })
  const tokenB = createUserConfigToken('b'.repeat(36), { secret })
  const ids = []
  const instances = new Map()
  let kvCalls = 0
  const binding = {
    idFromName(name) { ids.push(name); return name },
    get(id) {
      if (!instances.has(id)) instances.set(id, new TranslationDeliveryRelay({ storage: mockStorage() }, {}))
      return { fetch: (url, init) => instances.get(id).fetch(new Request(url, init)) }
    }
  }
  const kv = { async get() { kvCalls++ }, async put() { kvCalls++ }, async delete() { kvCalls++ }, async list() { kvCalls++ } }
  const env = { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: kv, SMARTSUBS_DELIVERY: binding }
  const urlA = `https://smartsubs.test/c/${tokenA}/kv-monitor`
  const urlB = `https://smartsubs.test/c/${tokenB}/kv-monitor`
  assert.equal((await worker.fetch(new Request('https://smartsubs.test/c/bad/kv-monitor'), env)).status, 401)
  const stub = binding.get(binding.idFromName(`kv-monitor:v1:${tokenFingerprint(tokenA)}`))
  await stub.fetch('https://internal/usage', { method: 'POST', body: JSON.stringify(snapshot('movie', 'tt678', 'subtitle-list', { get: 1, put: 3 })) })
  const a = await worker.fetch(new Request(urlA), env)
  const b = await worker.fetch(new Request(urlB), env)
  assert.equal(a.status, 200)
  assert.match(await a.text(), /tt678/)
  assert.doesNotMatch(await b.text(), /tt678/)
  assert.equal(kvCalls, 0)
  assert.ok(ids.some(name => name.startsWith('kv-monitor:v1:')))
})

test('Real player operation is written to monitor without extra KV writes while Diagnostics is OFF', async () => {
  const { default: worker, TranslationDeliveryRelay, translationCacheKey } = await import('../src/cloudflare-worker.mjs')
  const { createTranslationToken, decodeTranslationTokenData } = require('../src/token')
  const { tokenFingerprint } = require('../src/user-config')
  const secret = 'monitor-test-secret-2'
  const model = 'model-test'
  const configToken = createUserConfigToken('c'.repeat(35), { secret, model })
  const t = createTranslationToken('https://example.test/source.srt', secret, 'new-cache', { type: 'series', id: 'tt123:1:7' })
  const cacheKey = translationCacheKey(decodeTranslationTokenData(t, secret), model, {})
  const kvCalls = []
  const kv = {
    async get(key, options) { kvCalls.push(['get', key]); if (key === cacheKey && options?.type === 'json') return { v: 1, cacheVersion: 'm8-v1', value: 'WEBVTT\n\nSiap', expiresAt: Date.now() + 60000 }; return null },
    async put(key) { kvCalls.push(['put', key]) }
  }
  const instances = new Map()
  const env = { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: kv, SMARTSUBS_DELIVERY: {
    idFromName(name) { return name },
    get(id) { if (!instances.has(id)) instances.set(id, new TranslationDeliveryRelay({ storage: mockStorage() }, {})); return { fetch: (url, init) => instances.get(id).fetch(new Request(url, init)) } }
  } }
  const pending = []
  const ctx = { waitUntil(promise) { pending.push(promise) } }
  const original = console.log
  console.log = () => {}
  let response
  try {
    response = await worker.fetch(new Request(`https://smartsubs.test/c/${configToken}/translated/${t}.vtt`), env, ctx)
    await Promise.all(pending)
  } finally { console.log = original }
  assert.equal(response.status, 200)
  assert.equal(kvCalls.filter(([method]) => method === 'put').length, 0) // Diagnostics defaults OFF
  const relay = instances.get(`kv-monitor:v1:${tokenFingerprint(configToken)}`)
  const reports = await (await relay.fetch(new Request('https://internal/usage'))).json()
  assert.equal(reports[0].media.id, 'tt123:1:7')
  assert.equal(reports[0].attempted.put, 0)
  assert.equal(reports[0].attempted.get, 1)
})

test('Mobile page escapes stored media id and shows read/write from queue and diagnostics', async () => {
  const { renderKvMonitor } = await import('../src/kv-monitor.mjs')
  const html = renderKvMonitor([{ media: { type: 'movie', id: '<script>hello</script>' }, requests: 3,
    attempted: { get: 3, put: 6 }, categories: { diagnostics: { get: 0, put: 4 }, 'queue-state': { get: 1, put: 2 } },
    phases: { queue: { requests: 1, attempted: { get: 2, put: 4 } } }, last: Date.now(),
    cacheResults: { MISS: 1 } }])
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>hello/)
  assert.match(html, /6 Write/)
  assert.match(html, /Refresh/)
})


test('English monitor preserves cumulative reports alongside manual test controls', async () => {
  const { renderKvMonitor } = await import('../src/kv-monitor.mjs')
  const html = renderKvMonitor([{ media: { type: 'series', id: 'tt123:2:8', season: 2, episode: 8 }, requests: 2, attempted: { get: 1, put: 4 }, categories: {}, phases: {}, last: Date.now() }])
  assert.match(html, /Series · Season 2 · Episode 8/)
  assert.match(html, /2 requests recorded/)
  assert.match(html, /Cumulative operations/)
  assert.match(html, /Start Test/)
  assert.doesNotMatch(html, /Mula ujian|Tamatkan ujian|auto-event:v1:/)
})
