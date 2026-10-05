# SmartSubsV2 repository instructions

Scope: this file applies to **SmartSubsV2** only.

## Baseline

- This repository is a clean clone of the latest supplied SmartSubs production source: `SmartSubs-main (14).zip`, baselined on 2026-10-06.
- SmartSubsV2 is the experimentation branch/repository. Runtime behaviour at baseline must match that SmartSubs source unless a new V2 experiment explicitly changes it.
- Do **not** copy code or features from older SmartSubsV2 repositories/ZIPs unless explicitly requested. In particular, do not reintroduce old V2-only SubSource/fusion/probe logic.
- Production SmartSubs and SmartSubsV2 must remain deployment-isolated: addon ID, Worker name, KV namespace, Queue name, rate-limit namespaces and Durable Object migration tag are intentionally distinct.

## Patch discipline

- Read the current repository before editing.
- Keep patches narrowly scoped to the requested experiment.
- Do not create patch-specific GitHub Actions workflows. Use the existing universal auto-apply workflow and CI workflow.
- Do not include build artifacts or `node_modules` in patch ZIPs.
- Run `npm run check` and `npm test` before handing off a patch.
