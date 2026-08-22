# SmartSubsV2 Part 4.2: Auto Delivery Race Fix

Part 4.1 restored stable selected translation, but the last player retry and Queue
completion happened at almost the same time. The Worker's existing final cache
check could therefore miss the finished subtitle by a very small window.

Part 4.2 keeps the normal player wait at 9000 ms and adds one bounded 600 ms grace
wait followed by one final cache recheck when the Queue job is still active.

If the cache becomes ready during this grace window, SmartSubs returns VTT 200
immediately instead of returning 503 pending.

New Diagnose data:
- graceMs
- graceHit
- queue-grace-hit event

Expected successful flow:
translation-request
queue-join-start
queue-translation-complete
queue-grace-hit
translation-delivered

Unchanged:
- user-selected-stable profile
- concurrency 3
- chunkItems 160
- chunkChars 20000
- weak-native quota protection
- durable Queue
- persistent cache
- MYT diagnostics

