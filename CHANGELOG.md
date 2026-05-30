# minamo

## 0.2.0

### Minor Changes

- [#23](https://github.com/seike460/minamo/pull/23) [`0b8607d`](https://github.com/seike460/minamo/commit/0b8607dff9fc3719a36c3b0daf2e0172f271f142) Thanks [@seike460](https://github.com/seike460)! - v1 に向けた機能拡充（2026-05-30 の v1 設計レビューに基づくスコープ拡大。docs/roadmap-v1.md / DEC-018〜025）。

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

## 0.1.6

### Patch Changes

- [#21](https://github.com/seike460/minamo/pull/21) [`8a64398`](https://github.com/seike460/minamo/commit/8a64398f179d2e40037f106e9ecae8307c9288d0) Thanks [@seike460](https://github.com/seike460)! - ドキュメントの鮮度更新と開発ツールの整備。本体 API は変更なし。

  - README (英日) の Status 表記を版固定しない表現に更新し、CI status バッジを追加。`CLAUDE.md` の phase 記述を実態 (Released / v0.1.x maintenance) に合わせ、DynamoEventStore 実装済みの事実を反映。
  - vitest の coverage 計測 (`@vitest/coverage-v8`) を導入し、CI の unit test を coverage 付きに。型のみファイルは計測対象から除外。
  - `docs/concept.md` §7 Alternatives を再検証し最新化 (castore は core/adapter とも v2.4.2、@ocoda は v3.0.0)。事実が変わった差別化論点を「DynamoDB 専用設計 vs マルチ adapter」という構造的な軸に再構成。
  - `biome.json` の `$schema` を導入済み biome バージョンに同期。`CONTRIBUTING.md` に dependabot 運用フローを明記。

  npm tarball (`files: ["dist"]`) には影響しない docs + tooling の変更。

## 0.1.5

### Patch Changes

- [`3861f12`](https://github.com/seike460/minamo/commit/3861f122bc303227be71a94de2fabf6deab848b7) Thanks [@seike460](https://github.com/seike460)! - 「設計の境界」ドキュメントと projected-event-store recipe を追加。

  `README.md` / `README.ja.md` に "Design Boundaries" セクションを追加し、minamo 本体がやらないこと (projection 層のラッピング / event type 命名規約の enforce / immer 等 draft proxy への依存) と、その理由を明文化。v0.2.x 以降の検討項目 (Aggregate 横断 `EventStoreTable` facade / first-party `createCommandRunner`) は `docs/roadmap.md` に集約。

  `examples/projected-event-store/` を新設し、append 成功後に projection callback を同期実行する `EventStore<TMap>` Decorator と、`executeCommand` を Aggregate 別に curry する `createCommandRunner` の 2 つの consumer-side recipe を runnable + test 付きで提供。本体 API は変更なし。

  npm tarball (`files: ["dist"]`) には影響しない docs + examples + test の追加。

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
