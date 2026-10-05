import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('series player long-poll waits up to 30s while normal queue concurrency stays 5', async () => {
  const { playerQueueWaitMaxMs, playerQueueGraceMs } = await import('../src/cloudflare-worker.mjs')
  const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))

  assert.equal(config.vars.PLAYER_QUEUE_WAIT_MAX_MS, '30000')
  assert.equal(config.vars.PLAYER_MOVIE_QUEUE_WAIT_MAX_MS, '33000')
  assert.equal(config.vars.QUEUE_JOIN_POLL_MS, '1500')
  assert.equal(config.vars.QUEUE_FINAL_CONCURRENCY, '5')
  assert.equal(playerQueueWaitMaxMs(config.vars, 'series'), 30000)
  assert.equal(playerQueueWaitMaxMs(config.vars, 'movie'), 33000)
  assert.equal(playerQueueGraceMs(config.vars), 600)
  assert.equal(playerQueueWaitMaxMs(config.vars, 'series') + playerQueueGraceMs(config.vars), 30600)
  assert.equal(playerQueueWaitMaxMs({ PLAYER_QUEUE_WAIT_MAX_MS: 60000 }, 'series'), 30000)
})
