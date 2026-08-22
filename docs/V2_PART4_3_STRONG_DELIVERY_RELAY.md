# SmartSubsV2 Part 4.3: Strong Delivery Relay

The live run completed Queue translation at 23:17:44 MYT, but the player
still received `translation-pending` at 23:17:46. The next KV hit arrived
only at 23:18:32. This is longer than the Part 4.2 grace window and matches
an eventually consistent KV negative read.

Part 4.3 keeps Workers KV as the 180-day cache and adds a 120-second
`TranslationDeliveryRelay` Durable Object for immediate cross-location
delivery. The relay expires automatically. It does not add Gemini calls.

Preserved settings: player wait 9000 ms, grace 600 ms, stable profile,
concurrency 3, quota protection, Queue serialization and MYT Diagnose.
