'use strict'

function intEnv(name, fallback) {
  const value = Number(process.env[name] || fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

module.exports = {
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  tokenSecret: process.env.SMARTSUBS_SECRET || process.env.TRANSLATION_TOKEN_SECRET || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  geminiTimeoutMs: intEnv('GEMINI_TIMEOUT_MS', 30000),
  geminiRetries: intEnv('GEMINI_RETRIES', 2),
  geminiRetryBaseMs: intEnv('GEMINI_RETRY_BASE_MS', 1000),
  subtitleTimeoutMs: intEnv('SUBTITLE_TIMEOUT_MS', 15000),
  maxSubtitleBytes: intEnv('MAX_SUBTITLE_BYTES', 2 * 1024 * 1024),
  translationChunkItems: intEnv('TRANSLATION_CHUNK_ITEMS', 180),
  translationChunkChars: intEnv('TRANSLATION_CHUNK_CHARS', 24000),
  translationConcurrency: intEnv('TRANSLATION_CONCURRENCY', 2)
}
