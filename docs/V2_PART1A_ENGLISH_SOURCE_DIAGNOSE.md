# SmartSubsV2 Part 1A: English Source Diagnose

Part 1A changes observability only.

It does not change which English subtitle SmartSubs selects.

The configured Diagnose page now preserves:

- sourceFilenameProvided
- sourceVideoHashProvided
- sourceVideoSizeProvided
- sourceFilename
- requestExtraKeys
- englishCandidateCount
- englishSelectedId
- englishSelectedScore
- englishSelectionStable
- englishTop

`englishTop` contains up to five entries in `rank:subtitle-id:score` format.

This lets us determine whether an out-of-sync source is caused by missing player metadata or weak selector scoring before changing source-selection behaviour.
