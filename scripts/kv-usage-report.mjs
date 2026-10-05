/** Aggregate downloaded SMARTSUBS_KV_USAGE log lines. Usage: node scripts/kv-usage-report.mjs kv-logs.jsonl */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('Usage: node scripts/kv-usage-report.mjs kv-logs.jsonl')
  process.exitCode = 1
} else {
  const entries = readFileSync(path, 'utf8').split(/\r?\n/)
  const seen = new Set()
  const totals = new Map()
  const fields = ['get', 'put', 'list', 'delete']
  let skipped = 0
  for (const line of entries) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { skipped++; continue }
    // Accept either raw structured Worker logs or pasted JSON wrappers.
    if (typeof row === 'string') {
      try { row = JSON.parse(row) } catch { skipped++; continue }
    }
    if (row?.tag !== 'SMARTSUBS_KV_USAGE' || !row?.requestId || !row?.attempted) {
      skipped++
      continue
    }
    if (seen.has(row.requestId)) continue
    seen.add(row.requestId)
    const media = row.media && ['movie', 'series'].includes(row.media.type) && row.media.id
      ? `${row.media.type}:${row.media.id}` : 'unknown (legacy token / unrelated request)'
    const group = totals.get(media) || {
      media, requests: 0, attempted: { get: 0, put: 0, list: 0, delete: 0 },
      failed: { get: 0, put: 0, list: 0, delete: 0 }, categories: {}
    }
    group.requests++
    for (const field of fields) {
      group.attempted[field] += Number(row.attempted[field] || 0)
      group.failed[field] += Number(row.failed?.[field] || 0)
    }
    for (const [name, counts] of Object.entries(row.categories || {})) {
      const category = group.categories[name] ||= { get: 0, put: 0, list: 0, delete: 0 }
      for (const field of fields) category[field] += Number(counts[field] || 0)
    }
    totals.set(media, group)
  }
  console.log(JSON.stringify({
    note: 'App-attributed KV API calls, not Cloudflare billing totals. Each phase/attempt is counted once.',
    uniqueInvocations: seen.size,
    ignoredOrUnrecognisedLines: skipped,
    byMedia: [...totals.values()].sort((a, b) => a.media.localeCompare(b.media))
  }, null, 2))
}
