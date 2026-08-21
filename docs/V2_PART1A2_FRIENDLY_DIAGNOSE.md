# SmartSubsV2 Part 1A.2: Friendly Diagnose

This patch changes the diagnose presentation only.

The top of the page now shows:

- a plain-English status
- the latest media request
- selected English subtitle ID and score
- sync confidence
- player metadata availability
- top English candidates
- cache status and delivery time
- cold translation timing when available
- a short recommendation explaining what to investigate

All timestamps are displayed in Malaysia time using the `Asia/Kuala_Lumpur` time zone and are labelled MYT.

The original diagnostic events remain available under a collapsed `Raw recent events` section.

No subtitle selection, OpenSubtitles, Gemini, Queue, cache, or translation behaviour is changed.
