import test from 'node:test'
import assert from 'node:assert/strict'

const worker = await import('../src/cloudflare-worker.mjs')

const {
  queueRetryPolicy,
  queueTranslationOptions,
  queueTranslationProfile,
  handleQueue
} = worker

const finalEnv = {
  QUEUE_FINAL_CHUNK_ITEMS: '160',
  QUEUE_FINAL_CHUNK_CHARS: '20000',
  QUEUE_FINAL_CONCURRENCY: '5',
  QUEUE_FALLBACK_CHUNK_ITEMS: '180',
  QUEUE_FALLBACK_CHUNK_CHARS: '24000',
  QUEUE_FALLBACK_CONCURRENCY: '2'
}

test('first pure abort gets a 2s fast retry instead of immediate stable fallback', () => {
  assert.deepEqual(queueRetryPolicy(new Error('The operation was aborted'), 1), {
    delaySeconds: 2,
    retryMode: 'fast-transient',
    policy: 'fast-transient-retry'
  })

  assert.deepEqual(queueTranslationOptions(finalEnv, 2, '', 'fast-transient'), {
    maxItems: 160,
    maxChars: 20000,
    concurrency: 5
  })
  assert.equal(queueTranslationProfile(finalEnv, 2, '', 'fast-transient'), 'fast-transient-retry')
})

test('503 and 429 stay on conservative safe fallback policy', () => {
  assert.deepEqual(queueRetryPolicy(new Error('Gemini HTTP 503'), 1), {
    delaySeconds: 10,
    retryMode: 'safe-fallback',
    policy: 'server-safe-fallback'
  })
  assert.deepEqual(queueRetryPolicy(new Error('Gemini HTTP 429'), 1), {
    delaySeconds: 30,
    retryMode: 'safe-fallback',
    policy: 'rate-limit-safe-fallback'
  })

  assert.deepEqual(queueTranslationOptions(finalEnv, 2, '', 'safe-fallback'), {
    maxItems: 180,
    maxChars: 24000,
    concurrency: 2
  })
  assert.equal(queueTranslationProfile(finalEnv, 2, '', 'safe-fallback'), 'fallback-stable')
})

test('second failure exits fast retry and schedules safe fallback', () => {
  assert.deepEqual(queueRetryPolicy(new Error('The operation was aborted'), 2), {
    delaySeconds: 10,
    retryMode: 'safe-fallback',
    policy: 'second-failure-safe-fallback'
  })
})

test('queue handler persists fast retry mode and overrides retry delay to 2s', async () => {
  const writes = []
  const retries = []
  const cacheKey = 'a'.repeat(64)
  const env = {
    SMARTSUBS_CACHE: {
      async put(key, value, options) {
        writes.push({ key, value: JSON.parse(value), options })
      }
    }
  }
  const message = {
    attempts: 1,
    body: { cacheKey, configId: '0123456789abcdef' },
    retry(options) { retries.push(options) }
  }

  await handleQueue({ messages: [message] }, env, {
    processFn: async () => { throw new Error('The operation was aborted') }
  })

  assert.deepEqual(retries, [{ delaySeconds: 2 }])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].value.state, 'retrying')
  assert.equal(writes[0].value.retryMode, 'fast-transient')
  assert.equal(writes[0].value.attempts, 1)
})

test('diagnostics preserves retry mode and retry policy for recovery inspection', async () => {
  const diagnostics = await import('../src/diagnostics.js')
  const clean = diagnostics.default
    ? diagnostics.default.sanitiseEvent({ event: 'queue-retry-scheduled', retryMode: 'fast-transient', retryPolicy: 'fast-transient-retry' })
    : diagnostics.sanitiseEvent({ event: 'queue-retry-scheduled', retryMode: 'fast-transient', retryPolicy: 'fast-transient-retry' })
  assert.equal(clean.retryMode, 'fast-transient')
  assert.equal(clean.retryPolicy, 'fast-transient-retry')
})
