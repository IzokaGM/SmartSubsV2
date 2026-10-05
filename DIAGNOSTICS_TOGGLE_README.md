# SmartSubsV2 Diagnose — protected ON/OFF switch

This ZIP is a **patch**, not a full repository. Its paths start from the repository root. Apply it on top of the existing **SmartSubsV2 Diagnose Compact UI** version; it leaves all Queue, Gemini, translation cache, configured addon URL, KV Monitor and test-history settings unchanged.

## One-time setup

In Cloudflare Dashboard, open the **SmartSubsV2 Worker** → **Settings** → **Variables and Secrets** and add a **Secret** (not a plain text variable):

- Name: `SMARTSUBS_DIAG_ADMIN_KEY`
- Value: a unique password of **6–256 characters**. Six characters is the minimum accepted; a longer random key is safer against guessing. This is **not** your Gemini API key or SmartSubsV2 server secret.

Save/deploy the configuration. Do not add the secret value to this ZIP, GitHub, `wrangler.jsonc`, logs or a URL. Ensure the existing `SMARTSUBS_DELIVERY` Durable Object binding is deployed (the ZIP does not add or change bindings/migrations). Without the admin secret or DO binding, Diagnostics stays OFF and the switch is unavailable.

## Use

1. Open your configured SmartSubsV2 `/c/<YOUR_CONFIG_TOKEN>/diagnose` URL on the phone.
2. Enter the **admin key** and press **Turn ON** before starting a new playback/test. The key is sent in the HTTPS POST body and is not saved on the page or put in the URL.
3. When done, enter the key and press **Turn OFF**. The state is persisted separately for each configured SmartSubsV2 installation in the existing Durable Object.

Diagnostics is **OFF by default** until you explicitly turn it ON. OFF skips new **Diagnostics** KV writes and does not list/read old diagnostic history when opening the Diagnose page. Old records are not deleted; they expire under the existing 24-hour TTL. Re-enabling starts a new visible diagnostic session. This does **not** turn off Translation Cache KV, Queue Status KV, KV Usage Tracker, KV Monitor or other non-Diagnostics operations. Each incoming Worker/Queue invocation checks the switch using the existing Durable Object; these are DO operations, **not Workers KV operations**. An already-running request may finish writing an event after you switch OFF.

The configured addon URL by itself is **not** permission to switch recording ON/OFF: the separate Cloudflare admin key is required for every change. Anyone who already holds the configured addon URL may still view diagnostics **while ON**, as in the previous version; do not share the configured URL or admin key publicly.

This patch has been tested locally. A successful GitHub auto-apply or CI run does not establish that Cloudflare deployment/configuration is complete.
