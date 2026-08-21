# SmartSubsV2 Part 4: Fast User Selected Auto

Part 4 speeds up only the translation that the user explicitly asks for.

## Why

The Part 3.1 live test completed 653 cues correctly, but the Queue translation took
about 27.8 seconds. The translation used five chunks with concurrency 3.

Part 4 keeps the same 160 cue and 20,000 character chunk profile, but lets the
user-selected Queue run up to four chunks concurrently.

## Isolation

Background and no-native pretranslation remain on the existing quota-safe-final
profile with concurrency 3.

Only the Queue job created from a real translated VTT request carries:

`profile = user-selected-fast`

First attempt:

- chunkItems 160
- chunkChars 20000
- concurrency 4

If Cloudflare Queue retries the job after a transient failure or Gemini pressure,
the same message automatically uses the existing fallback-stable profile:

- chunkItems 180
- chunkChars 24000
- concurrency 2

## Quota behaviour

Part 3 quota protection remains unchanged.

Weak native Malay does not trigger Gemini in the background. The fast profile is
used only after the user selects Malay Auto.

The number of normal chunks is not intentionally increased. For the 653 cue live
sample, the plan remains five chunks. Part 4 changes parallelism, not the amount of
subtitle content translated.

## Diagnose

Existing Queue diagnostics already preserve `profile`, `chunkItems`, `chunkChars`,
`concurrency`, Gemini call counts, statuses, prompt sizes, wall time, retries and
failures.

A successful Part 4 live run should show:

- profile=user-selected-fast
- concurrency=4
- chunks around the same count as before
- rateLimits=0 ideally
- lower translationWallMs than the Part 3.1 baseline

All Malaysia time and raw diagnostic events remain unchanged.
