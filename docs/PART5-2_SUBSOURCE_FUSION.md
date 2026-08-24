# Part 5.2 Adaptive SubSource Fusion

Part 5.2 keeps OpenSubtitles v3 as the always-available baseline and uses optional SubSource only when current sync evidence can be improved.

## Decision policy

- Skip SubSource when OpenSubtitles already has strong native Malay and strong English release evidence.
- Query SubSource when native Malay is absent or weak, or when the best English source is not strongly matched.
- Merge Malay and English candidates from both providers into the existing release-aware ranker.
- Fall back immediately to OpenSubtitles on timeout, authentication failure, quota exhaustion, server error, missing media, or unexpected data.

SubSource release metadata can contain release names, framerate, production type, release type, downloads, rating, hearing-impaired state and archive size. It does not provide exact video hash or video file size, so Part 5.2 does not award hash evidence to SubSource candidates.

## Quota and cache policy

- Provider timeout: 2500 ms per API operation.
- IMDb to SubSource movie mapping: 30 days.
- Malay and English candidate lists: 6 hours.
- Extracted subtitle files: 7 days.
- Concurrent lookup deduplication: one in-flight lookup per key fingerprint and media episode.
- HTTP 429 circuit breaker: isolated by API-key fingerprint and retained until reset, bounded to one hour.

Only a one-way key fingerprint is used in cache keys. The SubSource API key is sent only in the `X-API-Key` request header.

## Download path

SubSource download responses are ZIP archives. SmartSubsV2 selects SRT or VTT first, selects the requested episode when an archive contains multiple episodes, converts ASS or SSA when needed, and serves the extracted subtitle through the configured Worker URL. The encrypted addon configuration token supplies the key at the Worker boundary. No plaintext key appears in the returned subtitle URL.

## Live validation

1. Play a title whose OpenSubtitles native Malay match is absent or weak.
2. Refresh Diagnose and confirm the latest `subsource-fusion` event is `connected`, `partial`, `not-needed`, or a safe fallback state.
3. Confirm Malay and English tracks load from the subtitle list.
4. Select a SubSource English track and confirm it loads without Gemini.
5. Select Malay Auto when offered and confirm translation delivery still uses the existing Queue and Delivery Relay path.
6. Test a second request for the same title and confirm SubSource cache becomes `HIT`.

Do not share the configured addon token or either API key in screenshots.
