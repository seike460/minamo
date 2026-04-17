# U4 — EventStore Interface

**Upstream**: concept.md §5.4 EventStore
**Depends on**: U1
**Applied constraints**: C1, C4, C9, C10
**Applied risks**: R6

---

## 1. Unit 定義

EventStore の抽象 interface と `AppendOptions` を定義する。U5 InMemoryEventStore / U8 DynamoEventStore の実装契約。Contract Tests の対象 API。

---

## 2. 公開 API (concept.md §5.4 逐字)

```ts
/**
 * Event Store の抽象インターフェース。
 * 単一 Aggregate ストリームの append/load 契約だけを定義する。
 * TMap で型を貫通させ、入出力を型安全にする。
 * 件数上限・サイズ上限・fresh read の実現方法などの実装詳細は各実装の責務。
 *
 * Version Model:
 * - version は Aggregate ごとのローカル連番であり、グローバル連番ではない
 * - 空のストリームの Aggregate.version は 0
 * - 永続化済みイベントの version は 1 始まり
 * - expectedVersion は append 開始時点の Aggregate.version を表す
 * - append で N 件成功した後の Aggregate.version は expectedVersion + N
 * - append の返り値は expectedVersion + 1 から expectedVersion + N までの連番になる
 */
export interface EventStore<TMap extends EventMap> {
  append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;

  load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
}

/** append のオプション */
export interface AppendOptions {
  readonly correlationId?: string;
}
```

---

## 3. Module 配置

- `src/event-store/types.ts` — 新規作成
- `src/index.ts` — `export type { EventStore, AppendOptions } from "./event-store/types.js";`

---

## 4. Internal Types

内部 helper なし。U5 / U8 各実装固有の型はそれぞれの module 内に閉じる。

---

## 5. Runtime 依存

- internal: U1 (`EventMap`, `EventsOf`, `StoredEventsOf`)
- 型のみ、runtime output なし

---

## 6. Algorithm / 実装方針

契約:

### append preconditions

- `expectedVersion >= 0`
- `events.length >= 1` (空配列は `EventLimitError`)

### append postconditions

- 返り値の長さ = `events.length`
- 返り値は入力 `events` と同じ順序
- 返り値は version 昇順・連番
- `返り値[0].version === expectedVersion + 1`
- `返り値[N-1].version === expectedVersion + N`
- 各 StoredEvent.aggregateId === 引数 aggregateId
- 各 StoredEvent.correlationId === options?.correlationId (undefined 許容)
- 各 StoredEvent.timestamp は ISO 8601 UTC

### append error conditions

- expectedVersion と実際の最大 version が不一致 → `ConcurrencyError` (U7)
- events.length === 0 → `EventLimitError` (U7)
- 実装固有の制約超過 → 実装側エラー (U8 では EventLimitError, AWS SDK エラーは透過)

### load postconditions

- 存在しない aggregateId → 空配列を返す (error にしない)
- 直前成功 append の結果を観測可能 (fresh read, C9)
- 返り値の各 StoredEvent.aggregateId === 引数
- version 昇順・連番
- 空でなければ最初の version = 1

---

## 7. Edge Cases

| ケース | 期待挙動 |
|---|---|
| `expectedVersion = 0` + 空ストリーム + events 3件 | 返り値 version = [1, 2, 3] |
| `expectedVersion = 5` + 実際 version = 5 | append 成功、返り値 version = [6, ...] |
| `expectedVersion = 5` + 実際 version = 6 | ConcurrencyError |
| `expectedVersion = 5` + 実際 version = 4 | ConcurrencyError (前進のみ許容) |
| `expectedVersion = -1` | 実装が RangeError を投げるか ConcurrencyError かは規定しない (現実には expectedVersion は U6 から渡され非負が保証される) |
| `events.length = 0` | EventLimitError (U7) |
| load: 存在しない aggregateId | `[]` を返す |
| load: 1000 件のイベント (DynamoDB 1MB 超え) | U8 で pagination 必須。返り値は全件 |
| append: `options = undefined` | correlationId 未付与で成功 |
| append: `options.correlationId = ""` (空文字) | 空文字は "設定されている" として扱う。StoredEvent.correlationId = "" |

---

## 8. Test Plan

### 8.1 Contract Tests (`test/contract/event-store.ts`)

同一 suite を U5 / U8 両方で実行する。U4 は interface 定義なので本 unit 直接の runtime test はない。ただし contract suite の定義は U4 design の一部として記述する。

Contract suite が検証する case (ID は U5 / U8 で共通):

| ID | case | 期待 |
|---|---|---|
| CT-01 | 空ストリーム load | `[]` |
| CT-02 | append 1 件 → load | `[{version:1, ...}]` |
| CT-03 | append 3 件 (1 回の append) → load | version = [1,2,3] 順 |
| CT-04 | append expectedVersion mismatch (大) | ConcurrencyError |
| CT-05 | append expectedVersion mismatch (小) | ConcurrencyError |
| CT-06 | append events=[] | EventLimitError |
| CT-07 | append 2 回 → load は 2 回分を連番で返す | version 連番 |
| CT-08 | append → load で timestamp が ISO 8601 UTC | 正規表現 pass |
| CT-09 | append → load で aggregateId が一致 | 全 event の aggregateId === 引数 |
| CT-10 | append options.correlationId=設定 → StoredEvent.correlationId === 設定値 | — |
| CT-11 | append options 未指定 → StoredEvent.correlationId は undefined | — |
| CT-12 | append directly after successful append → load が直前結果を観測 (fresh read, C9) | — |
| CT-13 | 異なる aggregateId は独立 (並行 append で interference なし) | ID 毎に version 独立 |

### 8.2 Type-level regression

| case | assertion |
|---|---|
| `EventStore<{ A: {x:1} }>` の `append` の第 2 引数 | `ReadonlyArray<DomainEvent<"A", {x:1}>>` |
| `EventStore<{ A: {x:1} }>` の `load` の戻り値 | `Promise<ReadonlyArray<StoredEvent<"A", {x:1}>>>` |
| `AppendOptions` 全プロパティ optional | assignable from `{}` |

### 8.3 Test doubles

本 unit は interface のみ。U6 test では `FailOnce` / `AlwaysFail` / `CountingLoad` を `test/doubles/` に配置し EventStore を implement する:

- `FailOnce<TMap>`: 最初の append で `ConcurrencyError`、2 回目以降は成功
- `AlwaysFail<TMap>`: 常に ConcurrencyError
- `CountingLoad<TMap>`: wrap された EventStore で load 呼び出し回数を記録

---

## 9. Performance

- 型のみ、runtime cost 0
- contract suite の 13 case は InMemory で数 ms、DynamoDB Local で 数百 ms〜1s の想定

---

## 10. Observability Hooks

U8 実装時に OpenTelemetry span を以下の attribute で作成予定 (v0.2.0):

- `db.system.name = "aws.dynamodb"` (OTel semconv 2026 rename)
- `aws.dynamodb.table_names = [tableName]`
- `aws.dynamodb.consistent_read = true` (load 時)
- `db.operation.name = "TransactWriteItems" | "Query"`
- `minamo.aggregate.id`
- `minamo.event_store.expected_version` / `event_count`
- `messaging.message.correlation_id` (options.correlationId が設定されている場合のみ)

interface 側は span の存在を強制しない。v0.1.0 実装は span を emit しない。design doc として hook point のみ記す。

---

## 11. Error Paths

- `ConcurrencyError` (U7): expectedVersion 不一致
- `EventLimitError` (U7): events=[] や実装固有の制約超過
- 実装固有のその他: U8 は AWS SDK エラー (ThrottlingException 等) を透過、U5 はなし

---

## 12. 2026 Trend Application

- **AbortSignal 伝搬**: v0.2.0 で `AppendOptions.signal?: AbortSignal` を追加予定。v0.1.0 は追加しない (concept.md §5.4 逐字維持, C4 の interface 拡張は v0.2.0 に先送り)
- **ConsistentRead best practice**: U8 で `ConsistentRead: true` 採用 (C9)
- **TransactWriteItems 100 ops limit (2024-11 引き上げ)**: U8 で N≤99 を pre-flight check (R15)

---

## § Accepted Trade-offs

- `AppendOptions` を 1 property (`correlationId?`) だけで定義。将来 `signal`, `idempotencyKey`, `metadata` を追加する余地を残すため object に wrap。パラメータ追加を breaking change にしない設計
- `load` に pagination hint (`startAfterVersion?: number`) を持たせない。v0.1.0 は full load に特化 (Rehydration cost は consumer が Aggregate 粒度で制御、§8 OQ-1)
- interface から DynamoDB 固有のサイズ制約を追い出した (DEC-006)。InMemory は size check を行わないため、test で DynamoDB 固有の制約違反を検出できないリスクは残るが、U8 side の unit test で担保

---

## § Unresolved

- OQ-A (`AppendOptions.correlationId` 必須化) → v0.1.0 は optional を維持し解決とする。consumer が idempotency を担保するための推奨 field であり、全 command に強制する根拠が弱い (concept.md § 5.4 逐字性も要求する)

---

## § Links

- concept.md §5.4 (canonical)
- DEC-006 EventStore interface の汎用性
- DEC-007 Version Model
- DEC-011 plain data
- C9 fresh-read contract
- U1 `EventsOf` / `StoredEventsOf`
- U5 InMemoryEventStore
- U8 DynamoEventStore
- Fact: OTel DynamoDB semconv — https://opentelemetry.io/docs/specs/semconv/database/dynamodb/ (checked: 2026-04-17)
- Fact: DynamoDB TransactWriteItems 100 ops — https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html (checked: 2026-04-17)
