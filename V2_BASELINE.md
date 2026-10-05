# SmartSubsV2 clean baseline

Source of truth: `SmartSubs-main (14).zip` supplied on 2026-10-06.

SmartSubsV2 is intentionally a clean clone of that SmartSubs runtime. No code from the previous SmartSubsV2 repository was merged into this baseline. The only carried-over values are deployment identities needed to keep V2 isolated from production: addon ID/name, Worker name, KV namespace ID, Queue name, rate-limit namespace IDs, and Durable Object migration tag.

Old V2-only SubSource/fusion/probe features are not present. Any future feature added here should be treated as a new experiment on top of this clean baseline.
