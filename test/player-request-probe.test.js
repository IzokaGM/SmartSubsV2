import test from 'node:test'
import assert from 'node:assert/strict'

test('player request probe records useful metadata but excludes secrets', async () => {
  const { translationRequestProbe } = await import('../src/cloudflare-worker.mjs')
  const request = new Request('https://example.test/c/SECRET/translated/TOKEN.vtt', {
    headers: {
      'user-agent': 'VUEO-Test/1.0 ExoPlayer',
      'range': 'bytes=0-4095',
      'accept': 'text/vtt,*/*',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'authorization': 'Bearer must-not-log',
      'cookie': 'session=must-not-log',
      'origin': 'https://must-not-log.example',
      'referer': 'https://must-not-log.example/c/SECRET'
    }
  })

  const probe = translationRequestProbe(request)
  assert.equal(probe.probeVersion, 'request-probe-v1')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.requestKind, 'range')
  assert.equal(probe.userAgent, 'VUEO-Test/1.0 ExoPlayer')
  assert.equal(probe.range, 'bytes=0-4095')
  assert.equal(probe.accept, 'text/vtt,*/*')
  assert.equal(probe.cacheControl, 'no-cache')
  assert.equal(probe.pragma, 'no-cache')
  assert.equal(probe.secFetchMode, 'cors')
  assert.equal(probe.secFetchDest, 'empty')
  assert.match(probe.requestSignature, /^[a-f0-9]{12}$/)

  const serialized = JSON.stringify(probe)
  assert.doesNotMatch(serialized, /must-not-log|SECRET|TOKEN|authorization|cookie|origin|referer/i)
})

test('identical duplicate GET metadata has the same request signature', async () => {
  const { translationRequestProbe } = await import('../src/cloudflare-worker.mjs')
  const headers = { 'user-agent': 'VUEO-Test/1.0', accept: '*/*' }
  const first = translationRequestProbe(new Request('https://example.test/a', { headers }))
  const second = translationRequestProbe(new Request('https://example.test/b', { headers }))

  assert.equal(first.requestSignature, second.requestSignature)
  assert.equal(first.requestKind, 'full')
})

test('Range request gets a different signature from a full GET', async () => {
  const { translationRequestProbe } = await import('../src/cloudflare-worker.mjs')
  const full = translationRequestProbe(new Request('https://example.test/a', {
    headers: { 'user-agent': 'VUEO-Test/1.0', accept: '*/*' }
  }))
  const ranged = translationRequestProbe(new Request('https://example.test/a', {
    headers: { 'user-agent': 'VUEO-Test/1.0', accept: '*/*', range: 'bytes=0-' }
  }))

  assert.notEqual(full.requestSignature, ranged.requestSignature)
  assert.equal(ranged.requestKind, 'range')
})
