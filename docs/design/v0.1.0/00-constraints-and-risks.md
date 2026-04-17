# 00 — Constraints & Risks

**Status**: Design baseline (v0.1.0 detailed design の前提集約)
**Scope**: 全 unit (U1〜U9) の設計判断に共通する不変制約とリスクを ID 化する
**Upstream**: `docs/concept.md` §3 Constraints, §8 Risks, §11 Decisions

---

## 1. 位置づけ

U1〜U9 の各 design doc は、この文書で ID 化された制約 (C-x) とリスク (R-x) を参照する。
本文書は **新しい制約を追加する場所ではなく、concept.md から派生した拘束条件の index** である。
新規制約を発見した場合は concept.md に先に追記し、ここは同期する。

---

## 2. Immutable Constraints (C-x)

concept.md §3 および §11 から派生する、設計判断を拘束する不変条件。

### C1. Runtime Target — Node.js 24+, ESM-only

- `package.json#engines.node >= 24`
- `"type": "module"` 固定、CJS dual は提供しない
- import specifier は `.js` 拡張子必須 (TypeScript `verbatimModuleSyntax: true`)
- 由来: CLAUDE.md、§9 前提条件、§12 サポート範囲

### C2. Runtime Dependency — AWS SDK v3 peer のみ

- `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/util-dynamodb` を `peerDependencies` + `peerDependenciesMeta.optional`
- DynamoEventStore 未使用の consumer に AWS SDK を強制しない
- その他の runtime dep (validation library, 時刻ライブラリ等) を **追加しない**
- 由来: concept.md §4 設計姿勢, §7 Alternatives, DEC-014

### C3. Standard Schema Dep は types-only の peer

- `@standard-schema/spec` を types-only として扱う。実装 library (Zod / Valibot / ArkType) は consumer 選択
- validate は minamo の内部 helper のみで、vendor lock を作らない
- 由来: DEC-015 候補 (docs/design/v0.1.0.md §6)

### C4. Version Model (DEC-007)

- 空ストリーム Aggregate.version = 0
- 永続化済 StoredEvent.version は 1 始まり
- `append` 成功 N 件後の Aggregate.version = expectedVersion + N
- `maxRetries` は「追加の再試行回数」。総試行上限 = 1 + maxRetries
- 由来: concept.md §5.4, DEC-007

### C5. Immutability Contract (DEC-008)

- 公開 API では `state` / `data` を `ReadonlyDeep<T>` で渡す
- `StoredEvent.data` と `executeCommand` の `newEvents` は `readonly` だが `ReadonlyDeep` は適用しない (Projection 側の narrow 自由度のため)
- runtime の `Object.freeze` は適用しない (deep freeze の再帰コストを避ける)
- 由来: DEC-008

### C6. Serialization Contract (DEC-011)

- `TState` / `TData` は structured-cloneable かつ DynamoDB marshallable な plain data
- 許可: object / array / string / number (finite) / boolean / null
- 禁止 (技術): Function, Symbol, DOM Node, NaN, ±Infinity
- 禁止 (方針): Date / Map / Set / BigInt / Buffer / class instance
- 禁止 (追加): 値としての `undefined` (DynamoDB marshall error か sparse loss)
- 由来: DEC-011

### C7. Handler Determinism (DEC-005 / DEC-010)

- `CommandHandler` 戻り値は `CommandResult<TMap>` (同期)。`Promise` を型で排除
- 非決定要素 (`Date.now`, `crypto.randomUUID`, 環境変数, I/O) は handler に書かず `input` 経由で注入
- retry-safe: 同じ `aggregate` と `input` に対し同じ event 列 / 同じ例外を返す
- 由来: DEC-005, DEC-010

### C8. Retry Scope (DEC-012)

- `executeCommand` の再試行対象は `ConcurrencyError` のみ
- handler が throw した例外 / AWS SDK のエラー / InvalidEventStreamError は再試行せず伝播
- 即時リトライ。backoff/jitter なし (`retryStrategy` option は v0.2.0+ の余地として保留)
- 由来: DEC-012

### C9. Event Store Fresh-Read 契約

- `load()` は「直前に成功した `append` の結果を観測できる」ことを保証する (fresh read)
- 実現方法は実装責務 (DynamoDB は `ConsistentRead: true`、InMemory は同期 Promise)
- 由来: concept.md §5.4

### C10. Aggregate Stream 排他性

- 1 回の `append` は単一 `aggregateId` を対象とする
- cross-aggregate transaction は API として提供しない (利用者が minamo の外で行う)
- 由来: DEC-003

### C11. DynamoDB Storage Shape

- PK: `aggregateId` (String)、SK: `version` (Number)
- `StreamViewType: NEW_IMAGE` 前提 (Projection Bridge 要件)
- 由来: concept.md §5.8 / §9 Step 2

### C12. DynamoDB Transaction Limits

- `TransactWriteItems` 上限: 100 操作 / 4MB
- Item size 上限: 400KB
- append は ConditionCheck 1 件 + Put N 件 → N ≤ 99
- 由来: concept.md §3, §8 (fact tag 2024-11 で 25→100 に引き上げ済み)

### C13. Projection Bridge 契約 (DEC-013)

- `parseStreamRecord` は strict-by-default。未知 type は `InvalidStreamRecordError(reason="unknown_type")`
- `ignoreUnknownTypes: true` は複数 Aggregate 共有テーブル専用 opt-in
- aggregateId による routing は行わない (type-only routing)
- `data` は `unknown` として返し、payload schema 検証はスコープ外
- 由来: DEC-013

### C14. AWS プリミティブ非ラップ (DEC-014)

- EventBridge / Step Functions / CDK / Lambda ESM 設定をラップしない
- 提供するのは Write 側 (DynamoEventStore) と 1 レコード正規化 (parseStreamRecord) のみ
- 由来: DEC-014

---

## 3. Implementation Risks (R-x)

concept.md §8 Risks から、v0.1.0 実装設計で明示的に緩和策を持つもの。

### R1. DynamoDB fresh-read の実現漏れ

- **影響**: `rehydrate` 前の `load` が stale を返すと、古い state で Decide し、ConcurrencyError を誤回避する
- **緩和**: U8 で `ConsistentRead: true` + `LastEvaluatedKey` pagination を必須。integration test で "append→load→assert latest version" を Contract として組み込む

### R2. Retry 再現性の崩壊 (non-deterministic handler)

- **影響**: handler が `Date.now` 等を使うと、ConcurrencyError 後の再実行で別 event が生成される
- **緩和**: DEC-010 を design doc 内で再掲。test double で `FailOnce` + "handler 呼び出しごとに同一 input で同一 event を返す" assertion を Contract Tests に含める

### R3. TransactWriteItems アトミック性の誤設計

- **影響**: ConditionCheck を別トランザクションにすると、version ギャップが発生
- **緩和**: U8 で TransactWriteItems 1 回に "ConditionCheck (head) + Put (N events)" を束ねる。pseudocode で明示。境界テストで N=99 を pass

### R4. BatchWriteItem への誤用

- **影響**: BatchWriteItem は ConditionExpression 非対応 (C12)、append に使うと楽観ロックが壊れる
- **緩和**: U8 の design doc に "BatchWriteItem は使用しない" を明記。code review 項目化

### R5. Marshal 設定差によるデータ欠損 (§8)

- **影響**: consumer が `removeUndefinedValues: true` を付けていないと `undefined` で marshall error
- **緩和**: U8 で推奨 `DynamoDBDocumentClient` 設定 (`removeUndefinedValues: true`, `convertEmptyValues: false`, `convertClassInstanceToMap: false`) を design doc に明示。DEC-011 plain data 制約と組み合わせる

### R6. InMemoryEventStore と DynamoEventStore の振る舞い差 (§1 痛み C)

- **影響**: テストが pass しても本番で壊れる
- **緩和**: Contract Tests suite (`test/contract/event-store.ts`) を U5 / U8 両方で走らせる。append/load/ConcurrencyError/EventLimitError/fresh-read を網羅

### R7. ProjectionBridge の順序前提破綻 (R §8 ParallelizationFactor)

- **影響**: `ParallelizationFactor > 1` でクロス Aggregate 順序が崩れる
- **緩和**: minamo の責務外だが U9 design doc に "idempotency key = `${aggregateId}:${version}`" を明示。ESM 推奨設定は doc で案内 (§9 Step 4 を参照)

### R8. Poison pill による Stream 停滞 (§8)

- **影響**: strict mode の `parseStreamRecord` が throw すると、ESM retry で後続レコードもブロック
- **緩和**: U9 design doc で "`BisectBatchOnFunctionError: true` + `MaximumRetryAttempts` + OnFailure destination + `ReportBatchItemFailures` の構成" を推奨として doc に入れる (コードでラップしない; DEC-014)

### R9. InvalidEventStreamError の診断情報不足

- **影響**: 壊れた stream を運用時にデバッグできない
- **緩和**: U7 で `InvalidEventStreamDetails` (eventIndex / expectedVersion / actualVersion / eventType 等) を必須記述。U6 rehydrate で reason 別の detail 生成点を pseudocode に明示

### R10. TS 型推論の EventMap 剥落

- **影響**: consumer が `CounterEvents = { Incremented: { amount: number } }` と書いたとき、handler の data 型が `unknown` に広がる
- **緩和**: U1 で `EventsOf<TMap>` / `StoredEventsOf<TMap>` の distributed conditional を明示。U3 handler でジェネリクスを `CommandHandler<TState, TMap, TInput>` として固定し、`NoInfer<TInput>` は検討中 (DEC 候補)

### R11. Retry count の off-by-one

- **影響**: `maxRetries=3` で 3 回しか試さない (初回を数え損ねる) 実装になる
- **緩和**: U6 で試行ループを "`for (let attempt = 0; attempt <= maxRetries; attempt++)`" で pseudocode 明示。unit test に `maxRetries=0` / `=3` / `=RangeError` ケースを固定 name で記述

### R12. structuredClone 失敗 (非 cloneable state)

- **影響**: consumer が Date / Map を state に入れると rehydrate が DataCloneError
- **緩和**: DEC-011 を U2 / U6 の design doc 冒頭に再掲 (C6 参照)。test doubles で意図的に non-cloneable state を入れて error 検出を確認する unit test を U6 に含める

### R13. ConcurrencyError の構造化情報不足

- **影響**: `cause chain` が無いと、RetryExhausted 時に最後の conflict 情報が失われる
- **緩和**: U7 で `RetryExhaustedError extends Error { cause: ConcurrencyError; attempts: number }` を定義 (ES2022 `cause` 準拠)

### R14. AWS SDK client 再利用漏れ

- **影響**: Lambda cold start 毎に TLS handshake → p99 レイテンシ悪化
- **緩和**: U8 design doc で "consumer は `DynamoDBDocumentClient` を module scope でシングルトン化する" を responsibility として明示。library 側で client を所有しない (DI)

### R15. EventLimitError の検出タイミング

- **影響**: N=100 を append 時に DynamoDB 側で `TransactionCanceledException` が出て、`ConcurrencyError` と誤判別される可能性
- **緩和**: U8 で pre-flight 検査 (`events.length > 99 → EventLimitError`, sum bytes > 4MB - slack → EventLimitError) を append 冒頭で実施。InMemory は size check を行わない (C12 + DEC-006)

### R16. ProjectionBridge の eventName narrowing 損失

- **影響**: `parseStreamRecord<TMap>(record, eventNames)` の戻り値 type が `keyof TMap & string` に narrow されないと consumer の if 分岐が type-safe にならない
- **緩和**: U9 で `TEventName extends keyof TMap & string = keyof TMap & string` ジェネリクスを必須とし、戻り値を `StoredEvent<TEventName, unknown> | null` にする。expectTypeOf で type-level test

---

## 4. 参照マトリクス

| Unit | 適用される C-x | 適用される R-x |
|---|---|---|
| U1 Core Types | C1, C5, C6 | R10 |
| U2 Aggregate | C1, C5, C6 | R12 |
| U3 Command | C1, C7 | R2, R10 |
| U4 EventStore I/F | C1, C4, C9, C10 | R6 |
| U5 InMemoryEventStore | C1, C4, C9, C10 | R6, R15 |
| U6 rehydrate+executeCommand | C1, C4, C5, C7, C8 | R1, R2, R9, R11, R12 |
| U7 Errors | C1 | R9, R13 |
| U8 DynamoEventStore | C1, C2, C4, C9, C10, C11, C12 | R1, R3, R4, R5, R14, R15 |
| U9 ProjectionBridge | C1, C13, C14 | R7, R8, R16 |

---

## 5. Out-of-scope for v0.1.0

以下は concept.md / v0.1.0.md で確認済み、design phase では扱わない:

- Snapshot, Event upcaster (§6 将来検討, OQ-1, OQ-2)
- backoff/jitter strategy (DEC-012, OQ-5)
- Global Tables 対応 (OQ-7)
- Saga / Process Manager / EventBridge Publisher / CDK Construct (DEC-014)
- Read Model の永続化・管理 (§6, DEC-013)
- Projection payload schema validation (§6, DEC-013)
- OpenTelemetry 実装 (v0.2.0; design doc では hook point の明示のみ)
- API Extractor の breaking change gate (v0.1.0.md §2, v0.2.0 導入)

---

## 6. Exit Criteria (この文書に対するもの)

- [x] concept.md §3 / §8 / §11 から派生する全制約が C-x として ID 化
- [x] 実装時に参照される全リスクが R-x として ID 化
- [x] 各 C / R に緩和方法または責任境界が記述されている
- [x] 各 Unit design doc が参照する C / R のマトリクスが示されている
