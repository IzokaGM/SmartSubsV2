'use strict'

const crypto = require('node:crypto')

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}
function fromB64url(input) {
  return Buffer.from(String(input || ''), 'base64url')
}
function key(secret) {
  if (!secret) throw new Error('Translation token secret is not configured')
  return crypto.createHash('sha256').update(String(secret)).digest()
}
function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', key(secret)).update(payloadB64).digest('base64url')
}

function createTranslationToken(url, secret, sourceId = '', media = null) {
  if (!url) throw new Error('Subtitle URL is required')
  const info = media && ['movie', 'series'].includes(media.type) && /^[\w:.-]{1,128}$/.test(String(media.id || ''))
    ? { t: media.type, i: String(media.id) } : null
  const payload = b64url(JSON.stringify({ v: 1, u: String(url), i: String(sourceId || ''), ...(info ? { m: info } : {}) }))
  return `${payload}.${sign(payload, secret)}`
}

function decodeTranslationTokenData(token, secret) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2) throw new Error('Invalid translation token')
  const [payload, signature] = parts
  const expected = sign(payload, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid translation token')
  let value
  try { value = JSON.parse(fromB64url(payload).toString('utf8')) } catch { throw new Error('Invalid translation token') }
  if (!value || value.v !== 1 || typeof value.u !== 'string' || !/^https?:\/\//i.test(value.u)) {
    throw new Error('Invalid translation token')
  }
  const media = value.m && ['movie', 'series'].includes(value.m.t) && /^[\w:.-]{1,128}$/.test(String(value.m.i || ''))
    ? { type: value.m.t, id: String(value.m.i) } : null
  return { url: value.u, sourceId: String(value.i || ''), cacheId: String(value.i || value.u), media }
}

function decodeTranslationToken(token, secret) {
  return decodeTranslationTokenData(token, secret).url
}

module.exports = { createTranslationToken, decodeTranslationToken, decodeTranslationTokenData }
