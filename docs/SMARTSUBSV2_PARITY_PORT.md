# SmartSubs parity with completed SmartSubsV2

This migration ports the completed SmartSubsV2 runtime improvements into
SmartSubs while preserving the original SmartSubs addon and Cloudflare resource
identity.

## Included improvements

- Release-aware English source diagnostics and friendly Diagnose UI.
- Release-aware native Malay ranking.
- Strong native Malay selection and quota-safe Malay Auto fallback policy.
- Stable user-selected translation profile with concurrency 3.
- Player Queue wait of 9000 ms plus a 600 ms final grace check.
- Strongly consistent Delivery Relay for the final translation handoff.
- Up to five ranked built-in English subtitle tracks.
- Malaysian Bahasa Melayu Gemini translation prompt.

## Preserved SmartSubs identity

- Addon ID: `community.smartsubs`.
- Addon name: `SmartSubs`.
- Worker name: `smartsubs`.
- Existing KV namespace and 180-day cache version.
- Queue name: `smartsubs-translation`.
- Existing rate-limit namespace IDs.
- Existing BYOK configuration and signed translation token formats.

Existing cached translations are not invalidated. The improved Gemini prompt is
used for new uncached translations.
