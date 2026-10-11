# Domain core migration

The files in `miniprogram/core/domain.ts` and `store.ts` remain the current local contract while R8 migrates the UI and data model. New server work must use the focused modules and must not dual-write old and new models.

## R8 supersession notice

The earlier M1/M2 plan treated local demo data as disposable. That assumption no longer applies. R8 preserves existing local projects and upgrades them through the reviewed migration contract in `../xhs_note/装修同步_R8-0C_迁移回滚与兼容方案_2026-10-08.md`.

- Keep `renovation-sync-state-v1` read-only during migration.
- Write the converted envelope to the separate v2 key, reload and validate it, then switch the active-schema pointer.
- After the switch, write only v2. Do not dual-write v1 and v2.
- Keep v1 and the pre-migration export through R8-6. A v2 state with new writes cannot be rolled back to writable v1 without an explicit, reviewed down-conversion.
- Ambiguous rooms, missing files, permissions, approvals and historical workflow facts must remain unresolved or compatible; migration must not invent them.

## Contract ownership

| Concern | New module | Legacy prototype |
| --- | --- | --- |
| decimal quantity and price | `precision.ts` | JavaScript `number` calculations |
| agreement history | `agreements.ts` | no persisted agreement aggregate |
| receipts and inventory | `material-flow.ts` | `Material` and `InventoryEntry` |
| purchase progress and estimates | `procurement.ts` | `materialEstimate` |
| issue workflow | `issue-flow.ts` | `Issue`, `Proposal`, `advanceIssue` |
| approvals, payments and refunds | `finance.ts` | `ExpenseEvent` |

## Conversion rules

- Quantities use integer thousandths. Convert user text with `parseQuantityMilli`; do not multiply an existing floating-point value during online writes.
- Unit prices use integer ten-thousandths of yuan. Each line is rounded to integer fen only after multiplying the original quantity and price.
- A legacy inventory `received` event becomes `available_received` only if it represents an owner-confirmed receipt allocation. Unreviewed arrivals become receipt batches and do not enter available inventory.
- Legacy issue status can be copied, but missing proposal, treatment and review history must be marked as imported history. Do not invent actors, evidence or review events.
- Legacy `quote` is not an approval. Approval events, pending payment facts, confirmed payments and refunds remain separate.
- Historical M2 notes treated prototype data as disposable. R8 supersedes that rule: existing data must follow the v1→v2 preservation and validation flow above.

## Compatibility boundary

The current pages continue to read `AppState` from `store.ts` so M1 does not create a half-migrated UI. M2 repositories expose only the new contracts. M4 replaces page flows one vertical slice at a time, then removes the corresponding legacy write path after its API and recovery tests pass.
