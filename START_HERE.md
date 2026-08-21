# SmartSubs recreation starting point

This is the clean source package for the recreated SmartSubs `final-stable-m20r3` line.

## Deliberate safety change

Only one GitHub Actions workflow is active: `.github/workflows/ci.yml`.

It only checks syntax and runs the recovered regression tests. It does not:

- translate subtitles
- call Gemini
- call OpenSubtitles
- deploy to Cloudflare
- modify repository files
- commit or push changes
- run background jobs

SmartSubs runtime work belongs in Cloudflare, not GitHub Actions.

## Recovered runtime architecture

Stremio -> SmartSubs Cloudflare Worker -> OpenSubtitles v3 -> existing Malay or ranked English -> Gemini BYOK -> Malay WebVTT -> Cloudflare KV

The final recovered line can also use Cloudflare Queue for background pretranslation and Queue Join.

## Stage 1 validation

Run:

```bash
npm run check
npm test
```

Expected recovered regression result: 67 tests passed, 0 failed.

## Stage 2

After this source is uploaded to a fresh GitHub repository, configure the Cloudflare runtime bindings and secret. Do not put Gemini user keys in GitHub Secrets. SmartSubs is BYOK and stores a configured key inside an encrypted addon configuration token.

Required Cloudflare runtime pieces for the final recovered profile:

- `SMARTSUBS_SECRET` secret
- `SMARTSUBS_CACHE` KV binding
- `SMARTSUBS_TRANSLATION_QUEUE` Queue producer binding
- queue `smartsubs-translation`
- `SMARTSUBS_SUBTITLE_LIMITER` rate limiter
- `SMARTSUBS_GENERATE_LIMITER` rate limiter

The account-specific IDs in `wrangler.jsonc` must be replaced or configured in Cloudflare before live deployment.
