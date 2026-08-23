'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createUserConfigToken, decodeUserConfigToken } = require('../src/user-config')
const { renderConfigurePage } = require('../src/configure')
const {
  API_BASE,
  responseShape,
  probeSubsourceApi,
  validateSubsourceApiKey
} = require('../src/subsource')
const { sanitiseEvent } = require('../src/diagnostics')

function legacyUserConfigToken(apiKey, options = {}) {
  const secret = String(options.secret || '')
  const iv = Buffer.from(options.iv || Buffer.alloc(12, 3))
  const key = crypto.createHash('sha256').update(secret).digest()
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify({
    v: 1,
    apiKey,
    model: options.model || 'gemini-legacy'
  }), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.')
}

function memoryKv() {
  const values = new Map()
  return {
    async put(key, value) { values.set(String(key), String(value)) },
    async get(key) { return values.get(String(key)) ?? null },
    async list(options = {}) {
      const prefix = String(options.prefix || '')
      return {
        keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name }))
      }
    }
  }
}

test('Part 5.1 encrypts the optional SubSource key and decodes it only from user configuration', () => {
  const secret = 'part5-user-config-secret'
  const geminiApiKey = 'gemini-secret-value-1234567890'
  const subsourceApiKey = 'subsource-secret-value-1234567890'
  const token = createUserConfigToken(geminiApiKey, {
    secret,
    model: 'gemini-test',
    subsourceApiKey,
    iv: Buffer.alloc(12, 7)
  })

  assert.equal(token.includes(geminiApiKey), false)
  assert.equal(token.includes(subsourceApiKey), false)
  assert.deepEqual(decodeUserConfigToken(token, { secret }), {
    apiKey: geminiApiKey,
    model: 'gemini-test',
    subsourceApiKey
  })
})

test('Part 5.1 keeps legacy Gemini-only configuration tokens valid', () => {
  const secret = 'part5-legacy-secret'
  const token = legacyUserConfigToken('legacy-gemini-key', { secret })
  assert.deepEqual(decodeUserConfigToken(token, { secret }), {
    apiKey: 'legacy-gemini-key',
    model: 'gemini-legacy',
    subsourceApiKey: ''
  })
})

test('Part 5.1 Configure makes SubSource optional and preserves OpenSubtitles-only mode', () => {
  const html = renderConfigurePage({ secretReady: true, model: 'gemini-test' })
  assert.match(html, /name="geminiApiKey"[^>]+required/)
  assert.match(html, /name="subsourceApiKey"/)
  assert.doesNotMatch(html, /name="subsourceApiKey"[^>]+required/)
  assert.match(html, /Leave blank to keep the current OpenSubtitles-only behaviour/)
})

test('Part 5.1 probes only the official API base with the key in a header', async () => {
  const key = 'subsource-test-key'
  let received
  const result = await probeSubsourceApi(key, {
    fetchImpl: async (url, options) => {
      received = { url, options }
      return new Response(JSON.stringify({ data: [{ id: 1, title: 'Example' }] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining-day': '7199'
        }
      })
    }
  })

  assert.equal(received.url, `${API_BASE}/movies/1`)
  assert.equal(received.options.headers['x-api-key'], key)
  assert.equal(received.url.includes(key), false)
  assert.equal(result.status, 'connected')
  assert.equal(result.remainingDay, '7199')
  assert.deepEqual(result.rateHeaderNames, ['x-ratelimit-remaining-day'])
  assert.deepEqual(result.responseTopKeys, ['data'])
  assert.deepEqual(result.responseItemKeys, ['id', 'title'])
})

test('Part 5.1 rejects authenticated SubSource failures but accepts quota state', async () => {
  await assert.rejects(
    validateSubsourceApiKey('subsource-test-key', {
      fetchImpl: async () => new Response('{}', {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }),
    /SubSource API key rejected/
  )

  const limited = await validateSubsourceApiKey('subsource-test-key', {
    fetchImpl: async () => new Response('{}', {
      status: 429,
      headers: { 'content-type': 'application/json' }
    })
  })
  assert.equal(limited.status, 'quota-limited')
})

test('Part 5.1 records response structure without retaining response values or secrets', () => {
  assert.deepEqual(responseShape({
    data: [{ id: 19, release: 'Private.Release.Name', uploader: 'Private User' }],
    page: 1
  }), {
    rootType: 'object',
    topKeys: ['data', 'page'],
    itemKeys: ['id', 'release', 'uploader']
  })

  const clean = sanitiseEvent({
    event: 'subsource-probe',
    apiKey: 'must-not-survive',
    responseBody: 'must-not-survive',
    subsourceConfigured: true,
    subsourceStatus: 'connected',
    subsourceResponseTopKeys: ['data', 'page']
  })
  assert.equal(clean.apiKey, undefined)
  assert.equal(clean.responseBody, undefined)
  assert.deepEqual(clean.subsourceResponseTopKeys, ['data', 'page'])
})

test('Part 5.1 Diagnose probe is cached for five minutes and does not change subtitles', async () => {
  const { handleRequest } = await import('../src/cloudflare-worker.mjs')
  const secret = 'part5-worker-secret'
  const token = createUserConfigToken('gemini-key-12345678901234567890', {
    secret,
    model: 'gemini-test',
    subsourceApiKey: 'subsource-key-1234567890',
    iv: Buffer.alloc(12, 9)
  })
  const kv = memoryKv()
  const originalFetch = global.fetch
  let calls = 0
  global.fetch = async url => {
    calls++
    assert.equal(String(url), `${API_BASE}/movies/1`)
    return new Response(JSON.stringify({ data: [{ id: 1, title: 'Probe' }] }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining-day': '7199'
      }
    })
  }

  try {
    const base = `https://smartsubsv2.example/c/${encodeURIComponent(token)}`
    const first = await handleRequest(new Request(`${base}/subsource-probe`, { method: 'POST' }), {
      SMARTSUBS_SECRET: secret,
      SMARTSUBS_CACHE: kv
    })
    const second = await handleRequest(new Request(`${base}/subsource-probe`, { method: 'POST' }), {
      SMARTSUBS_SECRET: secret,
      SMARTSUBS_CACHE: kv
    })
    assert.equal(first.status, 303)
    assert.equal(second.status, 303)
    assert.equal(calls, 1)

    const diagnose = await handleRequest(new Request(`${base}/diagnose`), {
      SMARTSUBS_SECRET: secret,
      SMARTSUBS_CACHE: kv
    })
    const html = await diagnose.text()
    assert.match(html, /SubSource discovery/)
    assert.match(html, /connected/)
    assert.match(html, /day remaining 7199/)
    assert.match(html, /does not expose the API key or change subtitle ranking/)
  } finally {
    global.fetch = originalFetch
  }
})
