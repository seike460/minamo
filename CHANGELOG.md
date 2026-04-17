# minamo

## 0.1.1

### Patch Changes

- [`c0589e6`](https://github.com/seike460/minamo/commit/c0589e685ee2cc13b23869ac0d493d8666c92c6d) Thanks [@seike460](https://github.com/seike460)! - README を英訳し、日本語版を `README.ja.md` に分離。GitHub / npm 上で English / 日本語 両方の導線を提供。

## 0.1.0

### Minor Changes

- [`4fba532`](https://github.com/seike460/minamo/commit/4fba5329961e6d0a49a6098dd1932be44771250b) Thanks [@seike460](https://github.com/seike460)! - v0.1.0 initial release.

  Type-safe CQRS + Event Sourcing for AWS Serverless。minamo の公開 API は [`docs/concept.md`](../docs/concept.md) §5 API Design に逐字従属する。

  同梱する公開 symbol:

  - **Core types** — `DomainEvent` / `StoredEvent` / `EventMap` / `EventsOf` / `StoredEventsOf` / `Evolver` / `ReadonlyDeep`
  - **Aggregate** — `Aggregate<TState>` / `AggregateConfig<TState, TMap>`
  - **Command** — `CommandHandler<TState, TMap, TInput>` / `CommandResult<TMap>`
  - **EventStore interface** — `EventStore<TMap>` / `AppendOptions`
  - **InMemoryEventStore** — `EventStore` の Map-based 実装 (テスト / ローカル学習用)
  - **DynamoEventStore** — `EventStore` の DynamoDB 実装 (`DynamoEventStoreConfig`)
  - **rehydrate / executeCommand** — Load → Rehydrate → Decide → Append の全サイクルと再試行管理
  - **Errors** — `ConcurrencyError` / `EventLimitError` / `InvalidEventStreamError` / `InvalidStreamRecordError` / `ValidationError`
  - **Projection Bridge** — `parseStreamRecord` / `eventNamesOf` / `ParseStreamRecordOptions`
  - **Standard Schema v1** interface + `validate` helper

  主な設計原則:

  - concept.md §5 の型シグネチャと `src/` 実装が逐字一致
  - 新規 runtime 依存ゼロ (AWS SDK v3 は optional peer dependency)
  - Contract Tests が InMemoryEventStore / DynamoEventStore の両方で green
  - ESM only、Node ≥ 24、TypeScript strict + `verbatimModuleSyntax`

  Design docs:

  - [`docs/concept.md`](../docs/concept.md) — 設計思想と公開 API 仕様 (§5 / §11 Decisions)
  - [`docs/design/v0.1.0/`](../docs/design/v0.1.0/) — unit 別 detailed design (U1〜U9)
  - [`docs/design/v0.1.0.md`](../docs/design/v0.1.0.md) — implementation order + module structure
