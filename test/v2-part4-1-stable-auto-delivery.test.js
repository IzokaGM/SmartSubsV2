'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

test('Part 4.1 deployed player Queue wait is nine seconds', async () => {
  const { playerQueueWaitMaxMs } = await import('../src/cloudflare-worker.mjs')
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.vars.PLAYER_QUEUE_WAIT_MAX_MS, '9000')
  assert.equal(playerQueueWaitMaxMs({ PLAYER_QUEUE_WAIT_MAX_MS: '9000' }), 9000)
})

test('Part 4.1 selected profile is stable concurrency three', async () => {
  const { queueTranslationOptions, queueTranslationProfile, normaliseRequestedQueueProfile } = await import('../src/cloudflare-worker.mjs')
  const env = {
    QUEUE_USER_SELECTED_CHUNK_ITEMS: '160',
    QUEUE_USER_SELECTED_CHUNK_CHARS: '20000',
    QUEUE_USER_SELECTED_CONCURRENCY: '3',
    QUEUE_FALLBACK_CHUNK_ITEMS: '180',
    QUEUE_FALLBACK_CHUNK_CHARS: '24000',
    QUEUE_FALLBACK_CONCURRENCY: '2'
  }

  assert.equal(normaliseRequestedQueueProfile('user-selected-fast'), 'user-selected-stable')
  assert.equal(queueTranslationProfile(env, 1, 'user-selected-stable'), 'user-selected-stable')
  assert.deepEqual(queueTranslationOptions(env, 1, 'user-selected-stable'), {
    maxItems: 160,
    maxChars: 20000,
    concurrency: 3
  })
  assert.equal(queueTranslationProfile(env, 2, 'user-selected-stable'), 'fallback-stable')
})

test('Part 4.1 selected route uses stable profile and durable Queue wait', () => {
  const source = fs.readFileSync('src/cloudflare-worker.mjs', 'utf8')
  const routeStart = source.indexOf('const translationMatch =')
  const routeEnd = source.indexOf("if (request.method === 'GET')", routeStart)
  const route = source.slice(routeStart, routeEnd)

  assert.match(route, /queueProfile: 'user-selected-stable'/)
  assert.match(route, /maxWaitMs: playerQueueWaitMaxMs\(env\)/)
  assert.match(route, /translationPreparingResponse/)
  assert.match(route, /player-translation-queued/)
})

