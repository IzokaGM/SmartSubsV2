# SmartSubsV2 Part 4.5: Malaysian Translation Prompt

## Purpose

Part 4.5 improves the Gemini instruction used for Malay Auto subtitles. It asks
for concise, contemporary Malaysian Bahasa Melayu while preserving context,
tone, subtitle readability, formatting and cue identity.

## Quality controls

- Prefer contemporary Malaysian vocabulary and expressions.
- Avoid unintended Indonesian vocabulary and constructions.
- Select pronouns according to relationship, setting and tone.
- Preserve humour, emotion, profanity intensity and character voice.
- Keep subtitle text concise and avoid unnecessary line expansion.
- Preserve names, formatting tags, speaker markers and musical symbols.
- Translate meaningful sound descriptions and on-screen text.
- Return exactly one structured translation for every cue id.

## Preserved behaviour

- OpenSubtitles v3 remains the only upstream provider.
- Built-in English tracks remain enabled.
- The Gemini model and structured JSON response schema are unchanged.
- Translation chunk sizes, concurrency and retry behaviour are unchanged.
- User-selected translation profile remains `user-selected-stable`.
- Player Queue wait remains 9000 ms with a 600 ms grace check.
- Delivery Relay, cache policy and quota protection are unchanged.
