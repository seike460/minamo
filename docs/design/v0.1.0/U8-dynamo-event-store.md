# U8 — DynamoEventStore

**Upstream**: concept.md §5.8 DynamoEventStore
**Depends on**: U1, U4, U7
**Applied constraints**: C1, C2, C4, C9, C10, C11, C12
**Applied risks**: R1, R3, R4, R5, R14, R15

---

## 1. Unit 定義

Amazon DynamoDB を Event Store として `EventStore<TMap>` を実装する。append は `TransactWriteCommand` (ConditionCheck + Put) でアトミック書き込み、load は `QueryCommand` を `ConsistentRead: true` + `LastEvaluatedKey` pagination で実施する。concept.md §1 痛み A / B / C への回答の中核。

---

## 2. 公開 API (concept.md §5.8 逐字)

```ts
export interface DynamoEventStoreConfig {
  readonly tableName: string;
  readonly clientConfig?: DynamoDBClientConfig;
  readonly client?: DynamoDBDocumentClient;
}

export declare class DynamoEventStore<TMap extends EventMap>
  implements EventStore<TMap> {
  constructor(config: DynamoEventStoreConfig);
  append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
  load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
}
```

---

## 3. Module 配置

- `src/event-store/dynamo/index.ts` — `DynamoEventStore` class 本体と `DynamoEventStoreConfig`
- `src/event-store/dynamo/marshaller.ts` — 内部: event ⇄ DynamoDB item 変換 (`toItem`, `fromItem`)
- `src/event-store/dynamo/client.ts` — 内部: client resolution (config.client > config.clientConfig > default)
- `src/index.ts` — `export { DynamoEventStore } from "./event-store/dynamo/index.js"; export type { DynamoEventStoreConfig } from "./event-store/dynamo/index.js";`

---

## 4. Internal Types

```ts
// DynamoDB item shape (marshaller.ts)
interface EventItem {
  aggregateId: string;   // PK
  version: number;       // SK
  type: string;
  data: unknown;         // plain data (DEC-011)
  timestamp: string;     // ISO 8601
  correlationId?: string;
}

// Client resolver の返却型
type ResolvedClient = {
  readonly doc: DynamoDBDocumentClient;
  readonly ownsClient: boolean;   // 廃棄責務の判別用 (現状は consumer DI 推奨で true は未使用)
};

// TransactWriteItems の action
type TransactAction =
  | { ConditionCheck: { TableName: string; Key: { aggregateId: string; version: number }; ConditionExpression: string } }
  | { Put: { TableName: string; Item: EventItem; ConditionExpression: string } };

// 制約数値
const MAX_EVENTS_PER_APPEND = 99;       // TransactWriteItems 100 ops - 1 ConditionCheck
const MAX_ITEM_SIZE_BYTES = 400 * 1024;
const MAX_TRANSACTION_BYTES = 4 * 1024 * 1024;
const SIZE_SLACK_BYTES = 16 * 1024;     // Put の attribute name / DDB overhead を控除する安全マージン
```

---

## 5. Runtime 依存

- internal: U1, U4, U7 (`EventLimitError`, `ConcurrencyError`)
- AWS SDK peer (C2):
  - `@aws-sdk/client-dynamodb` — `DynamoDBClient`, `DynamoDBClientConfig`, `TransactionCanceledException`
  - `@aws-sdk/lib-dynamodb` — `DynamoDBDocumentClient`, `TransactWriteCommand`, `QueryCommand`
  - `@aws-sdk/util-dynamodb` — 必要なら marshall option 補助 (実際には lib-dynamodb が wrap するため直接依存は最小化)

import は `import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";` のように type-only を verbatimModuleSyntax で明示。

---

## 6. Algorithm / 実装方針

### 6.1 Client resolution (concept.md §5.8 priority)

```text
resolveClient(config):
  if config.client:
    return config.client
  if config.clientConfig:
    raw = new DynamoDBClient(config.clientConfig)
    return DynamoDBDocumentClient.from(raw, {
      marshallOptions: {
        removeUndefinedValues: true,        # DEC-011 で undefined 禁止だが防御的に
        convertEmptyValues: false,          # 空文字を NULL に変換しない
        convertClassInstanceToMap: false,   # class instance を marshal しない (plain data 強制)
      },
      unmarshallOptions: {
        wrapNumbers: false,                 # number に narrow (version に必須)
      },
    })
  # default: AWS SDK の default credential chain を使用
  raw = new DynamoDBClient({})
  return DynamoDBDocumentClient.from(raw, { marshallOptions: ..., unmarshallOptions: ... })
```

**注意**: `DynamoDBDocumentClient.from` を本当に毎 instance で呼ぶか、module scope で singletion にするかは consumer 責務 (R14)。ライブラリは constructor で resolve したものを instance field として保持する。

**R5 対策**: consumer が `config.client` で独自の `DynamoDBDocumentClient` を渡す場合、`marshallOptions` は consumer 側の設定が使われる。doc で推奨設定を明示する (`removeUndefinedValues: true` 必須、`convertEmptyValues: false` 推奨)。

### 6.2 append

```text
async append(aggregateId, events, expectedVersion, options?):
  # Step 1: pre-flight (R15)
  if events.length === 0:
    throw new EventLimitError(aggregateId, "events must not be empty")
  if events.length > MAX_EVENTS_PER_APPEND:
    throw new EventLimitError(aggregateId,
      `exceeds maximum ${MAX_EVENTS_PER_APPEND} events per append (got ${events.length})`
    )

  # Step 2: timestamp を 1 回生成 (原子性)
  timestamp = new Date().toISOString()

  # Step 3: stored events を構築 + size 検証
  totalSize = 0
  storedEvents: StoredEvent[] = []
  for i in 0..events.length-1:
    v = expectedVersion + i + 1
    stored = {
      type: events[i].type,
      data: events[i].data,
      aggregateId,
      version: v,
      timestamp,
      correlationId: options?.correlationId,   # undefined 時は spread で省略
    }
    itemJsonSize = approxItemSize(stored)   # JSON.stringify + attribute name バジェット
    if itemJsonSize > MAX_ITEM_SIZE_BYTES:
      throw new EventLimitError(aggregateId,
        `event at index ${i} exceeds 400KB item size limit (got ${itemJsonSize})`
      )
    totalSize += itemJsonSize
    storedEvents.push(stored)

  if totalSize + SIZE_SLACK_BYTES > MAX_TRANSACTION_BYTES:
    throw new EventLimitError(aggregateId,
      `aggregated size exceeds 4MB transaction limit (approx ${totalSize} bytes)`
    )

  # Step 4: TransactWriteItems の構築
  # ConditionCheck head: expectedVersion の位置に item が既に存在しないことを確認
  #  - expectedVersion === 0 なら "attribute_not_exists(aggregateId) AND attribute_not_exists(version)"
  #    を version=1 ターゲットに対して発行 (最初の Put と重複するため、Put 側の ConditionExpression に
  #    統合できる。ただし意図を明示するため別 action にする方針も可)
  # 現実的な実装: 各 Put に "attribute_not_exists(version)" (SK not exists) を付ける
  #   → DynamoDB は複合キー (PK, SK) なので "attribute_not_exists(version)" = "この PK/SK 組が未存在"
  #   → 同 version がすでにあれば transaction abort (ConditionalCheckFailed)
  #   → ConditionCheck action を追加で入れる必要なし (100 ops を節約)

  actions = storedEvents.map(e => ({
    Put: {
      TableName: tableName,
      Item: toItem(e),
      ConditionExpression: "attribute_not_exists(version)",
      # PK 側も含める記述 "attribute_not_exists(aggregateId) AND attribute_not_exists(version)"
      # は DynamoDB では SK check のみで十分 (複合キー存在チェック)
    }
  }))

  # Step 5: TransactWriteCommand を実行
  try:
    await docClient.send(new TransactWriteCommand({
      TransactItems: actions,
    }))
  catch (err):
    if isConditionalCheckFailure(err):
      # CancellationReasons[i].Code === "ConditionalCheckFailed" が 1 つ以上あれば concurrency
      throw new ConcurrencyError(aggregateId, expectedVersion)
    throw err   # ThrottlingException 等は透過 (concept.md §5.5 末尾)

  return freeze(storedEvents)
```

**設計判断**:

1. **ConditionCheck action を追加しない** — 各 Put の `ConditionExpression: "attribute_not_exists(version)"` で十分。ConditionCheck action を別途入れると 100 ops の枠を 1 消費する。N=99 上限は ConditionCheck なしで実現
2. **timestamp を 1 回生成** — 同 transaction 内の全 event で同じ timestamp。consumer の「この command で起きたこと」の識別が容易
3. **size check は JSON.stringify ベースの近似** — DynamoDB の正確な item size (attribute name 含む) を計算するのは重い。approximate で conservatively check し、SIZE_SLACK_BYTES のマージンを取る
4. **CancellationReasons の判別** — TransactWriteItems 失敗時、`err instanceof TransactionCanceledException` で `CancellationReasons[i].Code` が `ConditionalCheckFailed` を含めば concurrency 判定。他の reason (`ThrottlingError` 等) は別エラーで透過

### 6.3 load

```text
async load(aggregateId):
  items: EventItem[] = []
  lastKey = undefined
  do:
    result = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "aggregateId = :id",
      ExpressionAttributeValues: { ":id": aggregateId },
      ConsistentRead: true,              # C9: fresh read (R1)
      ExclusiveStartKey: lastKey,
      ScanIndexForward: true,            # SK (version) ascending
    }))
    items.push(...result.Items ?? [])
    lastKey = result.LastEvaluatedKey
  while lastKey !== undefined

  # unmarshal (DocumentClient が自動で native JS に変換)
  return freeze(items.map(it => fromItem(it)))
```

`ConsistentRead: true` は RCU 2x を消費するが、Event Store の load では必須 (concept.md §3)。

**pagination の重要性**: DynamoDB Query の 1MB 上限 (concept.md §3)。1,000 件の event が 1MB に収まることは稀でないが、大きな payload を含む stream では複数ページになる。`LastEvaluatedKey` が undefined になるまで loop する。

### 6.4 marshaller

```text
# src/event-store/dynamo/marshaller.ts

toItem(stored): EventItem:
  item = {
    aggregateId: stored.aggregateId,
    version: stored.version,
    type: stored.type,
    data: stored.data,     # DocumentClient が自動 marshal
    timestamp: stored.timestamp,
  }
  if stored.correlationId !== undefined:
    item.correlationId = stored.correlationId
  return item

fromItem(raw): StoredEvent:
  # runtime 型検証 (最小限)
  assert typeof raw.aggregateId === "string"
  assert typeof raw.version === "number"
  assert typeof raw.type === "string"
  assert typeof raw.timestamp === "string"
  stored = {
    aggregateId: raw.aggregateId,
    version: raw.version,
    type: raw.type,
    data: raw.data,
    timestamp: raw.timestamp,
  }
  if raw.correlationId !== undefined:
    stored.correlationId = raw.correlationId
  return stored
```

runtime 検証を最小限に抑え、シャープに保つ。wrong shape の item は "operational error" としてそのまま下流に流れる想定 (consumer が schema 管理の責務)。

---

## 7. Edge Cases

| ケース | 期待挙動 |
|---|---|
| append events=[] | EventLimitError (pre-flight) |
| append events.length=99 | TransactWriteItems 99 ops で成功 (境界) |
| append events.length=100 | EventLimitError (pre-flight) |
| append event size > 400KB | EventLimitError (pre-flight) |
| append total size > 4MB - slack | EventLimitError (pre-flight) |
| append expectedVersion mismatch | TransactionCanceledException → ConcurrencyError |
| append 中に network error (ThrottlingException) | AWS SDK error 透過 (retry は SDK の内部 retry に任せる、C2 peer dep の設定は consumer 責務) |
| load 空ストリーム | [] |
| load 1000+ event (複数 page) | 全件連結、version 連番 |
| load 結果の raw.correlationId undefined | StoredEvent に correlationId property なし (hasOwn false) |
| `config.client` 指定 | 優先採用 |
| `config.clientConfig` 指定 + client 未指定 | clientConfig から生成 |
| `config.client` も `config.clientConfig` も未指定 | AWS SDK default credential chain |
| `expectedVersion = 0` 初回 | version=1 の Put が attribute_not_exists(version) で成功 |
| `expectedVersion = 0` だが既に v1 存在 | ConditionalCheckFailed → ConcurrencyError |
| `ConsistentRead: true` が GSI に当てられる | 本 unit は base table のみ使用。GSI なし (C11) |
| BatchWriteItem 誤用 | 本 unit では使用しない (R4) |

---

## 8. Test Plan

### 8.1 Contract Tests (U4 で定義、CT-01〜13)

`test/dynamodb.integration.test.ts` で DynamoDB Local に対して実行。既存 Spike 期の harness (Docker amazon/dynamodb-local:2.5.4) を流用。

### 8.2 DynamoEventStore 固有 unit tests (integration)

| case | assertion |
|---|---|
| CT-DDB-01 append N=99 | 成功、version=[1..99] |
| CT-DDB-02 append N=100 | EventLimitError (pre-flight、DDB 呼び出し前) |
| CT-DDB-03 event size > 400KB | EventLimitError (pre-flight) |
| CT-DDB-04 total size > 4MB | EventLimitError (pre-flight) |
| CT-DDB-05 ConditionalCheckFailed → ConcurrencyError | version=1 を 2 つの append で競合させる |
| CT-DDB-06 load 1200 件 (2 page) | 全件返る、version 連番 |
| CT-DDB-07 ConsistentRead: true | append 直後 load で最新観測 (R1) |
| CT-DDB-08 client resolution priority | config.client > config.clientConfig > default |
| CT-DDB-09 correlationId round-trip | append → load で correlationId 一致 |
| CT-DDB-10 correlationId 省略 | load 結果に correlationId property なし |
| CT-DDB-11 timestamp ISO 8601 | 正規表現 pass |
| CT-DDB-12 TransactionCanceledException 以外の SDK error | 透過 (wrap しない) |

### 8.3 Unit tests (non-integration)

| case | assertion |
|---|---|
| CT-DDB-Unit-01 marshaller toItem | correlationId undefined 時 property なし |
| CT-DDB-Unit-02 marshaller fromItem | raw の余分な attribute は無視 |
| CT-DDB-Unit-03 pre-flight size check | 0-byte event も成功 |
| CT-DDB-Unit-04 approxItemSize | json stringify ベースでの size 計算が期待値に収まる |

### 8.4 Type-level regression

| case | assertion |
|---|---|
| `new DynamoEventStore<CounterEvents>({tableName:"t"})` | compile OK |
| `new DynamoEventStore<CounterEvents>({})` | compile error (tableName missing) |
| `append` 第 2 引数 | `ReadonlyArray<DomainEvent<"Incremented", {amount:number}>>` |
| `load` 戻り値要素 | `StoredEvent<"Incremented", {amount:number}>` |

### 8.5 Test doubles

- integration test は DynamoDB Local 実インスタンス
- unit test は `DynamoDBDocumentClient` の mock (vitest `vi.fn`) を使い、send の入出力を検証
- `FailOnce<TMap>` 等は EventStore レベルの wrapper なので U8 専用 double は最小限

---

## 9. Performance

- append: O(N) pre-flight + 1 round-trip (TransactWriteItems, p50: 10-30ms)
- load: O(total bytes / 1MB) round-trip × page。typical aggregate (< 50 events) で 1 page → p50: 5-15ms
- client 再利用: consumer が module scope で保持していれば TLS handshake をスキップし cold start 後の 1st call が速い (R14)
- `approxItemSize`: O(stringify) per event。99 件で数 ms 以内
- memory: append の storedEvents 配列サイズ = events.length 分のみ

---

## 10. Observability Hooks

v0.2.0 で以下 span を追加予定 (Fact: OTel DynamoDB semconv 2026-04):

```text
span: minamo.event_store.append
  attributes:
    db.system.name = "aws.dynamodb"
    db.operation.name = "TransactWriteItems"
    aws.dynamodb.table_names = [tableName]
    minamo.aggregate.id
    minamo.event_store.expected_version
    minamo.event_store.event_count
    minamo.event_store.bytes_approx
    messaging.message.correlation_id? (options.correlationId 指定時)

span: minamo.event_store.load
  attributes:
    db.system.name = "aws.dynamodb"
    db.operation.name = "Query"
    aws.dynamodb.table_names = [tableName]
    aws.dynamodb.consistent_read = true
    minamo.aggregate.id
    minamo.event_store.page_count
    minamo.event_store.event_count
```

Fact: OTel `db.system.name` は 2026 rename (旧 `db.system` deprecated だが互換性あり)。minamo は新名を採用。

v0.1.0 では hook を embed せず、call site のコメントで "OTel span here" を明示する程度に抑える。

---

## 11. Error Paths

| Error | 条件 |
|---|---|
| `EventLimitError` | events=[], N>99, single event > 400KB, total > 4MB - slack |
| `ConcurrencyError` | TransactionCanceledException with any CancellationReason.Code === "ConditionalCheckFailed" |
| AWS SDK エラー (透過) | ThrottlingException, ProvisionedThroughputExceededException, network error, etc. |

instanceof 分岐:

```ts
catch (err: unknown) {
  if (err instanceof TransactionCanceledException) {
    if (err.CancellationReasons?.some(r => r.Code === "ConditionalCheckFailed")) {
      throw new ConcurrencyError(aggregateId, expectedVersion);
    }
  }
  throw err;
}
```

TransactionCanceledException が `@aws-sdk/client-dynamodb` から re-export されることを確認 (AWS SDK v3 の標準)。

---

## 12. 2026 Trend Application

- **TransactWriteItems 100 ops (2024-11 引き上げ)**: v0.1.0 から採用。MAX_EVENTS_PER_APPEND = 99 (ConditionCheck なしの選択で実際 Put 99 件)
- **ConsistentRead による fresh-read**: C9 の実装手段として採用
- **marshallOptions 推奨設定**: `removeUndefinedValues: true`, `convertEmptyValues: false`, `convertClassInstanceToMap: false` を doc で推奨
- **AWS SDK v3 client 再利用 pattern**: consumer responsibility。Lambda module scope で singleton 化 (concept.md §9 推奨)
- **OpenTelemetry db.system.name rename**: v0.2.0 実装時に採用

---

## § Accepted Trade-offs

- **ConditionCheck action を別途持たない** (Put 各々の `attribute_not_exists(version)` で代替): N=99 を実現するために採用。副作用として、「どの version が衝突したか」の検出情報が失われる (TransactionCanceledException の CancellationReasons index は Put の index を指す)。ConcurrencyError には expectedVersion しか入らないため consumer が最新 version を知るには再 load する
- **approximate size check**: DynamoDB の真の item size (attribute name の UTF-8 byte count を含む) を完全計算しない。SIZE_SLACK_BYTES マージンで overshoot を防ぐが、巨大な attribute name を使う consumer は unexpected に limit を超えることがある。docs で "attribute name は短く" を推奨
- **marshaller で runtime 型検証を最小化**: type / version / timestamp 等の primary field のみ assert。data の shape は consumer 責務 (DEC-013 と同じ philosophy)
- **client を instance 所有しない**: constructor で resolve したものを保持するが、`dispose` を呼ばない。consumer が管理する (Lambda lifecycle で自然に解放)

---

## § Unresolved

なし。

---

## § Links

- concept.md §5.8 DynamoEventStore (canonical)
- concept.md §3 DynamoDB Constraints
- DEC-006 interface 汎用性、DynamoDB 固有制約は DynamoEventStore へ
- DEC-011 plain data (marshall 互換)
- DEC-014 AWS プリミティブ非ラップ原則 (BatchWriteItem 使わない、R4)
- §8 Risks (marshall 設定差 R5, hot aggregate, poison pill)
- C11 Storage Shape (PK=aggregateId, SK=version)
- C12 TransactWriteItems 100 ops / 4MB
- U4 Contract Tests
- U7 EventLimitError, ConcurrencyError
- Fact: TransactWriteItems 100 ops — https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html (checked: 2026-04-17)
- Fact: 2024-11 100 actions 引き上げ — https://aws.amazon.com/about-aws/whats-new/2022/09/amazon-dynamodb-supports-100-actions-per-transaction/ (checked: 2026-04-17) — 引き上げ発表は 2022-09。2024-11 は concept.md の原文表記に準ずる (追加 fact 調査で source 更新の余地)
- Fact: OTel DynamoDB semconv — https://opentelemetry.io/docs/specs/semconv/database/dynamodb/ (checked: 2026-04-17)
- Fact: DynamoDB Document Client marshallOptions — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-dynamodb/ (checked: 2026-04-17)
