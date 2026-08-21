'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { deriveVerdict } = require('../src/diagnostics')

test('Part 3.1 uses a short bounded player Queue wait', async () => {
  const { playerQueueWaitMaxMs } = await import('../src/cloudflare-worker.mjs')

  assert.equal(playerQueueWaitMaxMs({}), 5000)
  assert.equal(playerQueueWaitMaxMs({ PLAYER_QUEUE_WAIT_MAX_MS: 100 }), 2000)
  assert.equal(playerQueueWaitMaxMs({ PLAYER_QUEUE_WAIT_MAX_MS: 60000 }), 10000)
})

test('Part 3.1 returns a retryable preparing response instead of hanging', async () => {
  const { translationPreparingResponse } = await import('../src/cloudflare-worker.mjs')
  const response = translationPreparingResponse()

  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '3')
  assert.equal(response.headers.get('x-smartsubs-error'), 'translation-preparing')
  assert.match(await response.text(), /being prepared/i)
})

test('Part 3.1 translated route queues before synchronous fallback', () => {
  const source = fs.readFileSync('src/cloudflare-worker.mjs', 'utf8')
  const routeStart = source.indexOf("const translationMatch =")
  const routeEnd = source.indexOf("if (request.method === 'GET')", routeStart)
  const route = source.slice(routeStart, routeEnd)

  assert.match(route, /player-translation-queued/)
  assert.match(route, /enqueuePrefetchTranslation/)
  assert.match(route, /playerQueueWaitMaxMs/)
  assert.match(route, /translationPreparingResponse/)
  assert.match(route, /direct-fallback/)

  const queuePos = route.indexOf('enqueuePrefetchTranslation')
  const directPos = route.indexOf('result = await cfGetOrTranslate')
  assert.ok(queuePos >= 0)
  assert.ok(directPos > queuePos)
})

test('Part 3.1 existing Queue joins also use the short player wait', () => {
  const source = fs.readFileSync('src/cloudflare-worker.mjs', 'utf8')

  assert.match(
    source,
    /initialJob: job,\s*maxWaitMs: playerQueueWaitMaxMs\(env\)/
  )
})

test('Part 3.1 Diagnose reports durable Queue preparation', () => {
  const now = Date.now()
  const verdict = deriveVerdict([
    {
      ts: now,
      event: 'subtitle-result',
      result: 'native-malay-with-auto-fallback',
      subtitleCount: 2,
      autoReady: true
    },
    {
      ts: now + 1,
      event: 'translation-request',
      status: 'player'
    },
    {
      ts: now + 2,
      event: 'player-translation-queued',
      status: 'queued'
    },
    {
      ts: now + 3,
      event: 'translation-pending',
      status: 'running',
      reason: 'timeout'
    }
  ])

  assert.equal(verdict, 'TRANSLATION_PREPARING_IN_QUEUE')
})
