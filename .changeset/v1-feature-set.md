---
"@seike460/minamo": minor
---

v1 に向けた機能拡充（2026-05-30 の v1 設計レビューに基づくスコープ拡大。docs/roadmap-v1.md / DEC-018〜025）。

すべて additive（既存 surface への breaking change なし）。retry 枯渇時の throw 型のみ変更（1 リリース deprecation を経た DEC-022）。

**Developer ergonomics + observability:**
- `createCommandRunner` — `config` / `store` を固定する first-party runner（DEC-023）
- `createEventStoreTable` — 1 DocumentClient を共有しつつ per-Aggregate に型 narrow する facade（DEC-023）
- `ExecuteObserver` — `executeCommand` のライフサイクル観測 hook（OTel 非依存。DEC-021）
- `NoInfer<TInput>` を `executeCommand` / runner に適用（handler の期待型が input で広がらない）

**retry 観測性:**
- `RetryExhaustedError { aggregateId, attempts, cause }` — retry 枯渇時に throw（v0.1.x は生の `ConcurrencyError`。DEC-022）

**スキーマ進化:**
- `AggregateConfig.upcast`（`Upcaster<TMap>`）— consumer 所有の transform で旧スキーマイベントを現行スキーマへ変換（DEC-020）

**長寿命 Aggregate:**
- `SnapshotStore<TState>` / `Snapshot<TState>` / `SnapshotPolicy` interface（EventStore とは独立。DEC-019）
- `InMemorySnapshotStore` / `DynamoSnapshotStore` 実装
- `EventStore.loadFrom?`（optional method）— snapshot からの部分 rehydration
- `executeCommand` に `snapshotStore` / `snapshotPolicy` を追加（snapshot 起点で rehydration を短縮）

**Tooling:**
- coverage 閾値を CI ゲート化

InMemory / Dynamo は Snapshot を含め同じ Contract Tests を通る。`files: ["dist"]` のため docs / examples の追加は npm tarball に影響しない。

> NOTE: v1 機能は単一 v0.2.0 で一括リリースする（DEC-025）。当初 roadmap-v1.md が想定した v0.2(ergonomics) → v0.3(upcasting) → v0.4(snapshot) の機能別段階リリースは、機能群が相互依存して実装・検証済みであることと運用負荷を踏まえ採らない。以後の v0.2 → v0.3 → v0.4 は「既存 surface 非破壊」を実証する安定性窓とする。
