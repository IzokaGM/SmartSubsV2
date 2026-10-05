'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createUserConfigToken, tokenFingerprint } = require('../src/user-config')

function storage() {
  const data = new Map()
  let alarm = null
  return {
    async get(k) { return data.get(k) },
    async put(k,v) { data.set(k,v) },
    async delete(k) { data.delete(k) },
    async deleteAll() { data.clear() },
    async list({ prefix, limit } = {}) { return new Map([...data].filter(([k]) => !prefix || k.startsWith(prefix)).slice(0,limit || Infinity)) },
    async getAlarm() { return alarm },
    async setAlarm(t) { alarm = t },
    data
  }
}
const zero = () => ({ get:0,put:0,list:0,delete:0 })
function event(mediaId, get, put, phase = 'player-translation') {
  return {
    requestId: randomUUID(), timestamp: new Date().toISOString(),
    phase, media: { type: 'series', id: mediaId },
    attempted: { ...zero(), get, put }, succeeded: { ...zero(), get, put }, failed: zero(),
    categories: { diagnostics: { ...zero(), put }, 'translation-cache':{ ...zero(), get }, 'queue-state':zero(), other:zero() }
  }
}
async function post(relay, path, payload = null) {
  return relay.fetch(new Request('https://internal' + path, { method: 'POST', ...payload && { body: JSON.stringify(payload) } }))
}

test('two sequential tests on same episode remain separate, without resetting old v1 totals', async () => {
  const { TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const relay = new TranslationDeliveryRelay({ storage: storage() }, {})
  const media = 'tt123:1:2'
  assert.equal((await post(relay, '/usage', event(media, 2, 5))).status, 204)
  assert.equal((await post(relay, '/test/start')).status, 200)
  assert.equal((await post(relay, '/test/start')).status, 409)
  await post(relay, '/usage', event(media, 3, 7))
  const active = await (await relay.fetch(new Request('https://internal/monitor'))).json()
  assert.equal(active.testState.active.totals.attempted.put, 7)
  assert.equal(active.testState.active.totals.attempted.get, 3)
  assert.equal((await post(relay, '/test/end')).status, 200)
  assert.equal((await post(relay, '/test/end')).status, 409)
  await post(relay, '/test/start')
  await post(relay, '/usage', event(media, 1, 2))
  await post(relay, '/test/end')
  const state = await (await relay.fetch(new Request('https://internal/monitor'))).json()
  assert.equal(state.testState.active, null)
  assert.equal(state.testState.history.length, 2)
  assert.notEqual(state.testState.history[0].id, state.testState.history[1].id)
  assert.deepEqual(state.testState.history.map(t => t.number), [2,1])
  assert.equal(state.testState.history[0].totals.attempted.put, 2)
  assert.equal(state.testState.history[1].totals.attempted.put, 7)
  assert.equal(state.testState.history[0].totals.attempted.get, 1)
  assert.equal(state.testState.history[1].totals.attempted.get, 3)
  assert.equal(state.reports[0].attempted.put, 14)
  assert.equal(state.reports[0].attempted.get, 6)
})

test('manual test groups separate episodes and phases without modifying old monitor collection', async () => {
  const { TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const relay = new TranslationDeliveryRelay({ storage: storage() }, {})
  await post(relay, '/test/start')
  await post(relay, '/usage', event('tt123:1:2', 3, 1, 'subtitle-list'))
  await post(relay, '/usage', event('tt123:1:2', 0, 2, 'player-translation'))
  await post(relay, '/usage', event('tt123:1:3', 5, 4, 'queue'))
  const done = await (await post(relay, '/test/end')).json()
  assert.equal(done.test.reports.length, 2)
  assert.equal(done.test.totals.requests, 3)
  assert.equal(done.test.totals.attempted.get, 8)
  assert.equal(done.test.totals.attempted.put, 7)
  assert.equal(done.test.reports.find(r => r.media.id === 'tt123:1:2').phases['subtitle-list'].requests, 1)
})

test('private GET and POST monitor test controls use the existing configured token and no extra KV operations', async () => {
  const { default: worker, TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const secret = 'manual-test-secret'
  const token = createUserConfigToken('a'.repeat(36), { secret })
  const otherToken = createUserConfigToken('b'.repeat(36), { secret })
  const instances = new Map()
  let kvCalls = 0
  const env = {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: { async get() { kvCalls++ }, async put() { kvCalls++ }, async list() { kvCalls++ }, async delete() { kvCalls++ } },
    SMARTSUBS_DELIVERY: {
      idFromName(s) { return s },
      get(id) { if (!instances.has(id)) instances.set(id, new TranslationDeliveryRelay({ storage: storage() }, {})); return { fetch:(url, init)=>instances.get(id).fetch(new Request(url, init)) } }
    }
  }
  const root = `https://smartsubs.test/c/${token}/kv-monitor`
  assert.equal((await worker.fetch(new Request(root, {method:'POST'}), env)).status, 404)
  const start = await worker.fetch(new Request(root+'/test/start', {method:'POST'}), env)
  assert.equal(start.status, 303)
  assert.equal(start.headers.get('location'), new URL(root).pathname)
  const html = await (await worker.fetch(new Request(root), env)).text()
  assert.match(html, /In progress/)
  assert.match(html, /End Test/)
  assert.doesNotMatch(html, /Start Test<\/button>/)
  const second = await worker.fetch(new Request(`https://smartsubs.test/c/${otherToken}/kv-monitor`), env)
  assert.doesNotMatch(await second.text(), /Test in progress/)
  assert.equal((await worker.fetch(new Request(root+'/test/end', {method:'POST'}), env)).status, 303)
  assert.equal(kvCalls, 0)
  const inner = instances.get(`kv-monitor:v1:${tokenFingerprint(token)}`)
  const final = await (await inner.fetch(new Request('https://internal/monitor'))).json()
  assert.equal(final.testState.history.length, 1)
})

test('test page never interpolates media as HTML and history is bounded', async () => {
  const { renderKvMonitor, startMonitorTest, endMonitorTest, readMonitorTestState } = await import('../src/kv-monitor.mjs')
  const html = renderKvMonitor([], {active:null,history:[{start:Date.now(),end:Date.now(),reports:[{media:{type:'movie',id:'<script>alert(1)</script>'},requests:1,attempted:{get:1,put:2}}],totals:{requests:1,attempted:{get:1,put:2}}}]})
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;/)
  const db = storage()
  for (let i=0; i<22; i++) { await startMonitorTest(db); await endMonitorTest(db) }
  assert.equal((await readMonitorTestState(db)).history.length,20)
})

test('saved empty test survives the monitor cleanup alarm until seven-day retention expires', async () => {
  const { TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const db = storage()
  const relay = new TranslationDeliveryRelay({storage:db}, {})
  await post(relay, '/test/start')
  await post(relay, '/test/end')
  await relay.alarm()
  assert.equal((await (await relay.fetch(new Request('https://internal/monitor'))).json()).testState.history.length,1)
})

test('UI controls resolve against the token-scoped monitor route', async () => {
  const { renderKvMonitor } = await import('../src/kv-monitor.mjs')
  const url = 'https://smartsubs.test/c/SECRET-TOKEN/kv-monitor'
  const start = renderKvMonitor([],{}).match(/action="([^"]+)"/)[1]
  const end = renderKvMonitor([],{active:{start:Date.now(),totals:{},reports:[]},history:[]}).match(/action="([^"]+)"/)[1]
  assert.equal(new URL(start,url).pathname, '/c/SECRET-TOKEN/kv-monitor/test/start')
  assert.equal(new URL(end,url).pathname, '/c/SECRET-TOKEN/kv-monitor/test/end')
})
