'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createUserConfigToken, tokenFingerprint } = require('../src/user-config')
const { createTranslationToken, decodeTranslationTokenData } = require('../src/token')

function storage() {
  const data = new Map()
  return {
    async get(key) { return data.get(key) },
    async put(key, value) { data.set(key, value) },
    async delete(key) { data.delete(key) },
    async deleteAll() { data.clear() },
    async list({ prefix, limit } = {}) { return new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix)).slice(0, limit || Infinity)) },
    async getAlarm() { return null },
    async setAlarm() {}
  }
}

async function setup() {
  const { default: worker, TranslationDeliveryRelay, translationCacheKey } = await import('../src/cloudflare-worker.mjs')
  const serverSecret = 'diagnose-clear-log-secret'
  const adminKey = 'diagnose-clear-admin-key'
  const model = 'diagnose-clear-model'
  const token = createUserConfigToken('a'.repeat(36), { secret: serverSecret, model })
  const translationToken = createTranslationToken('https://example.test/english.srt', serverSecret, '4374548', { type: 'series', id: 'tt123:1:9' })
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
    async delete(key) { calls.push(['delete', key]); diagValues.delete(key) }
  }
  const instances = new Map()
  const binding = {
    idFromName(name) { return name },
    get(id) {
      if (!instances.has(id)) instances.set(id, new TranslationDeliveryRelay({ storage: storage() }, {}))
      return { fetch(url, init) { return instances.get(id).fetch(new Request(url, init)) } }
    }
  }
  const env = { SMARTSUBS_SECRET: serverSecret, SMARTSUBS_DIAG_ADMIN_KEY: adminKey, SMARTSUBS_DELIVERY: binding, SMARTSUBS_CACHE: cache }
  const base = `https://smartsubs.test/c/${token}`
  const browse = async (pathname, init = {}) => {
    const pending = []
    const response = await worker.fetch(new Request(`${base}${pathname}`, init), env, { waitUntil(task) { pending.push(task) } })
    await Promise.all(pending)
    return response
  }
  return { token, translationToken, adminKey, calls, instances, browse }
}

test('Clear Log resets the visible cutoff, keeps Diagnostics ON, and does not delete/write Diagnostics KV records', async () => {
  const { token, translationToken, adminKey, calls, instances, browse } = await setup()
  const on = await browse('/diagnose/toggle', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'on', adminKey })
  })
  assert.equal(on.status, 303)
  assert.equal((await browse(`/translated/${translationToken}.vtt`)).status, 200)
  const pageBefore = await (await browse('/diagnose')).text()
  assert.match(pageBefore, /translation-delivered/)

  const kvWritesBefore = calls.filter(([op]) => op === 'put').length
  const kvDeletesBefore = calls.filter(([op]) => op === 'delete').length
  const relay = instances.get(`kv-monitor:v1:${tokenFingerprint(token)}`)
  const beforeState = await (await relay.fetch(new Request('https://internal/diagnostics/state'))).json()

  // Let Date.now() advance so the new cutoff is definitely after old events.
  await new Promise(resolve => setTimeout(resolve, 2))
  const clear = await browse('/diagnose/clear', { method: 'POST' })
  assert.equal(clear.status, 303)
  assert.match(clear.headers.get('location'), /\/diagnose$/)
  assert.equal(calls.filter(([op]) => op === 'put').length, kvWritesBefore, 'Clear must not create a KV write')
  assert.equal(calls.filter(([op]) => op === 'delete').length, kvDeletesBefore, 'Clear must not delete Diagnostics KV keys')

  const afterState = await (await relay.fetch(new Request('https://internal/diagnostics/state'))).json()
  assert.equal(afterState.enabled, true)
  assert.ok(afterState.since >= beforeState.since)
  const pageAfter = await (await browse('/diagnose')).text()
  assert.match(pageAfter, /<h2>Technical Events <span class="event-count">0<\/span><\/h2>/)
  assert.doesNotMatch(pageAfter, /Translation delivered/)
})
