# Roadmap

[English](roadmap.md) — Items deferred out of v0.1.x and tracked for future minor releases. This file is a lightweight queue; decisions move into `docs/concept.md` §11 and `docs/design/v0.2.0*` once accepted.

## v0.1.x — Frozen surface

The v0.1.x line keeps the contract published in [`docs/concept.md`](concept.md) §5 unchanged. Only bug fixes, documentation, and example additions land on v0.1.x.

## v0.2.x — Shipped in v0.2.0

The two items previously queued here graduated to the public surface in **v0.2.0** as first-party helpers (`docs/concept.md` §5.13, DEC-023). Both are thin wrappers over the existing API and preserve the per-Aggregate `TMap` contract at the call site.

### 1. Aggregate-spanning `EventStoreTable` facade — shipped

`createEventStoreTable(config).for<TMap>()` shares one `DocumentClient` across Aggregates while narrowing each call to a single-Aggregate `DynamoEventStore<TMap>` (not a heterogeneous `EventStore<Union>`), so the single-stream invariant that `rehydrate` relies on is preserved (DEC-004 / DEC-009 / DEC-023). The narrowing is gated by `expectTypeOf` type tests (`test/event-store-table.test.ts`).

### 2. First-party `createCommandRunner` utility — shipped

`createCommandRunner({ config, store, defaults })` fixes `config` / `store` and binds optional `defaults` (`maxRetries` / `observer` / `snapshotStore` / `snapshotPolicy`), collapsing the per-handler boilerplate. Call-site arguments override defaults (DEC-023). The [`examples/projected-event-store/command-runner.ts`](../examples/projected-event-store/command-runner.ts) recipe remains as the from-scratch illustration.

## Under consideration

The item below is **not committed** — it still needs a design document, a DEC entry, and acceptance against the §4 "設計の姿勢" (thin, strict, framework-free).

### `defineAggregate` type helper

A type helper that infers `EventMap` from `evolve` to reduce the explicit type-parameter boilerplate (`docs/concept.md` §6 "API Ergonomics"). **Status.** Deferred — crossing from backlog to core expands the public surface and needs a DEC plus more than one reference consumer to justify owning the signature.

## Rejected (recorded to avoid re-litigation)

| Proposal | Rejection basis |
|---|---|
| append-time projection middleware on core `EventStore` | DEC-013 / DEC-014: projection layer is consumer-owned. Decorator pattern at [`examples/projected-event-store/`](../examples/projected-event-store/) covers the use case without expanding the core surface. |
| Event type naming enforcement / registry | DEC-009: naming convention is a consumer policy. Library enforcement would remove design freedom for shared-table disambiguation strategies. |
| immer (or other draft-proxy library) dependency | DEC-011: Aggregate state must stay plain data for `structuredClone` round-trip and DynamoDB marshalling. Consumers may use immer *inside* their `evolve` if they want; the contract stays plain. |

---

Last reviewed: 2026-06-03 (v0.2.0 shipped — `EventStoreTable` facade + `createCommandRunner` moved from queue to "Shipped", DEC-023. §7 alternatives last re-verified 2026-05-30: castore core/adapter both v2.4.2, @ocoda v3.0.0).
