'use strict'

const { getEnglishSubtitles, getMalaySubtitles } = require('./languages')

const SOURCE_PATTERNS = [
  ['webdl', /\bweb[ ._-]?dl\b/i],
  ['webrip', /\bweb[ ._-]?rip\b/i],
  ['bluray', /\bblu[ ._-]?ray\b|\bbluray\b/i],
  ['bdrip', /\bbd[ ._-]?rip\b/i],
  ['remux', /\bremux\b/i],
  ['hdtv', /\bhdtv\b/i],
  ['dvdrip', /\bdvd[ ._-]?rip\b/i],
  ['hdrip', /\bhd[ ._-]?rip\b/i]
]

const CODEC_PATTERNS = [
  ['x265', /\bx[ ._-]?265\b|\bhevc\b|\bh[ ._-]?265\b/i],
  ['x264', /\bx[ ._-]?264\b|\bh[ ._-]?264\b|\bavc\b/i],
  ['av1', /\bav1\b/i]
]

const RANGE_PATTERNS = [
  ['dolbyvision', /\bdolby[ ._-]?vision\b|\bdv\b/i],
  ['hdr10plus', /\bhdr10\+\b|\bhdr10plus\b/i],
  ['hdr10', /\bhdr10\b/i],
  ['hdr', /\bhdr\b/i]
]

const COMMON_EXTENSIONS = new Set(['mkv', 'mp4', 'avi', 'mov', 'm4v', 'srt', 'vtt', 'ass', 'ssa', 'sub'])

function normaliseText(value) {
  return String(value || '')
    .replace(/%20/gi, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function collectMetadataText(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 3) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value !== 'object' || seen.has(value)) return ''
  seen.add(value)

  if (Array.isArray(value)) {
    return value.slice(0, 40).map(item => collectMetadataText(item, depth + 1, seen)).filter(Boolean).join(' ')
  }

  return Object.entries(value)
    .slice(0, 80)
    .map(([key, item]) => `${key} ${collectMetadataText(item, depth + 1, seen)}`)
    .filter(Boolean)
    .join(' ')
}

function metadataText(subtitle) {
  return normaliseText(collectMetadataText(subtitle))
}

function findPatternToken(text, patterns) {
  const found = new Set()
  for (const [token, pattern] of patterns) {
    if (pattern.test(text)) found.add(token)
  }
  return found
}

function resolutions(text) {
  return new Set(Array.from(text.matchAll(/\b(2160p|1440p|1080p|720p|576p|480p)\b/gi), match => match[1].toLowerCase()))
}

function releaseGroup(value) {
  const source = String(value || '').trim()
  if (!source) return ''
  const noQuery = source.split(/[?#]/, 1)[0]
  const basename = noQuery.split(/[\\/]/).pop() || noQuery
  const withoutExt = basename.replace(/\.[a-z0-9]{2,5}$/i, '')
  const match = withoutExt.match(/-([a-z0-9][a-z0-9._]{1,24})$/i)
  if (!match) return ''
  const group = normaliseText(match[1]).replace(/\s+/g, '')
  return COMMON_EXTENSIONS.has(group) ? '' : group
}

function metadataValues(subtitle) {
  const values = []
  const seen = new Set()

  function visit(value, depth = 0) {
    if (value == null || depth > 3) return
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      values.push(String(value))
      return
    }
    if (typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 40)) visit(item, depth + 1)
      return
    }
    for (const item of Object.values(value).slice(0, 80)) visit(item, depth + 1)
  }

  visit(subtitle)
  return values
}

function exactMetadataMatch(subtitle, expected) {
  const target = String(expected || '').trim().toLowerCase()
  if (!target) return false
  return metadataValues(subtitle).some(value => String(value).trim().toLowerCase() === target)
}

function sourceMatchScore(requestText, candidateText) {
  const requested = findPatternToken(requestText, SOURCE_PATTERNS)
  const candidate = findPatternToken(candidateText, SOURCE_PATTERNS)
  if (!requested.size || !candidate.size) return 0
  for (const token of requested) {
    if (candidate.has(token)) return 900
  }
  return -650
}

function setMatchScore(requested, candidate, reward, conflictPenalty) {
  if (!requested.size || !candidate.size) return 0
  for (const token of requested) {
    if (candidate.has(token)) return reward
  }
  return -conflictPenalty
}

function contextFilename(context = {}) {
  return String(context.filename || context.fileName || context.file_name || '').trim()
}

function scoreEnglishSubtitle(subtitle, index = 0, context = {}) {
  const candidateText = metadataText(subtitle)
  let score = 10000 - index

  if (/\bforced\b/.test(candidateText)) score -= 5000
  if (/\b(sdh|hearing[ ._-]?impaired|hearing impaired)\b/.test(candidateText)) score -= 1500
  if (/\b(commentary|lyrics)\b/.test(candidateText)) score -= 3000
  if (/\b(utf[ ._-]?8|web[ ._-]?dl|web[ ._-]?rip|bluray|blu ray|bdrip)\b/.test(candidateText)) score += 20

  const filename = contextFilename(context)
  if (filename) {
    const requestText = normaliseText(filename)
    score += sourceMatchScore(requestText, candidateText)
    score += setMatchScore(resolutions(requestText), resolutions(candidateText), 350, 180)
    score += setMatchScore(
      findPatternToken(requestText, CODEC_PATTERNS),
      findPatternToken(candidateText, CODEC_PATTERNS),
      300,
      140
    )
    score += setMatchScore(
      findPatternToken(requestText, RANGE_PATTERNS),
      findPatternToken(candidateText, RANGE_PATTERNS),
      180,
      80
    )

    const requestedGroup = releaseGroup(filename)
    const candidateGroups = new Set(metadataValues(subtitle).map(releaseGroup).filter(Boolean))
    if (requestedGroup && candidateGroups.size) {
      score += candidateGroups.has(requestedGroup) ? 1200 : -120
    }
  }

  if (context.videoHash && exactMetadataMatch(subtitle, context.videoHash)) score += 12000
  if (context.videoSize && exactMetadataMatch(subtitle, context.videoSize)) score += 4000

  return score
}

function subtitleMatchConfidence(subtitle, index = 0, context = {}, score = null) {
  const actualScore = Number.isFinite(Number(score))
    ? Number(score)
    : scoreEnglishSubtitle(subtitle, index, context)
  const baseScore = 10000 - index
  const scoreUplift = actualScore - baseScore

  if (context.videoHash && exactMetadataMatch(subtitle, context.videoHash)) {
    return { level: 'STRONG', reason: 'exact-video-hash', scoreUplift }
  }

  if (context.videoSize && exactMetadataMatch(subtitle, context.videoSize)) {
    return { level: 'STRONG', reason: 'exact-video-size', scoreUplift }
  }

  if (scoreUplift >= 700) {
    return { level: 'STRONG', reason: 'strong-release-match', scoreUplift }
  }

  if (scoreUplift >= 250) {
    return { level: 'LIMITED', reason: 'partial-release-match', scoreUplift }
  }

  return { level: 'WEAK', reason: 'insufficient-sync-evidence', scoreUplift }
}

function rankEnglishSubtitles(subtitles, context = {}) {
  return getEnglishSubtitles(subtitles)
    .map((subtitle, index) => {
      const score = scoreEnglishSubtitle(subtitle, index, context)
      return {
        subtitle,
        score,
        confidence: subtitleMatchConfidence(subtitle, index, context, score)
      }
    })
    .sort((a, b) => b.score - a.score)
}

function scoreMalaySubtitle(subtitle, index = 0, context = {}) {
  return scoreEnglishSubtitle(subtitle, index, context)
}

function rankMalaySubtitles(subtitles, context = {}) {
  return getMalaySubtitles(subtitles)
    .map((subtitle, index) => {
      const score = scoreMalaySubtitle(subtitle, index, context)
      return {
        subtitle,
        score,
        confidence: subtitleMatchConfidence(subtitle, index, context, score)
      }
    })
    .sort((a, b) => b.score - a.score)
}

function selectBestMalay(subtitles, context = {}) {
  return rankMalaySubtitles(subtitles, context)[0]?.subtitle || null
}

function selectBestEnglish(subtitles, context = {}) {
  return rankEnglishSubtitles(subtitles, context)[0]?.subtitle || null
}

module.exports = {
  normaliseText,
  metadataText,
  releaseGroup,
  scoreEnglishSubtitle,
  subtitleMatchConfidence,
  rankEnglishSubtitles,
  selectBestEnglish,
  scoreMalaySubtitle,
  rankMalaySubtitles,
  selectBestMalay
}
