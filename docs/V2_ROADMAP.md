# SmartSubsV2 roadmap

## Product target

1. Faster Malay subtitle availability.
2. Better Malay translation quality.
3. Better release matching and sync reliability.
4. Strong diagnostics for monitoring the whole pipeline.

## Development parts

0. Verified stable baseline.
1. Rank native Malay subtitles instead of accepting any Malay result.
2. Strengthen English source ranking and Malay versus English confidence.
3. Add context-overlap translation while preserving parallel speed.
4. Improve queue join and translation deduplication.
5. Improve exact-source caching and earliest possible pretranslation.
6. Expand diagnostics and performance monitoring.
7. Stability and real playback regression validation.

## Required final diagnostics

The final diagnose view should show, with secrets redacted:

- media/request identity
- Malay candidates considered
- English candidates considered
- selected source and selection reason
- release-match signals and confidence
- native Malay versus Malay Auto decision
- cache HIT, MISS or JOIN
- queue state
- source fetch time
- source bytes and cue count
- translation chunk count and concurrency
- Gemini call count and HTTP status classes
- translation timing
- retries and fallback cue count
- total subtitle pipeline time
- concise diagnosis of the slowest or failing stage
