# Roadmap

[English](roadmap.md) — Items deferred out of v0.1.x and tracked for future minor releases. This file is a lightweight queue; decisions move into `docs/concept.md` §11 and `docs/design/v0.2.0*` once accepted.

## v0.1.x — Frozen surface

The v0.1.x line keeps the contract published in [`docs/concept.md`](concept.md) §5 unchanged. Only bug fixes, documentation, and example additions land on v0.1.x.

## v0.2.x — Under consideration

The items below surface in real projects using minamo (notably a 11-Aggregate service sharing one DynamoDB table). They are **not committed** — each still needs a design document, a DEC entry, and acceptance against the §4 "設計の姿勢" (thin, strict, framework-free).

### 1. Aggregate-spanning `EventStoreTable` facade

**Motivation.** A shared DynamoDB table today requires one `EventStore<TMap>` instance per Aggregate type (11 in production use). The write side is already routed by `aggregateId`, so the duplication is pure boilerplate. A thin facade — e.g. `createEventStoreTable({ tableName, client }).for<CaseEvents>()` — would collapse the construction cost without relaxing the single-Aggregate `TMap` contract at the call site.

**Risk.** The facade must not hide the per-Aggregate `TMap` narrowing (DEC-004 / DEC-009). If the facade returns a heterogeneous `EventStore<Union>` it loses the single-stream invariant that `rehydrate` relies on.

**Status.** Exploratory. Needs a DEC and a concrete example before a v0.2 design doc.

### 2. First-party `createCommandRunner` utility

**Motivation.** `executeCommand` uses object params on purpose — optional extensions (`maxRetries`, `correlationId`, future additions) should not be breaking. But consumers with many handlers per Aggregate repeat `config` / `store` / `handler` at every call site. The [`examples/projected-event-store/command-runner.ts`](../examples/projected-event-store/command-runner.ts) recipe is three lines, so the library does not need to ship it. Still, a first-party utility would normalize the pattern and make ts-doc discoverable.

**Risk.** Promoting a utility to the public surface means owning its signature forever. The bar for crossing from recipe to core is "every non-trivial consumer writes it" — we need more than one reference project to justify that.

**Status.** Deferred. Revisit after more public consumers exist.

## Rejected (recorded to avoid re-litigation)

| Proposal | Rejection basis |
|---|---|
| append-time projection middleware on core `EventStore` | DEC-013 / DEC-014: projection layer is consumer-owned. Decorator pattern at [`examples/projected-event-store/`](../examples/projected-event-store/) covers the use case without expanding the core surface. |
| Event type naming enforcement / registry | DEC-009: naming convention is a consumer policy. Library enforcement would remove design freedom for shared-table disambiguation strategies. |
| immer (or other draft-proxy library) dependency | DEC-011: Aggregate state must stay plain data for `structuredClone` round-trip and DynamoDB marshalling. Consumers may use immer *inside* their `evolve` if they want; the contract stays plain. |

---

Last reviewed: 2026-04-18 (post v0.1.3 user feedback review).
