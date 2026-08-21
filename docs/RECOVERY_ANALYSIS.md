# SmartSubs Recovery Analysis

## Result

The supplied workflows contain enough information to recreate a functional SmartSubs repository and replay the later development history through the final stable line.

The final reconstructed build is:

`final-stable-m20r3`

The recovered regression suite contains 67 tests and all 67 pass in the reconstruction environment.

## What was recovered exactly

The following source was present directly as Base64 encoded file content in the supplied workflows:

- `src/subtitles.js` from the Malay Auto R2 workflow
- `src/diagnostics.js` from R2 and then M11
- `src/cloudflare-worker.mjs` from R2 and then M11
- `src/translator.js` from M11
- `src/cf-cache.mjs` from M11
- `src/selector.js` from M12
- recovered milestone tests from R2, M11, M12, M13, M14, M14.1, M15, M16, M17, M19, M20, and final stable

The supplied later workflows also contained exact Python patch programs. Those patch programs were replayed in this order:

1. M12 Smart Source
2. M13 Background Pretranslation
3. M14 R3 Fast Translation
4. M14.1 Prefetch Recovery
5. M15 Queue Prefetch
6. M16 Queue Join
7. M17 Parallel Translation
8. M19 R3 Performance Instrumentation
9. M20 Final Release
10. Final Stable R3

M18 was not present in the supplied files.

## Reconstructed supporting modules

The supplied workflows referenced these modules but did not contain their original complete bodies:

- `src/config.js`
- `src/configure.js`
- `src/configured-manifest.js`
- `src/languages.js`
- `src/manifest.js`
- `src/opensubtitles.js`
- `src/perf.js`
- `src/token.js`
- `src/user-config.js`
- the initial `package.json`
- the initial pre Queue `wrangler.jsonc`

These were reconstructed against the interfaces used by the exact recovered source and tests. They are functional replacements, not claimed to be byte for byte copies of the lost originals.

## Milestone findings

| Workflow | Recovered purpose |
| --- | --- |
| `smartsubs-ci-full-diagnose-r1.yml` | CI, syntax, tests, Wrangler dry run, diagnostic artifact flow |
| `smartsubs-apply-malay-auto-r2.yml` | Native Malay preference, English fallback, signed Malay Auto URL, diagnostics |
| `smartsubs-m11-translation-repair.yml` | Cue ID based Gemini response mapping, missing cue repair, safe fallback, translation cache stats |
| `smartsubs-m12-smart-source.yml` | Smart English source ranking using video hash, size, filename, source, resolution, codec, HDR, release group |
| `smartsubs-m13-background-pretranslation.yml` | Background pretranslation before player subtitle selection |
| `smartsubs-m14-fast-translation*.yml` | Gemini retry tuning, Retry-After support, minimal thinking, faster batching experiments |
| `smartsubs-m14-1-prefetch-recovery.yml` | Restored stable 180 cue and 24000 char defaults after aggressive M14 tuning |
| `smartsubs-m15-queue-prefetch.yml` | Moved background pretranslation to Cloudflare Queue |
| `smartsubs-m16-queue-join.yml` | Queue job state, dedupe, Queue Join, cache coordination, queue specific translation profile |
| `smartsubs-m17-parallel-translation.yml` | Three parallel Gemini chunks on first queue attempt, conservative retry fallback |
| `smartsubs-m19-performance-instrumentation*.yml` | Gemini latency, prompt size, status, chunk timeline, source fetch timing, queue delay, retry stage diagnostics |
| `smartsubs-m20-final-release.yml` | Public readiness checks, rate limits, security headers, final queue profile, safer malformed token handling |
| `smartsubs-final-stable-hotfix.yml` | First final stability pass, Abort retry work |
| `smartsubs-final-stable-r2.yml` | Per chunk Abort retry while preserving completed chunks |
| `smartsubs-final-stable-r3.yml` | Final stable profile at 160 cues, 20000 chars, concurrency 3 for first queue attempt |

The two files named `smartsubs-m19-performance-instrumentation.yml` and `smartsubs-m19-performance-instrumentation-1.yml` are byte identical. Their SHA-256 value is:

`89af4c01f0b36c642797f891934eb362470728fea92fef9f501fe335ff48da21`

## Key final behaviours

### Subtitle selection

- Existing Malay is preferred.
- Malay is normalised to Stremio language code `msa`.
- If Malay is missing, English candidates are ranked.
- Exact `videoHash` metadata match gets the strongest source bonus.
- Exact `videoSize` match gets another strong bonus.
- Filename metadata can reward matching source type, resolution, codec, HDR family, and release group.
- Forced, SDH, hearing impaired, commentary, and lyrics candidates are penalised.

### Translation repair

- Gemini results are matched by cue ID, not response order.
- Missing IDs are retried semantically.
- Only still missing cues fall back to source English text.
- A completely unusable Gemini response raises an error instead of silently returning an all English subtitle.

### Performance and quota control

- Translation is split into chunks.
- Queue first attempt uses three way parallel translation.
- A retry falls back to a more conservative profile.
- Queue consumer itself is serialized with `max_concurrency: 1`.
- A single aborted chunk can retry once without redoing already completed chunks.
- Rate limiters protect subtitle requests and Gemini generation.

### Cache and queue coordination

- Translation cache key is SHA-256 based.
- KV keeps translated VTT for the configured TTL.
- In process duplicate translation calls join one in flight promise.
- M16 adds persistent queue job states and Queue Join.
- If the player requests Malay Auto while a queue job is running, it waits for cache rather than starting another Gemini job.
- M20 avoids queue sends and KV job writes if the final translation is already cached.

### Diagnostics

The recovered worker records sanitized diagnostics and derives states such as:

- `NO_SUBTITLE_REQUEST_SEEN`
- `NO_ENGLISH_SOURCE_FOUND`
- `SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION`
- `PREFETCH_TRANSLATING`
- `QUEUE_PREFETCH_QUEUED`
- `QUEUE_JOIN_WAITING`
- `TRANSLATION_DELIVERED`
- `TRANSLATION_FAILED`

Sensitive values such as API keys and subtitle source URLs are excluded from saved diagnostics.

## Validation performed

- Every source and recovered test file passed `node --check`.
- All 67 recovered tests passed under Node 22.16.0 in the reconstruction environment.
- The supplied workflows targeted Node 24, so the code should also be tested under Node 24 before production deployment.
- Wrangler dry run could not be confirmed here because the Wrangler package fetch timed out.

## Confidence

High confidence:

- M11 through final stable translation, queue, cache, diagnostic, performance, and final profile logic
- M12 selector logic
- R2 Malay Auto behaviour
- the final `wrangler.jsonc` settings produced by the recovered patch chain

Moderate confidence:

- the exact original implementation of the supporting modules listed above, because their original complete file bodies were not embedded in the supplied recovery workflows

The reconstruction therefore aims to reproduce SmartSubs behaviour and recovered interfaces, not claim a byte for byte copy of the lost repository.
