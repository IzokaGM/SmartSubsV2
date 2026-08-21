'use strict'

const crypto = require('node:crypto')

function deriveKey(secret) {
  if (!secret) throw new Error('User config secret is not configured')
  return crypto.createHash('sha256').update(String(secret)).digest()
}

function createUserConfigToken(apiKey, options = {}) {
  const secret = options.secret || ''
  if (!secret) throw new Error('User config secret is not configured')
  const model = String(options.model || 'gemini-3.5-flash-lite')
  const iv = options.iv ? Buffer.from(options.iv) : crypto.randomBytes(12)
  if (iv.length !== 12) throw new Error('Invalid user config IV')
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv)
  const plaintext = Buffer.from(JSON.stringify({ v: 1, apiKey: String(apiKey || ''), model }), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.')
}

function decodeUserConfigToken(token, options = {}) {
  const secret = options.secret || ''
  const parts = String(token || '').split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid user config token')
  try {
    const iv = Buffer.from(parts[1], 'base64url')
    const ciphertext = Buffer.from(parts[2], 'base64url')
    const tag = Buffer.from(parts[3], 'base64url')
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv)
    decipher.setAuthTag(tag)
    const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    const data = JSON.parse(raw)
    if (!data || data.v !== 1 || typeof data.apiKey !== 'string') throw new Error('bad')
    return { apiKey: data.apiKey, model: String(data.model || 'gemini-3.5-flash-lite') }
  } catch {
    throw new Error('Invalid user config token')
  }
}

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16)
}

module.exports = { createUserConfigToken, decodeUserConfigToken, tokenFingerprint }
