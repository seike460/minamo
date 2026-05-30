---
"@seike460/minamo": minor
---

v1 に向けた機能拡充（CxO ラウンドテーブル診断 2026-05-30 に基づくスコープ拡大。docs/roadmap-v1.md / DEC-018〜024）。

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

> NOTE: docs/roadmap-v1.md はこれらを v0.2(ergonomics+observability) → v0.3(upcasting) → v0.4(snapshot) と段階リリースする想定。本ブランチは全機能を実装するため、メンテナの判断で単一 minor として出すか段階リリースに分割できる。
