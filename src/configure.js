'use strict'

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function buildConfiguredUrls(base, token) {
  const root = String(base || '').replace(/\/+$/, '')
  const configured = `${root}/c/${encodeURIComponent(token)}`
  const manifestUrl = `${configured}/manifest.json`
  return {
    configuredBaseUrl: configured,
    manifestUrl,
    installUrl: `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`
  }
}

async function validateGeminiApiKey(apiKey, options = {}) {
  const key = String(apiKey || '').trim()
  if (key.length < 20) throw new Error('Gemini API key looks invalid')
  const model = String(options.model || 'gemini-3.5-flash-lite')
  const fetchImpl = options.fetchImpl || fetch
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with OK.' }] }],
        generationConfig: { maxOutputTokens: 4 }
      })
    }
  )
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`)
  return true
}

function renderConfigurePage(options = {}) {
  const error = options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ''
  const result = options.manifestUrl
    ? `<div class="result"><p>SmartSubs is configured.</p><p><a href="${escapeHtml(options.installUrl || '')}">Install in Stremio</a></p><code>${escapeHtml(options.manifestUrl)}</code></div>`
    : ''
  const disabled = options.secretReady === false ? ' disabled' : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubs</title><style>:root{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#101116;color:#f4f4f5;margin:0}.wrap{max-width:680px;margin:auto;padding:24px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:20px}input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:10px;border-radius:10px}code{word-break:break-all}.error{color:#ffb4b4}a{color:#c9ffdc}</style></head><body><main class="wrap"><section class="card"><h1>SmartSubs</h1><p>Malay subtitles using OpenSubtitles v3 with Gemini BYOK fallback.</p>${error}<form method="post"><label>Gemini API key<input name="geminiApiKey" type="password" autocomplete="off" required${disabled}></label><button type="submit"${disabled}>Configure</button></form>${result}<p>Model: <code>${escapeHtml(options.model || '')}</code></p></section></main></body></html>`
}

module.exports = { escapeHtml, buildConfiguredUrls, validateGeminiApiKey, renderConfigurePage }
