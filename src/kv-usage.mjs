/** Per-invocation KV operation accounting. No KV reads/writes are made by this module. */
import { randomUUID } from 'node:crypto'

const METHODS = ['get', 'put', 'list', 'delete']
const CATEGORIES = ['translation-cache', 'queue-state', 'diagnostics', 'other']

export function normaliseMedia(media) {
  if (!media || !['movie', 'series'].includes(media.type)) return null
  const id = String(media.id || '')
  if (!id || id.length > 128 || !/^[\w:.-]+$/.test(id)) return null
  const result = { type: media.type, id }
  if (media.type === 'series') {
    const match = id.match(/:(\d+):(\d+)$/)
    if (match) {
      result.season = Number(match[1])
      result.episode = Number(match[2])
    }
  }
  return result
}

function categoryFor(method, keyOrOptions) {
  const key = method === 'list' ? String(keyOrOptions?.prefix || '') : String(keyOrOptions || '')
  if (key.startsWith('diag:v1:')) return 'diagnostics'
  if (key.startsWith('job:v1:')) return 'queue-state'
  if (/^[a-f0-9]{64}$/.test(key)) return 'translation-cache'
  return 'other'
}

function emptyCounts() {
  return { get: 0, put: 0, list: 0, delete: 0 }
}

export function createKvUsageTracker({ phase = 'other', media = null, attempt = null, logger = console.log } = {}) {
  const counts = { attempted: emptyCounts(), succeeded: emptyCounts(), failed: emptyCounts() }
  const categories = Object.fromEntries(CATEGORIES.map(name => [name, emptyCounts()]))
  const tracker = {
    requestId: randomUUID(),
    phase,
    attempt,
    media: normaliseMedia(media),
    cacheResult: null,
    configId: null,
    setConfigId(value) { this.configId = /^[a-f0-9]{16}$/.test(String(value || '')) ? String(value) : null },
    setMedia(value) { this.media = normaliseMedia(value) },
    setCacheResult(value) { this.cacheResult = String(value || '').slice(0, 40) || null },
    wrap(kv) {
      if (!kv) return kv
      const result = {}
      for (const method of METHODS) {
        if (typeof kv[method] !== 'function') continue
        result[method] = async (...args) => {
          const category = categoryFor(method, args[0])
          counts.attempted[method]++
          categories[category][method]++
          try {
            const value = await kv[method](...args)
            counts.succeeded[method]++
            return value
          } catch (error) {
            counts.failed[method]++
            throw error
          }
        }
      }
      return result
    },
    snapshot() {
      return {
        tag: 'SMARTSUBS_KV_USAGE',
        v: 1,
        requestId: this.requestId,
        timestamp: new Date().toISOString(),
        phase: this.phase,
        attempt: this.attempt,
        media: this.media,
        mediaKnown: Boolean(this.media),
        cacheResult: this.cacheResult,
        attempted: { ...counts.attempted },
        succeeded: { ...counts.succeeded },
        failed: { ...counts.failed },
        categories: Object.fromEntries(CATEGORIES.map(name => [name, { ...categories[name] }]))
      }
    },
    flush() {
      // One structured Worker log per invocation; no extra KV operations.
      try { logger(JSON.stringify(this.snapshot())) } catch {}
    }
  }
  return tracker
}

export function trackedEnvironment(env, tracker) {
  if (!env?.SMARTSUBS_CACHE) return { ...env, __kvUsageTracker: tracker }
  return {
    ...env,
    __kvUsageOriginal: env.SMARTSUBS_CACHE,
    __kvUsageTracker: tracker,
    SMARTSUBS_CACHE: tracker.wrap(env.SMARTSUBS_CACHE)
  }
}
