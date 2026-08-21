import crypto from 'node:crypto'
import { translateSubtitleUrl } from './translator.js'

const inFlight = new Map()

export function makeCacheKey(sourceUrl, model, version = 'm8-v1', sourceId = '') {
  const identity = String(sourceId || sourceUrl || '')
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      identity,
      model: String(model || ''),
      version: String(version || '')
    }))
    .digest('hex')
}
function validKey(key) {
  return /^[a-f0-9]{64}$/.test(String(key || ''))
}

export class CloudflareTranslationCache {
  constructor(options = {}) {
    this.kv = options.kv || null
    this.ttlMs = Math.max(60000, Number(options.ttlMs || 180 * 24 * 60 * 60 * 1000))
    this.version = String(options.version || 'm8-v1')
    this.memory = new Map()
    this.counters = { memoryHits: 0, kvHits: 0, misses: 0, stores: 0, expired: 0 }
  }
  remember(key, value, expiresAt) {
    this.memory.delete(key)
    this.memory.set(key, { value, expiresAt })
    while (this.memory.size > 64) {
      this.memory.delete(this.memory.keys().next().value)
    }
  }
  async get(key) {
    if (!validKey(key)) throw new Error('Invalid translation cache key')
    const now = Date.now()
    const mem = this.memory.get(key)
    if (mem) {
      if (mem.expiresAt > now) {
        this.memory.delete(key)
        this.memory.set(key, mem)
        this.counters.memoryHits++
        return mem.value
      }
      this.memory.delete(key)
      this.counters.expired++
    }

    if (!this.kv) {
      this.counters.misses++
      return null
    }
    const entry = await this.kv.get(key, { type: 'json' })
    if (!entry) {
      this.counters.misses++
      return null
    }

    if (
      entry.v !== 1 ||
      entry.cacheVersion !== this.version ||
      typeof entry.value !== 'string' ||
      Number(entry.expiresAt) <= now
    ) {
      if (Number(entry.expiresAt) <= now) this.counters.expired++
      await this.kv.delete(key).catch(() => {})
      this.counters.misses++
      return null
    }
    this.remember(key, entry.value, Number(entry.expiresAt))
    this.counters.kvHits++
    return entry.value
  }

  async set(key, value) {
    if (!validKey(key)) throw new Error('Invalid translation cache key')
    const text = String(value || '')
    if (!text) throw new Error('Refusing to cache empty subtitle')
    const expiresAt = Date.now() + this.ttlMs
    const entry = {
      v: 1,
      cacheVersion: this.version,
      expiresAt,
      value: text
    }
    if (this.kv) {
      await this.kv.put(key, JSON.stringify(entry), {
        expirationTtl: Math.max(60, Math.floor(this.ttlMs / 1000))
      })
    }

    this.remember(key, text, expiresAt)
    this.counters.stores++
    return text
  }

  stats() {
    return {
      ...this.counters,
      memoryEntries: this.memory.size,
      version: this.version,
      persistent: Boolean(this.kv)
    }
  }
}

export async function cfGetOrTranslate(options = {}) {
  const cache = options.cache
  const upstreamUrl = String(options.upstreamUrl || '')
  const sourceId = String(options.sourceId || '')
  const model = String(options.model || '')
  const apiKey = String(options.apiKey || '')
  const cacheVersion = String(options.cacheVersion || cache?.version || 'm8-v1')
  const translateFn = options.translateFn || translateSubtitleUrl
  const translateOptions = options.translateOptions && typeof options.translateOptions === 'object'
    ? options.translateOptions
    : {}
  if (!cache) throw new Error('Translation cache is required')
  if (!upstreamUrl) throw new Error('Subtitle source URL is required')
  if (!model) throw new Error('Translation model is required')
  if (!apiKey) throw new Error('Gemini API key is required')

  const cacheKey = makeCacheKey(upstreamUrl, model, cacheVersion, sourceId)
  let cached = null
  try {
    cached = await cache.get(cacheKey)
  } catch {}
  if (cached) return { vtt: cached, cacheKey, status: 'HIT', translationStats: null }
  if (inFlight.has(cacheKey)) {
    const existing = inFlight.get(cacheKey)
    try {
      const joined = await existing
      return { ...joined, status: 'JOIN' }
    } catch {
      if (inFlight.get(cacheKey) === existing) inFlight.delete(cacheKey)
    }
  }

  const work = (async () => {
    let translationStats = null
    const vtt = await translateFn(upstreamUrl, {
      ...translateOptions,
      apiKey,
      model,
      onTranslationStats: stats => { translationStats = stats }
    })
    await cache.set(cacheKey, vtt).catch(() => {})
    return { vtt, cacheKey, status: 'MISS', translationStats }
  })()
  inFlight.set(cacheKey, work)
  try {
    return await work
  } finally {
    if (inFlight.get(cacheKey) === work) inFlight.delete(cacheKey)
  }
}

export function inFlightCount() {
  return inFlight.size
}
