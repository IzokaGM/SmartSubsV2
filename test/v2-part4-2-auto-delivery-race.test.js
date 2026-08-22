'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

test('Part 4.2 deployed player grace is 600ms while main wait stays 9000ms', async () => {
  const {
    playerQueueWaitMaxMs,
    playerQueueGraceMs
  } = await import('../src/cloudflare-worker.mjs')
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.vars.PLAYER_QUEUE_WAIT_MAX_MS, '9000')
  assert.equal(config.vars.PLAYER_QUEUE_GRACE_MS, '600')
  assert.equal(playerQueueWaitMaxMs(config.vars), 9000)
  assert.equal(playerQueueGraceMs(config.vars), 600)
  assert.ok(playerQueueWaitMaxMs(config.vars) + playerQueueGraceMs(config.vars) < 10000)
})

test('Part 4.2 grace check catches cache that becomes ready just after main wait', async () => {
  const { waitForQueueCache } = await import('../src/cloudflare-worker.mjs')

  let now = 0
  const sleepFn = async ms => {
    now += ms
  }

  const cache = {
    async get() {
      return now >= 15 ? 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nSiap\n' : null
    }
  }

  const env = {
    SMARTSUBS_CACHE: {
      async get() {
        return { state: 'running' }
      }
    }
  }

  const result = await waitForQueueCache({
    env,
    cache,
    cacheKey: 'a'.repeat(64),
    initialJob: { state: 'running' },
    maxWaitMs: 10,
    pollMs: 5,
    graceMs: 5,
    sleepFn,
    nowFn: () => now
  })

  assert.equal(result.outcome, 'hit')
  assert.match(result.vtt, /^WEBVTT/)
  assert.equal(result.graceHit, true)
  assert.equal(result.graceWaitMs, 5)
  assert.equal(result.waitMs, 15)
})

test('Part 4.2 still returns timeout when cache remains unavailable after grace', async () => {
  const { waitForQueueCache } = await import('../src/cloudflare-worker.mjs')

  let now = 0
  const sleepFn = async ms => {
    now += ms
  }

  const cache = {
    async get() {
      return null
    }
  }

  const env = {
    SMARTSUBS_CACHE: {
      async get() {
        return { state: 'running' }
      }
    }
  }

  const result = await waitForQueueCache({
    env,
    cache,
    cacheKey: 'b'.repeat(64),
    initialJob: { state: 'running' },
    maxWaitMs: 10,
    pollMs: 5,
    graceMs: 5,
    sleepFn,
    nowFn: () => now
  })

  assert.equal(result.outcome, 'timeout')
  assert.equal(result.vtt, null)
  assert.equal(result.graceHit, false)
  assert.equal(result.graceWaitMs, 5)
  assert.equal(result.waitMs, 15)
})

test('Part 4.2 both player Queue wait paths use the grace window', () => {
  const source = fs.readFileSync('src/cloudflare-worker.mjs', 'utf8')
  const routeStart = source.indexOf('const translationMatch =')
  const routeEnd = source.indexOf("if (request.method === 'GET')", routeStart)
  const route = source.slice(routeStart, routeEnd)

  const graceMatches = route.match(/graceMs: playerQueueGraceMs\(env\)/g) || []
  assert.equal(graceMatches.length, 2)
  assert.match(route, /queue-grace-hit/)
  assert.match(route, /graceHit: joinGraceHit/)
  assert.match(route, /queueProfile: 'user-selected-stable'/)
})

test('Part 4.2 does not change stable translation concurrency', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.vars.QUEUE_USER_SELECTED_CONCURRENCY, '3')
  assert.equal(config.vars.QUEUE_FINAL_CONCURRENCY, '3')
})

