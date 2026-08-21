# SmartSubsV2 Part 3.1: Selected Auto Queue Fix v2

The live Part 3 test proved quota protection works, but selecting Malay Auto could
leave the player waiting on a long synchronous Gemini request.

Part 3.1 changes only the selected Malay Auto delivery path.

## New flow

1. Check cache.
2. If an existing Queue job is active, wait up to 5 seconds.
3. If no job exists, selecting Malay Auto starts one deduplicated Queue job.
4. Wait up to 5 seconds for a fast Queue result.
5. If still translating, return HTTP 503 with Retry-After 3.
6. The Cloudflare Queue continues independently.
7. A later player retry or manual re-selection receives the cached VTT.
8. Synchronous Gemini remains only as a last-resort fallback when Queue cannot run
   or a Queue job fails.

This preserves the Part 3 quota rule. Weak native Malay does not trigger Gemini in
the background. Gemini starts only after Malay Auto is selected.

Diagnose adds:

- player-translation-queued
- translation-pending
- TRANSLATION_PREPARING_IN_QUEUE

All previous Malaysia time, source selection, Queue, cache, Gemini timing, retry,
failure, verdict-reference and raw-event diagnostics remain available.
