'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

function relayNamespace() {
  const values = new Map()
  return {
    idFromName(name) { return name },
    get(id) {
      return {
        async fetch(_url, init = {}) {
          const method = init.method || 'GET'
          if (method === 'PUT') {
            values.set(id, String(init.body || ''))
            return new Response(null, { status: 204 })
          }
          const value = values.get(id)
          return value ? new Response(value, { status: 200 }) : new Response(null, { status: 404 })
        }
      }
    }
  }
}

test('Part 4.3 config binds a strongly consistent delivery relay and preserves stable settings', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))
  const binding = config.durable_objects.bindings.find(item => item.name === 'SMARTSUBS_DELIVERY')
  const migration = config.migrations.find(item => item.tag === 'v2-part4-3-delivery-relay')
  assert.equal(binding.class_name, 'TranslationDeliveryRelay')
  assert.deepEqual(migration.new_sqlite_classes, ['TranslationDeliveryRelay'])
  assert.equal(config.vars.DELIVERY_RELAY_TTL_MS, '120000')
  assert.equal(config.vars.PLAYER_QUEUE_WAIT_MAX_MS, '9000')
  assert.equal(config.vars.PLAYER_QUEUE_GRACE_MS, '600')
  assert.equal(config.vars.QUEUE_USER_SELECTED_CONCURRENCY, '3')
})

test('Part 4.3 relay exposes completed VTT while KV still returns a stale miss', async () => {
  const { writeDeliveryRelay, readReadyTranslation } = await import('../src/cloudflare-worker.mjs')
  const cacheKey = 'c'.repeat(64)
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nSiap\n'
  const env = { SMARTSUBS_DELIVERY: relayNamespace() }
  assert.equal(await writeDeliveryRelay(env, cacheKey, vtt), true)
  assert.deepEqual(await readReadyTranslation(env, { async get() { return null } }, cacheKey), {
    vtt,
    source: 'DELIVERY_RELAY'
  })
})

test('Part 4.3 Queue wait reads relay without another Gemini translation', async () => {
  const { waitForQueueCache, writeDeliveryRelay } = await import('../src/cloudflare-worker.mjs')
  const cacheKey = 'd'.repeat(64)
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nDihantar\n'
  const env = {
    SMARTSUBS_DELIVERY: relayNamespace(),
    SMARTSUBS_CACHE: { async get() { return { state: 'running' } } }
  }
  let now = 0
  const result = await waitForQueueCache({
    env,
    cache: { async get() { return null } },
    cacheKey,
    initialJob: { state: 'running' },
    maxWaitMs: 10,
    pollMs: 5,
    sleepFn: async ms => {
      now += ms
      if (now === 5) await writeDeliveryRelay(env, cacheKey, vtt)
    },
    nowFn: () => now
  })
  assert.equal(result.outcome, 'hit')
  assert.equal(result.vtt, vtt)
  assert.equal(result.cacheSource, 'DELIVERY_RELAY')
  assert.equal(result.polls, 1)
})
