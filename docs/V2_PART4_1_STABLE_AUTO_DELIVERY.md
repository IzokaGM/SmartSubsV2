# SmartSubsV2 Part 4.1: Stable Auto Delivery

Part 4 live testing showed that user-selected concurrency 4 was slower and less reliable than the Part 3.1 baseline. Two Gemini calls reached the 30 second abort timeout, causing seven Gemini calls and about 47 seconds total translation time.

Part 4.1 rolls the selected translation path back to concurrency 3.

It also increases the deployed player Queue wait from 5 seconds to 9 seconds. This stays below 10 seconds while giving Nuvio automatic retries a much better chance of remaining open when a roughly 28 second Queue translation finishes.

The selected Queue profile is renamed to `user-selected-stable`. Old `user-selected-fast` Queue messages are accepted and normalised to the stable profile.

Unchanged: weak native Malay still consumes no Gemini quota until Malay Auto is selected, Queue remains durable, cache remains persistent, no-native background pretranslation remains enabled, and all MYT Diagnose data remains available.
