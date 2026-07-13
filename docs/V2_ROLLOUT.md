# V2 Rollout Baseline

This branch is for the V2 platform rebuild. Production V1 remains on its current production branch and is tagged as `v1-stable-20260713`.

## Rules

- Do not merge V2 into the production branch until cutover is explicitly approved.
- Keep V2 behind feature flags until a canary test passes.
- Use additive database migrations only during V2 development.
- Do not delete, rename, or repurpose V1 columns until after a separate contract phase.
- Do not store secrets, tokens, raw entry tokens, or private keys in the repository.
- Do not run destructive cleanup against production data from this branch.

## Initial Flags

- `V2_PLATFORM_ENABLED`
- `V2_RUNTIME_MODE`
- `V2_OUTBOX_SHADOW_MODE`
- `V2_DRIVE_WORKER_DRY_RUN`
- `V2_RECONCILIATION_READONLY`

All flags are off by default.

## Shop Scope

The Shop repo remains responsible for course sales, course metadata, orders, payment proof uploads, and the initial source events that will later feed the V2 outbox.
