# minamo

## 0.1.4

### Patch Changes

- [`3f2f518`](https://github.com/seike460/minamo/commit/3f2f51819f427b046bd55048c2bf9ae78d0a1587) Thanks [@seike460](https://github.com/seike460)! - `examples/` を tsc 型チェック対象に追加（DX 改善）。

  `tsconfig.test.json` の `include` に `"examples"` を追加し、`@types/node` を devDependency として加えることで、`pnpm run type-check` と CI が examples/ の型を自動検証するようになった。v0.1.3 開発中に `EventStore.append` の引数順違反と DynamoDB Stream record の marshal shape 違反を runtime まで検出できなかった反省に対応。

  npm tarball (`files: ["dist"]`) には影響しない repo 内部 DX 変更。

## 0.1.3

### Patch Changes

- [`678228b`](https://github.com/seike460/minamo/commit/678228bfab6056429bc24ba3e67048e56e990f35) Thanks [@seike460](https://github.com/seike460)! - `examples/` を 2 本追加し、pitfalls.md / README から導線を張る。

  - `examples/multi-aggregate-projection/` — 複数 Aggregate を 1 Lambda で route する canonical パターン。`parseStreamRecord` + `eventNamesOf` による type-only routing (DEC-009 + DEC-013) の具体実装。Counter + Wallet の 2 Aggregate を同一 Stream に流した状態から read model を組み立てる。
  - `examples/dynamodb-local/` — `DynamoEventStore` を Docker 上の DynamoDB Local で append → load → `rehydrate` → 楽観的ロック衝突 (`ConcurrencyError`) まで E2E 検証する cookbook。テーブル create / delete は `setup.ts` に集約。

  docs/pitfalls.md §3 (英日) と README (英日) の Design セクションに example への導線を追加。

## 0.1.2

### Patch Changes

- [`30ac21a`](https://github.com/seike460/minamo/commit/30ac21a1fc3a0f0e0ad1d5758a963b60bc27997d) Thanks [@seike460](https://github.com/seike460)! - `docs/pitfalls.md` (英日) を追加。11 Aggregate の production 利用から得られた躓き事例を体系化:

  - `ReadonlyDeep<TState>` と array state の型衝突 → `ReadonlyArray<T>` 宣言推奨
  - 空 event payload は `Record<string, never>` ではなく optional field で
  - Projection layer の consumer 責務範囲と `ProjectedEventStore` wrapper パターン
  - 非決定値 (時刻 / UUID / seq) の `input` 注入
  - `@aws-sdk/*` peer dep ポリシーと `pnpm link:` 時の SDK drift 回避
  - Contract Tests のカバー範囲と projection timing の境界
  - `executeCommand` 自動リトライが `ConcurrencyError` 限定であること

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
