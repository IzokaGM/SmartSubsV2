# SmartSubsV2 Part 4.4: Built-in English Tracks

## Purpose

SmartSubsV2 already retrieves English subtitle candidates from OpenSubtitles v3
to select the source for Malay Auto. Part 4.4 returns those same ranked English
tracks in the SmartSubs subtitle list, so a separate OpenSubtitles v3 addon is
not required.

## Subtitle order

1. Native Malay tracks, when available.
2. Malay Auto, when offered by the existing policy.
3. Up to five ranked English tracks.

The English track ranked first is the same source selected for Malay Auto.
Duplicate English URLs are removed before ranking.

## Preserved behaviour

- OpenSubtitles v3 remains the only upstream provider.
- No additional upstream request is made.
- Weak-native quota protection remains unchanged.
- User-selected translation profile remains `user-selected-stable`.
- Translation concurrency remains 3.
- Player Queue wait remains 9000 ms with a 600 ms grace check.
- Delivery Relay and the 180-day KV cache remain unchanged.
- Translation tokens remain version 1.
