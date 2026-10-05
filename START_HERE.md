# SmartSubsV2 recreation starting point

This is the clean source package for the recreated SmartSubsV2 `final-stable-m20r3` line.

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

SmartSubsV2 runtime work belongs in Cloudflare, not GitHub Actions.

## Recovered runtime architecture

Stremio -> SmartSubsV2 Cloudflare Worker -> OpenSubtitles v3 -> existing Malay or ranked English -> Gemini BYOK -> Malay WebVTT -> Cloudflare KV

The completed parity line also uses Cloudflare Queue for background pretranslation, Queue Join, a final grace check, and a Delivery Relay for reliable player delivery. It returns ranked native Malay, Malay Auto when appropriate, and built-in English tracks.

## Stage 1 validation

Run:

```bash
npm run check
npm test
```

Expected parity regression result: 120 tests passed, 0 failed.

## Stage 2

After this source is uploaded to a fresh GitHub repository, configure the Cloudflare runtime bindings and secret. Do not put Gemini user keys in GitHub Secrets. SmartSubsV2 is BYOK and stores a configured key inside an encrypted addon configuration token.

Required Cloudflare runtime pieces for the final recovered profile:

- `SMARTSUBS_SECRET` secret
- `SMARTSUBS_CACHE` KV binding
- `SMARTSUBS_TRANSLATION_QUEUE` Queue producer binding
- queue `smartsubsv2-translation`
- `SMARTSUBS_SUBTITLE_LIMITER` rate limiter
- `SMARTSUBS_GENERATE_LIMITER` rate limiter
- `SMARTSUBS_DELIVERY` Durable Object binding

The account-specific IDs in `wrangler.jsonc` must be replaced or configured in Cloudflare before live deployment.
