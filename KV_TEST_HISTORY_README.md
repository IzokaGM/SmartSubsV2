# KV Monitor V1 English — manual test history

This patch builds on `SmartSubsV2-main (2).zip` plus `SmartSubsV2_KV_Monitor_v1_English_Patch.zip` (before the Delivery Fix). It changes **only** the KV Monitor UI, its own Durable Object storage routes, and regression tests. It does not change subtitle selection, translator, Gemini, queue, translation cache, diagnostics, Workers KV binding, or the established v1 usage publication path.

- **Start Test**: record a snapshot of existing 7-day aggregated KV usage for the configured addon token. One test can run at a time.
- Play one episode/movie in the player as usual; seeking and repeated requests contribute to the active test. Press **Refresh** to view a provisional delta.
- After finishing playback and allowing a few seconds for background queue/monitor updates, press **End Test**. The usage difference since Start is saved as a numbered test report, with per-episode and per-category breakdown.
- Start Test again for the **same** episode to get a new numbered report. Up to 20 test reports are retained for seven days. Existing cumulative episode reports are preserved in a separate collapsed section.
- No reset operation, no change to VUEO, no automatic session detection, no new Workers KV operations. Test baselines and saved reports are in the monitor's existing per-configuration Durable Object.

This is a manually bounded **measurement window**, not an exact VUEO player session. Operations from other videos/devices using the same configured token within the window can be included. Requests already running at Start, usage reports delivered late after End, or a queue still processing after End can affect attribution. End only after the relevant translation/queue work has finished and the monitor has received its reports. A monitor URL for an older/different config token shows different reports; use the matching configured addon URL. Do not share the token.
