# SmartSubsV2 Part 2: Native Malay Ranking

Part 2 improves native Malay source ordering without changing Gemini or English Auto selection.

When OpenSubtitles returns multiple Malay subtitles, SmartSubsV2 now ranks them using the same release-aware evidence already used for English:

- exact video hash when available
- exact video size when available
- source type such as WEB-DL, WEBRip, BluRay and Remux
- resolution
- codec
- HDR and Dolby Vision markers
- release group
- penalties for forced, SDH, commentary and lyrics tracks

If no useful metadata distinguishes the candidates, upstream ordering remains the tie breaker.

Part 2 does not yet compare native Malay confidence against English confidence. If native Malay exists, SmartSubsV2 still returns native Malay.

Diagnose now preserves:

- malayCandidateCount
- malaySelectedId
- malaySelectedScore
- malayTop

`malayTop` uses `rank:subtitle-id:score` format, matching the English diagnostics.
