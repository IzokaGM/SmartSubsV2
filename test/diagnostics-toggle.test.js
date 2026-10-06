'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createUserConfigToken, tokenFingerprint } = require('../src/user-config')
const { createTranslationToken, decodeTranslationTokenData } = require('../src/token')

function storage() {
  const data = new Map()
  let alarm = null
  return {
    data,
    async get(key) { return data.get(key) },
    async put(key, value) { data.set(key, value) },
    async delete(key) { data.delete(key) },
    async deleteAll() { data.clear() },
    async list({ prefix, limit } = {}) { return new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix)).slice(0, limit || Infinity)) },
    async getAlarm() { return alarm },
    async setAlarm(value) { alarm = value }
  }
}

async function setup() {
  const { default: worker, TranslationDeliveryRelay, translationCacheKey } = await import('../src/cloudflare-worker.mjs')
  const serverSecret = 'diagnostics-switch-integration-secret'
  const adminKey = 'separate-strong-diagnostics-admin-key-32'
  const model = 'diagnostics-test-model'
  const token = createUserConfigToken('a'.repeat(36), { secret: serverSecret, model })
  const otherToken = createUserConfigToken('b'.repeat(36), { secret: serverSecret, model })
  const translationToken = createTranslationToken('https://example.test/english.srt', serverSecret, 'en-test', { type: 'series', id: 'tt123:1:9' })
  const cacheKey = translationCacheKey(decodeTranslationTokenData(translationToken, serverSecret), model, {})
  const calls = []
  const diagValues = new Map()
  const cache = {
    async get(key, options) {
      calls.push(['get', key])
      if (key === cacheKey && options?.type === 'json') return {
        v: 1, cacheVersion: 'm8-v1', value: 'WEBVTT\n\nMalay subtitle', expiresAt: Date.now() + 60000
      }
      return diagValues.get(key) || null
    },
    async put(key, value) { calls.push(['put', key]); diagValues.set(key, value) },
    async list({ prefix } = {}) {
      calls.push(['list', prefix])
      return { keys: [...diagValues.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })) }
    },
    async delete(key) { calls.push(['delete', key]) }
  }
  const instances = new Map()
  const binding = {
    idFromName(name) { return name },
    get(id) {
      if (!instances.has(id)) instances.set(id, new TranslationDeliveryRelay({ storage: storage() }, {}))
      return { fetch(url, init) { return instances.get(id).fetch(new Request(url, init)) } }
    }
  }
  const env = { SMARTSUBS_SECRET: serverSecret, SMARTSUBS_DIAG_ADMIN_KEY: adminKey,
    SMARTSUBS_DELIVERY: binding, SMARTSUBS_CACHE: cache }
  const base = `https://smartsubs.test/c/${token}`
  const browse = async (pathname, init = {}) => {
    const pending = []
    const result = await worker.fetch(new Request(`${base}${pathname}`, init), env, {
      waitUntil(task) { pending.push(task) }
    })
    await Promise.all(pending)
    return result
  }
  const toggle = (action, key = adminKey, headers = {}) => browse('/diagnose/toggle', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://smartsubs.test', ...headers },
    body: new URLSearchParams({ action, adminKey: key })
  })
  return { worker, token, otherToken, translationToken, adminKey, env, base, cache, calls, instances, browse, toggle }
}

test('default OFF: no Diagnostics KV reads/writes; translation cache keeps working', async () => {
  const { browse, translationToken, calls } = await setup()
  const page = await browse('/diagnose')
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.match(html, /Diagnostics:.*OFF/)
  assert.match(html, /adminKey/)
  assert.equal(calls.length, 0, 'OFF diagnose must not list/read old KV diagnostics')
  const response = await browse(`/translated/${translationToken}.vtt`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'WEBVTT\n\nMalay subtitle')
  assert.equal(calls.filter(([op]) => op === 'put').length, 0, 'OFF must never write diagnostic events')
  assert.equal(calls.filter(([op]) => op === 'get').length, 1, 'translation cache remains active')
})

test('switch requires separate admin key and supports browser/proxy request-header variations', async () => {
  const { browse, toggle, env, calls, adminKey } = await setup()
  assert.equal((await toggle('on', 'wrong-key-at-least-twenty-chars')).status, 403)
  assert.equal((await toggle('on', 'wrong-key-at-least-twenty-chars', {
    origin: 'https://evil.example', 'sec-fetch-site': 'cross-site'
  })).status, 403)
  assert.equal((await toggle('on', adminKey, { origin: 'null', 'sec-fetch-site': 'same-site' })).status, 303)
  assert.equal((await toggle('off', adminKey, { 'sec-fetch-site': 'cross-site' })).status, 303)
  assert.equal((await toggle('on', adminKey, { origin: 'https://alternate-host.example' })).status, 303)
  assert.equal((await toggle('off', adminKey)).status, 303)
  assert.equal((await toggle('on', adminKey, { 'content-type': 'text/plain' })).status, 400)
  assert.equal((await toggle('on', adminKey, { origin: 'https://smartsubs.test', 'content-length': '3000' })).status, 413)
  const page = await browse('/diagnose')
  assert.match(await page.text(), /Diagnostics:.*OFF/)
  assert.equal(calls.length, 0)
  const noSecret = { ...env, SMARTSUBS_DIAG_ADMIN_KEY: undefined }
  const { worker, base } = await setup()
  assert.equal((await worker.fetch(new Request(`${base}/diagnose/toggle`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ adminKey, action: 'on' })
  }), noSecret)).status, 503)
})

test('admin key accepts six characters but rejects shorter configured or submitted keys', async () => {
  const ctx = await setup()
  ctx.env.SMARTSUBS_DIAG_ADMIN_KEY = 'A7$z9q'
  const page = await ctx.browse('/diagnose')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /minlength="6"/)
  assert.equal((await ctx.toggle('on', 'A7$z9')).status, 403)
  assert.equal((await ctx.toggle('on', 'A7$z9q')).status, 303)
  assert.match(await (await ctx.browse('/diagnose')).text(), /Diagnostics:.*ON/)
  assert.equal((await ctx.toggle('off', 'A7$z9q')).status, 303)
  ctx.env.SMARTSUBS_DIAG_ADMIN_KEY = 'A7$z9'
  assert.equal((await ctx.toggle('on', 'A7$z9')).status, 503)
})

test('ON records diagnostics; OFF stops future writes without deleting old events or other config settings', async () => {
  const { browse, toggle, translationToken, calls, token, otherToken, instances, env, worker } = await setup()
  const on = await toggle('on')
  assert.equal(on.status, 303)
  assert.match(on.headers.get('location'), /\/diagnose$/)
  const stateRelay = instances.get(`kv-monitor:v1:${tokenFingerprint(token)}`)
  assert.equal((await (await stateRelay.fetch(new Request('https://internal/diagnostics/state'))).json()).enabled, true)
  assert.match(await (await browse('/diagnose')).text(), /Diagnostics:.*ON/)
  const active = await browse(`/translated/${translationToken}.vtt`)
  assert.equal(active.status, 200)
  assert.equal(await active.text(), 'WEBVTT\n\nMalay subtitle')
  assert.equal(calls.filter(([op]) => op === 'put').length, 2, 'ON retains both player diagnostic events')
  const shown = await (await browse('/diagnose')).text()
  assert.match(shown, /translation-delivered/)
  const off = await toggle('off')
  assert.equal(off.status, 303)
  const afterOff = calls.filter(([op]) => op === 'put').length
  const listCount = calls.filter(([op]) => op === 'list').length
  const offPage = await browse('/diagnose')
  assert.match(await offPage.text(), /Diagnostics:.*OFF/)
  assert.equal(calls.filter(([op]) => op === 'list').length, listCount, 'OFF page must not read old diagnostic list')
  assert.equal((await browse(`/translated/${translationToken}.vtt`)).status, 200)
  assert.equal(calls.filter(([op]) => op === 'put').length, afterOff)
  assert.equal((await (await stateRelay.fetch(new Request('https://internal/diagnostics/state'))).json()).enabled, false)
  const otherPage = await worker.fetch(new Request(`https://smartsubs.test/c/${otherToken}/diagnose`), env)
  assert.match(await otherPage.text(), /Diagnostics:.*OFF/, 'switch must be isolated to one config')
  const onAgain = await toggle('on')
  assert.equal(onAgain.status, 303)
  const resetState = await (await stateRelay.fetch(new Request('https://internal/diagnostics/state'))).json()
  assert.ok(resetState.since > 0)
  const activated = await browse('/diagnose')
  assert.equal(activated.status, 200)
  assert.match(await activated.text(), /Diagnostics:.*ON/)
})

test('existing relay/monitor operations and cleanup preserve an enabled Diagnostics switch', async () => {
  const { TranslationDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const db = storage()
  const relay = new TranslationDeliveryRelay({ storage: db }, {})
  assert.equal((await relay.fetch(new Request('https://internal/diagnostics/state', {
    method: 'POST', body: JSON.stringify({ enabled: true })
  }))).status, 200)
  await relay.alarm()
  assert.equal((await (await relay.fetch(new Request('https://internal/diagnostics/state'))).json()).enabled, true)
  assert.equal(await db.getAlarm(), null, 'enabled switch does not require periodic alarms')
  assert.equal((await relay.fetch(new Request('https://internal/diagnostics/state', {
    method: 'PUT', body: 'x'
  }))).status, 405)
})


test('ON page retains canonical Compact UI layout with its title inside the status card', async () => {
  const { browse, toggle } = await setup()
  assert.equal((await toggle('on')).status, 303)
  const html = await (await browse('/diagnose')).text()
  assert.match(html, /<body><main class="wrap">\s*<section class="card"><header class="diagnose-heading"><h1>SmartSubsV2 Diagnose<\/h1>/)
  assert.match(html, /Diagnostics:.*ON/)
  assert.match(html, /<section class="card"><h2>Overview<\/h2><div class="grid">/)
  assert.doesNotMatch(html, /Source details/)
  assert.match(html, /<summary>Technical events \(0\)<\/summary>/)
  assert.doesNotMatch(html, /<body><main class="wrap"><h1>SmartSubsV2 Diagnose<\/h1>/)
})


test('ON displays compact one-tap OFF without admin input; OFF without key stops writes', async () => {
  const { browse, toggle, translationToken, calls, adminKey } = await setup()
  assert.equal((await toggle('on', 'invalid')).status, 403, 'ON still requires a valid key')
  assert.equal((await toggle('on', adminKey)).status, 303)
  const onPage = await (await browse('/diagnose')).text()
  assert.match(onPage, /class="diag-control-row"/)
  assert.match(onPage, /class="diag-off-btn"[^>]*name="action" value="off"/)
  assert.doesNotMatch(onPage, /<input[^>]*name="adminKey"/)
  assert.match(onPage, /<h2>Overview<\/h2>/, 'Compact UI overview is unchanged')
  assert.equal((await browse(`/translated/${translationToken}.vtt`)).status, 200)
  const beforeOff = calls.filter(([method]) => method === 'put').length
  assert.ok(beforeOff > 0)
  const off = await toggle('off', '')
  assert.equal(off.status, 303, 'OFF does not require any admin key')
  const offPage = await (await browse('/diagnose')).text()
  assert.match(offPage, /Diagnostics:.*OFF/)
  assert.match(offPage, /<input[^>]*name="adminKey"/)
  assert.equal((await browse(`/translated/${translationToken}.vtt`)).status, 200)
  assert.equal(calls.filter(([method]) => method === 'put').length, beforeOff, 'OFF prevents further diagnostics writes')
  assert.equal((await toggle('on', '')).status, 403, 'ON is still protected')
})
