'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

test('movie long-poll is 33s while series remains 30s', async () => {
  const { playerQueueWaitMaxMs } = await import('../src/cloudflare-worker.mjs')
  const env = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8')).vars

  assert.equal(env.PLAYER_QUEUE_WAIT_MAX_MS, '30000')
  assert.equal(env.PLAYER_MOVIE_QUEUE_WAIT_MAX_MS, '33000')
  assert.equal(playerQueueWaitMaxMs(env, 'series'), 30000)
  assert.equal(playerQueueWaitMaxMs(env, 'movie'), 33000)
  assert.equal(playerQueueWaitMaxMs(env, 'MOVIE'), 33000)
})

test('movie long-poll keeps safe cap below the 35s client timeout headroom', async () => {
  const { playerQueueWaitMaxMs } = await import('../src/cloudflare-worker.mjs')

  assert.equal(playerQueueWaitMaxMs({ PLAYER_MOVIE_QUEUE_WAIT_MAX_MS: '99999' }, 'movie'), 34000)
  assert.equal(playerQueueWaitMaxMs({ PLAYER_QUEUE_WAIT_MAX_MS: '99999' }, 'series'), 30000)
})

test('translated route passes media type into both long-poll limit calculations', () => {
  const source = fs.readFileSync('src/cloudflare-worker.mjs', 'utf8')
  const routeStart = source.indexOf('const translationMatch =')
  const routeEnd = source.indexOf("if (request.method === 'GET')", routeStart)
  const route = source.slice(routeStart, routeEnd)
  const matches = route.match(/maxWaitMs: playerQueueWaitMaxMs\(env, tokenData\.media\?\.type\)/g) || []

  assert.equal(matches.length, 2)
})
