# SmartSubsV2 Part 3: Native Malay Safe Fallback

Part 3 protects sync quality and Gemini quota.

## Policy

If native Malay has strong sync evidence, SmartSubsV2 returns native Malay only and does not pretranslate with Gemini.

If native Malay has weak or limited sync evidence, SmartSubsV2 returns native Malay first plus a Malay Auto fallback. The Malay Auto track is not background-prefetched. Gemini starts only when the translated VTT is actually requested, which normally happens after the user selects Malay Auto.

If no native Malay exists, the existing aggressive Queue pretranslation remains enabled so Malay Auto can be ready quickly.

## Confidence evidence

Strong evidence includes an exact video hash, exact video size, or a large release-match score uplift.

A result around score 10020 at rank 1 has only a 20 point uplift and is therefore weak evidence, even if it is the best available candidate.

## Diagnose

All existing diagnostics remain. Part 3 additionally records:

- nativeConfidence
- nativeConfidenceReason
- nativeScoreUplift
- nativeDecision
- autoFallbackOffered
- autoPrefetch
- autoPrefetchReason
- geminiPrefetchAvoided
- englishConfidence
- englishConfidenceReason
- englishScoreUplift

The friendly Diagnose page also displays the Native Malay decision. Malaysia time, raw recent events, legacy verdict references, Queue, cache, Gemini timing, source timing, retry and failure fields remain available.
