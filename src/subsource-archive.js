'use strict'

const { unzipSync, strFromU8 } = require('fflate')

const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024
const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024
const EXTENSION_SCORE = { srt: 40, vtt: 35, ass: 20, ssa: 20, sub: 5 }

function episodeScore(name, season, episode) {
  const value = String(name || '')
  const seasonNumber = Number(season || 0)
  const number = Number(episode || 0)
  if (!number) return 0
  const padded = String(number).padStart(2, '0')
  const seasonPattern = seasonNumber < 10 ? `0?${seasonNumber}` : String(seasonNumber)
  const episodePattern = number < 10 ? `0?${number}` : String(number)
  if (seasonNumber && new RegExp(`\\bs${seasonPattern}[ ._-]*e${episodePattern}\\b`, 'i').test(value)) return 200
  if (seasonNumber && new RegExp(`\\b${seasonPattern}x${episodePattern}\\b`, 'i').test(value)) return 200
  if (new RegExp(`\\be${padded}\\b`, 'i').test(value)) return 50
  return 0
}

function chooseSubtitleEntry(entries, season = 0, episode = 0) {
  const candidates = Object.entries(entries || {})
    .filter(([name, data]) => {
      const extension = String(name).split('.').pop().toLowerCase()
      return EXTENSION_SCORE[extension] && data && data.length > 0 && data.length <= MAX_SUBTITLE_BYTES
    })
    .map(([name, data]) => {
      const extension = String(name).split('.').pop().toLowerCase()
      return { name, data, extension, score: EXTENSION_SCORE[extension] + episodeScore(name, season, episode) }
    })
  if (!candidates.length) return null
  if (Number(season || 0) && Number(episode || 0)) {
    const exact = candidates.filter(item => episodeScore(item.name, season, episode) >= 200)
    const archiveHasSeasonEpisodes = candidates.some(item => /\bs\d{2}[ ._-]*e\d{2}\b|\b\d{1,2}x\d{2}\b/i.test(item.name))
    if (archiveHasSeasonEpisodes && !exact.length) return null
    if (exact.length) return exact.sort((a, b) => b.score - a.score || b.data.length - a.data.length)[0]
  }
  return candidates
    .sort((a, b) => b.score - a.score || b.data.length - a.data.length || a.name.localeCompare(b.name))[0] || null
}

function assTimestamp(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{2})$/)
  if (!match) return ''
  return `${String(match[1]).padStart(2, '0')}:${match[2]}:${match[3]},${match[4]}0`
}

function assToSrt(source) {
  const output = []
  for (const line of String(source || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!/^Dialogue:/i.test(line)) continue
    const parts = line.replace(/^Dialogue:\s*/i, '').split(',')
    if (parts.length < 10) continue
    const start = assTimestamp(parts[1])
    const end = assTimestamp(parts[2])
    if (!start || !end) continue
    const text = parts.slice(9).join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .trim()
    if (text) output.push(`${output.length + 1}\n${start} --> ${end}\n${text}`)
  }
  if (!output.length) throw new Error('SubSource archive has no usable timed subtitle')
  return `${output.join('\n\n')}\n`
}

function decodeSubtitle(data) {
  const utf8 = strFromU8(data)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('windows-1252').decode(data)
  } catch {
    return utf8
  }
}

function extractSubtitleArchive(bytes, season = 0, episode = 0) {
  const archive = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES) throw new Error('SubSource archive size is invalid')
  let entries
  let acceptedBytes = 0
  try {
    entries = unzipSync(archive, {
      filter(file) {
        const extension = String(file.name || '').split('.').pop().toLowerCase()
        const size = Number(file.originalSize || 0)
        if (!EXTENSION_SCORE[extension] || size <= 0 || size > MAX_SUBTITLE_BYTES) return false
        if (acceptedBytes + size > MAX_ARCHIVE_BYTES) return false
        acceptedBytes += size
        return true
      }
    })
  } catch {
    throw new Error('SubSource returned an invalid ZIP archive')
  }
  const chosen = chooseSubtitleEntry(entries, season, episode)
  if (!chosen) throw new Error('SubSource archive contains no supported subtitle file')
  const decoded = decodeSubtitle(chosen.data)
  const text = ['ass', 'ssa'].includes(chosen.extension) ? assToSrt(decoded) : decoded
  return {
    text,
    filename: chosen.name,
    contentType: chosen.extension === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8'
  }
}

module.exports = { chooseSubtitleEntry, assToSrt, decodeSubtitle, extractSubtitleArchive }
