import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('player adaptive polling uses 6s then 1.5s then 3s by translation age', async () => {
  const {
    playerQueuePollPlan,
    playerQueuePollEarlyMs,
    playerQueuePollFastStartMs,
    playerQueuePollLateStartMs,
    playerQueuePollLateMs
  } = await import('../src/cloudflare-worker.mjs')
  const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
  const env = config.vars
  const startedAt = 100000

  assert.equal(playerQueuePollEarlyMs(env), 6000)
  assert.equal(playerQueuePollFastStartMs(env), 12000)
  assert.equal(playerQueuePollLateStartMs(env), 25000)
  assert.equal(playerQueuePollLateMs(env), 3000)

  assert.deepEqual(playerQueuePollPlan(env, { state: 'running', updatedAt: startedAt }, startedAt + 1000), {
    pollMs: 6000,
    boundaryMs: 11000,
    phase: 'early'
  })
  assert.deepEqual(playerQueuePollPlan(env, { state: 'running', updatedAt: startedAt }, startedAt + 15000), {
    pollMs: 1500,
    boundaryMs: 10000,
    phase: 'fast'
  })
  assert.deepEqual(playerQueuePollPlan(env, { state: 'running', updatedAt: startedAt }, startedAt + 26000), {
    pollMs: 3000,
    boundaryMs: 0,
    phase: 'late'
  })
})

test('player adaptive polling cuts checks for a normal 18s cold translation', async () => {
  const { waitForQueueCache } = await import('../src/cloudflare-worker.mjs')
  let now = 100000
  const startedAt = now
  const cache = {
    async get() {
      return now >= startedAt + 18000
        ? 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nSiap\n'
        : null
    }
  }
  const env = {
    QUEUE_JOIN_POLL_MS: '1500',
    PLAYER_QUEUE_POLL_EARLY_MS: '6000',
    PLAYER_QUEUE_POLL_FAST_START_MS: '12000',
    PLAYER_QUEUE_POLL_LATE_START_MS: '25000',
    PLAYER_QUEUE_POLL_LATE_MS: '3000',
    SMARTSUBS_CACHE: {
      async get() { return { state: 'running', updatedAt: startedAt } }
    }
  }

  const result = await waitForQueueCache({
    env,
    cache,
    cacheKey: 'e'.repeat(64),
    initialJob: { state: 'running', updatedAt: startedAt },
    maxWaitMs: 28000,
    playerAdaptivePolling: true,
    sleepFn: async ms => { now += ms },
    nowFn: () => now
  })

  assert.equal(result.outcome, 'hit')
  assert.equal(result.waitMs, 18000)
  assert.equal(result.polls, 6)
})

test('player adaptive polling slows back to 3s after translation age 25s', async () => {
  const { waitForQueueCache } = await import('../src/cloudflare-worker.mjs')
  let now = 119000
  const translationStartedAt = 100000
  const requestStartedAt = now
  const env = {
    QUEUE_JOIN_POLL_MS: '1500',
    PLAYER_QUEUE_POLL_EARLY_MS: '6000',
    PLAYER_QUEUE_POLL_FAST_START_MS: '12000',
    PLAYER_QUEUE_POLL_LATE_START_MS: '25000',
    PLAYER_QUEUE_POLL_LATE_MS: '3000',
    SMARTSUBS_CACHE: {
      async get() { return { state: 'running', updatedAt: translationStartedAt } }
    }
  }

  const result = await waitForQueueCache({
    env,
    cache: { async get() { return null } },
    cacheKey: 'f'.repeat(64),
    initialJob: { state: 'running', updatedAt: translationStartedAt },
    maxWaitMs: 28000,
    playerAdaptivePolling: true,
    sleepFn: async ms => { now += ms },
    nowFn: () => now
  })

  assert.equal(result.outcome, 'timeout')
  assert.equal(result.waitMs, 28000)
  assert.equal(now - requestStartedAt, 28000)
  assert.equal(result.polls, 12)
})

test('both player Queue join paths enable adaptive polling', () => {
  const source = fs.readFileSync(new URL('../src/cloudflare-worker.mjs', import.meta.url), 'utf8')
  const routeStart = source.indexOf('const translationMatch =')
  const routeEnd = source.indexOf("if (request.method === 'GET')", routeStart)
  const route = source.slice(routeStart, routeEnd)
  assert.equal((route.match(/playerAdaptivePolling: true/g) || []).length, 2)
})
