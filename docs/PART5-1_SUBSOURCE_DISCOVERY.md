# Part 5.1: Optional SubSource discovery

Part 5.1 establishes the optional SubSource provider boundary without changing SmartSubsV2 subtitle selection.

## Safety contract

- Gemini-only configuration tokens created before Part 5.1 remain valid.
- The optional SubSource API key is stored only inside the AES-256-GCM encrypted user configuration token.
- The key is sent to `https://api.subsource.net/api/v1` only through the `X-API-Key` request header.
- The key is never placed in a provider URL, diagnostic event, log entry, Queue message, or subtitle URL.
- Leaving the SubSource field blank keeps the completed OpenSubtitles-only behaviour.
- Part 5.1 never adds, removes, reorders, downloads, or translates a SubSource subtitle.

## Discovery probe

The configured Diagnose page includes **Test SubSource connection**. The probe calls the documented `GET /movies/{id}` endpoint using movie ID `1` and records only:

- connection classification and HTTP status;
- request duration;
- documented rate-limit response headers when present;
- names of returned JSON fields, without their values.

The result is reused for five minutes so repeated button presses do not consume another provider request.

## Deployment test

1. Deploy Part 5.1.
2. Open `/configure`.
3. Enter the Gemini key and the optional SubSource API key.
4. Install the newly generated SmartSubsV2 configured URL.
5. Open the configured Diagnose link.
6. Press **Test SubSource connection** once.
7. Refresh Diagnose and capture the **SubSource discovery** card and the `subsource-probe` raw event.

Do not paste or screenshot either API key. Diagnose is designed not to display them.

## Gate for Part 5.2

Adaptive provider fusion must remain disabled until the live probe confirms authentication, response structure, rate-limit header names, and provider availability. Search parameters, subtitle metadata, and download format still require a separate live schema discovery step because the public API overview does not document those response bodies in full.
