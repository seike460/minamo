# U9 — Projection Bridge

**Upstream**: concept.md §5.7 Projection Bridge
**Depends on**: U1, U7
**Applied constraints**: C1, C13, C14
**Applied risks**: R7, R8, R16

---

## 1. Unit 定義

Write 側 (Event Store) と Read 側 (Projection Lambda) を繋ぐ **最小ヘルパー**。DynamoDB Stream Record 1 件を正規化し、`StoredEvent` 構造に復元する。責務は "正規化 + type filtering" まで。batch 反復、payload 検証、Read Model 更新は consumer 責務 (DEC-013, DEC-014)。

---

## 2. 公開 API (concept.md §5.7 逐字)

```ts
export declare function parseStreamRecord<
  TMap extends EventMap,
  TEventName extends keyof TMap & string = keyof TMap & string,
>(
  record: unknown,
  eventNames: ReadonlyArray<TEventName>,
  options?: ParseStreamRecordOptions,
): StoredEvent<TEventName, unknown> | null;

export interface ParseStreamRecordOptions {
  readonly ignoreUnknownTypes?: boolean;
}

export declare class InvalidStreamRecordError extends Error {
  readonly name: "InvalidStreamRecordError";
  readonly reason: "missing_field" | "unmarshal_failed" | "unknown_type";
  readonly detail?: string;
  constructor(
    reason: InvalidStreamRecordError["reason"],
    message: string,
    detail?: string,
  );
}

export declare function eventNamesOf<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
): ReadonlyArray<keyof TMap & string>;
```

`InvalidStreamRecordError` は U7 で定義する (re-export は U9 module 経由)。

---

## 3. Module 配置

- `src/projection/bridge.ts` — `parseStreamRecord` と `eventNamesOf`
- `src/projection/index.ts` (optional 集約) — 本 unit では `bridge.ts` を直接 re-export
- `src/index.ts`:
  - `export { parseStreamRecord, eventNamesOf } from "./projection/bridge.js";`
  - `export type { ParseStreamRecordOptions } from "./projection/bridge.js";`
  - `export { InvalidStreamRecordError } from "./errors.js";` (U7 で定義済)

---

## 4. Internal Types

```ts
// DynamoDB Stream Record の shape (@types/aws-lambda への依存を避けるため独自に最小定義)
interface StreamRecordShape {
  eventName?: "INSERT" | "MODIFY" | "REMOVE";
  dynamodb?: {
    NewImage?: Record<string, AttributeValueShape>;
    Keys?: Record<string, AttributeValueShape>;
  };
}

// DynamoDB AttributeValue shape (util-dynamodb の unmarshall を経由するため、
//  ライブラリ内で独自に narrow する必要はない)
type AttributeValueShape = unknown;
```

@types/aws-lambda への dep を避ける設計 (concept.md §5.7 逐字 "record: unknown")。consumer が `DynamoDBStreamEvent` を使う場合でも `unknown` としてライブラリ境界を通す。

---

## 5. Runtime 依存

- internal: U1 (`EventMap`, `StoredEvent`), U2 (`AggregateConfig` — `eventNamesOf` で使用), U7 (`InvalidStreamRecordError`)
- AWS SDK peer (optional):
  - `@aws-sdk/util-dynamodb` の `unmarshall` を利用して `NewImage` の AttributeValue 形式を plain JS object に変換
- 標準組み込み: `Object.keys`

**peer dep の optional 性**: `parseStreamRecord` は Projection Lambda のみで使う。DynamoEventStore と同じ `@aws-sdk/util-dynamodb` peer で covered される (C2, concept.md CLAUDE.md)。

---

## 6. Algorithm / 実装方針

### 6.1 parseStreamRecord

```text
function parseStreamRecord<TMap, TEventName>(record, eventNames, options?):
  # Step 1: INSERT filter
  rec = record as StreamRecordShape
  if rec.eventName !== "INSERT":
    return null   # MODIFY, REMOVE, undefined は silently skip

  # Step 2: NewImage 必須
  newImage = rec.dynamodb?.NewImage
  if newImage === undefined or newImage === null:
    throw new InvalidStreamRecordError(
      "missing_field",
      "DynamoDB Stream Record has no NewImage. Ensure StreamViewType=NEW_IMAGE.",
      "dynamodb.NewImage"
    )

  # Step 3: unmarshall
  try:
    item = unmarshall(newImage)   # @aws-sdk/util-dynamodb
  catch (err):
    throw new InvalidStreamRecordError(
      "unmarshal_failed",
      `Failed to unmarshall NewImage: ${err.message}`,
      err.message
    )

  # Step 4: 必須 field の存在検証
  if typeof item.aggregateId !== "string":
    throw new InvalidStreamRecordError("missing_field", "aggregateId must be a string", "aggregateId")
  if typeof item.version !== "number":
    throw new InvalidStreamRecordError("missing_field", "version must be a number", "version")
  if typeof item.type !== "string":
    throw new InvalidStreamRecordError("missing_field", "type must be a string", "type")
  if typeof item.timestamp !== "string":
    throw new InvalidStreamRecordError("missing_field", "timestamp must be a string", "timestamp")

  # Step 5: type filtering (DEC-013)
  if !eventNames.includes(item.type):
    if options?.ignoreUnknownTypes === true:
      return null
    throw new InvalidStreamRecordError(
      "unknown_type",
      `Event type "${item.type}" is not in the accepted event names`,
      item.type
    )

  # Step 6: StoredEvent 構築
  stored: StoredEvent<TEventName, unknown> = {
    type: item.type as TEventName,
    data: item.data,                  # unknown のまま (DEC-013)
    aggregateId: item.aggregateId,
    version: item.version,
    timestamp: item.timestamp,
  }
  if typeof item.correlationId === "string":
    stored.correlationId = item.correlationId
  return stored
```

### 6.2 eventNamesOf

```text
function eventNamesOf<TState, TMap>(config):
  return Object.keys(config.evolve) as Array<keyof TMap & string>
```

型的には `Object.keys` は `string[]` を返すため、`as` cast が必要。`evolve` は `Evolver<TState, TMap>` の mapped type で `keyof TMap & string` の key を持つため cast は型安全 (mapped type の key 由来)。

### 6.3 設計の要点

1. **type-only routing** (DEC-013): aggregateId でフィルタしない。複数 Aggregate 共有テーブル時の衝突回避は consumer の命名規約 (DEC-009)
2. **strict-by-default** (DEC-013): 未知 type は throw。`ignoreUnknownTypes: true` が opt-in
3. **INSERT 以外は null** (concept.md §5.7 逐字): MODIFY / REMOVE は Event Sourcing の Event Store では発生しないはずだが、consumer が誤って通常テーブルに当てた場合にも safely no-op
4. **`eventNamesOf` は Object.keys wrapper** (concept.md §5.7): DRY な event names 取得 API。consumer の手書き配列を防ぐ
5. **`data` は `unknown` のまま** (DEC-013): schema 検証は consumer 責務

---

## 7. Edge Cases

| ケース | 期待挙動 |
|---|---|
| eventName = "MODIFY" | null |
| eventName = "REMOVE" | null |
| eventName undefined | null (defensive) |
| NewImage 無し | InvalidStreamRecordError(missing_field, "dynamodb.NewImage") |
| NewImage が空 object | unmarshall 成功 → aggregateId 不在で missing_field |
| unmarshall 失敗 (invalid AttributeValue) | InvalidStreamRecordError(unmarshal_failed) |
| aggregateId 非 string | InvalidStreamRecordError(missing_field, "aggregateId") |
| version 非 number | InvalidStreamRecordError(missing_field, "version") |
| type が eventNames に未登録 | strict: InvalidStreamRecordError(unknown_type)、ignoreUnknownTypes: null |
| correlationId undefined | stored に correlationId property 無し |
| correlationId = "" | stored.correlationId = "" (空文字 valid) |
| record = null | `null as StreamRecordShape` → eventName undefined → null (INSERT でない) |
| record = {} | eventName undefined → null |
| eventNames = [] | 全 INSERT record で strict 時 unknown_type throw、lenient 時 null |
| eventNames を後から extend | consumer が再 deploy、strict で保たれる |

---

## 8. Test Plan

### 8.1 Unit tests (`test/unit.test.ts` / 新規 `test/projection.test.ts`)

| case | assertion |
|---|---|
| CT-PB-01 INSERT + 正常な record | StoredEvent を返す、aggregateId / version / type 一致 |
| CT-PB-02 MODIFY | null |
| CT-PB-03 REMOVE | null |
| CT-PB-04 NewImage 無し | InvalidStreamRecordError(missing_field, "dynamodb.NewImage") |
| CT-PB-05 aggregateId 無し | InvalidStreamRecordError(missing_field, "aggregateId") |
| CT-PB-06 version が string | InvalidStreamRecordError(missing_field, "version") |
| CT-PB-07 type が未登録 (strict) | InvalidStreamRecordError(unknown_type, 該当 type) |
| CT-PB-08 type が未登録 (lenient) | null |
| CT-PB-09 correlationId 有 | stored.correlationId 一致 |
| CT-PB-10 correlationId 無し | stored に property なし |
| CT-PB-11 unmarshall 失敗 | InvalidStreamRecordError(unmarshal_failed) |
| CT-PB-12 eventNames narrowing | `stored.type` の TS 型が `TEventName` に narrow (expectTypeOf) |

### 8.2 Type-level regression (R16)

| case | assertion |
|---|---|
| `parseStreamRecord<CounterEvents>(rec, ["Incremented"])` 戻り値 | `StoredEvent<"Incremented", unknown> \| null` |
| `parseStreamRecord<OrderEvents, "OrderPlaced">(rec, ["OrderPlaced"])` | `StoredEvent<"OrderPlaced", unknown> \| null` |
| `eventNamesOf(counterConfig)` 戻り値 | `readonly ("Incremented")[]` |

### 8.3 eventNamesOf

| case | assertion |
|---|---|
| CT-EN-01 single key | `["Incremented"]` |
| CT-EN-02 multiple keys | keys all present (order は preserve を assert しない — Object.keys の順序仕様は 2015 以降定義済だが insertion order に依拠するため test では sort compare) |

### 8.4 Integration test

DynamoDB Local + DynamoDB Streams Local (NOT supported in amazon/dynamodb-local natively without `-dbPath`) はローカルで難しい。よって U9 は以下の戦略:

- Unit test 中心 (record オブジェクトを hand-craft)
- `test/fixtures/stream-records.ts` に正常 / 異常 / edge case の record 定数を配置
- U8 / U9 の integration は v0.2.0+ の実 AWS 環境 e2e test で補完 (v0.1.0 スコープ外)

### 8.5 Test doubles

なし。`parseStreamRecord` は pure function。`unmarshall` が副作用なし。

---

## 9. Performance

- 1 record あたり O(|attributes|) (unmarshall コスト)
- 典型: Lambda 1 invocation で 100 records (BatchSize デフォルト)、各 < 1ms で合計 < 100ms overhead
- eventNames.includes は O(|eventNames|)。10 件以内想定で無視できる
- memory: record 本体のサイズ (DynamoDB item 上限 400KB × BatchSize)。Lambda のデフォルト memory (128-512MB) で十分

---

## 10. Observability Hooks

v0.2.0 で以下 span (Fact: OTel messaging semconv):

```text
span: minamo.projection.parse_stream_record
  attributes:
    messaging.system = "aws_dynamodb_streams"
    messaging.operation.type = "receive"
    minamo.stream_record.event_name (INSERT)
    minamo.stream_record.result ("parsed" | "filtered_unknown_type" | "filtered_not_insert")
    minamo.aggregate.id? (parsed 時のみ)
    minamo.event.type? (parsed 時のみ)
    messaging.message.correlation_id? (parsed 時かつ correlationId 存在時)
```

Fact note: OTel messaging conventions は 2026-04 時点で Development stage。安定化を待って v0.2.0 で実装。

v0.1.0 は hook 埋め込まない。source コメントで "OTel span here" の call site のみマーク。

---

## 11. Error Paths

| Error | 条件 |
|---|---|
| `InvalidStreamRecordError(missing_field, ...)` | NewImage 不在、必須 field missing |
| `InvalidStreamRecordError(unmarshal_failed, ...)` | util-dynamodb の unmarshall が throw |
| `InvalidStreamRecordError(unknown_type, ...)` | strict mode で未登録 type |

consumer が catch して ESM の `BisectBatchOnFunctionError` + OnFailure destination で poison pill 隔離 (R8, concept.md §8)。minamo はこの構成を **ラップしない** (DEC-014)。

---

## 12. 2026 Trend Application

- **`@aws-sdk/util-dynamodb` の `unmarshall`**: optional peer dep。Lambda runtime で SDK v3 と共に既に available
- **strict-by-default routing** (DEC-013): 2026 Event Sourcing best practice (schema drift 検出強化)
- **Idempotency key = `${aggregateId}:${version}`**: consumer docs で推奨。minamo 側は実装しない
- **OTel messaging semconv**: v0.2.0 採用予定 (現状 Development stage)
- **poison pill mitigation** (ESM 設定): consumer 責務。doc で `BisectBatchOnFunctionError: true` + `MaximumRetryAttempts: 3-10` + OnFailure destination を推奨 (§9 Step 4)
- **type narrowing with `TEventName extends keyof TMap & string`**: R16 対策。consumer の if 分岐で type-safe narrowing

---

## § Accepted Trade-offs

- **record は `unknown`**: `@types/aws-lambda` に依存しないための選択。consumer は `DynamoDBStreamEvent` を `unknown` として渡すことになり、型推論が落ちる。内部で safely narrow するが、consumer の IDE 補完で `DynamoDBStreamEvent.Records[i]` 型が直接効かない
- **data は `unknown`**: schema 検証ライブラリの vendor lock 回避 (DEC-013)。consumer が narrow する責任
- **MODIFY / REMOVE を silent null**: Event Sourcing テーブルでは INSERT のみ発生するはずだが、consumer が誤って通常テーブルに bridge を適用する場合に safely no-op。ログ出力はしない (minamo は logger を持たない)
- **`unmarshall` を `@aws-sdk/util-dynamodb` に依存**: optional peer のため consumer にインストールを要求する。自前で AttributeValue decode すれば依存削減だが、AttributeValue の shape は AWS が定義するため追従負債が大きい (C2 の保守負担を避ける)

---

## § Unresolved

- OQ-C (ProjectionBridge handler 戻り値型は void のみか) → **parseStreamRecord は handler ではなく 1 record の parser**。handler の戻り値型は consumer Lambda handler の責務 (concept.md §5.7 推奨パターン参照)。minamo が handler signature を定義しないことで OQ-C は解消する

---

## § Links

- concept.md §5.7 Projection Bridge (canonical)
- concept.md §8 poison pill Risk
- DEC-009 event 命名規約 (Aggregate prefix 推奨)
- DEC-013 strict-by-default, type-only routing
- DEC-014 AWS プリミティブ非ラップ
- C13 Projection Bridge 契約
- U1 `EventMap`, `StoredEvent`
- U2 `AggregateConfig` (eventNamesOf)
- U7 `InvalidStreamRecordError`
- Fact: DynamoDB Streams — https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html (checked: 2026-04-17)
- Fact: util-dynamodb unmarshall — https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-util-dynamodb/ (checked: 2026-04-17)
- Fact: OTel messaging semconv — https://opentelemetry.io/docs/specs/semconv/messaging/ (checked: 2026-04-17)
- Fact: Lambda BisectBatchOnFunctionError — https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html (checked: 2026-04-17)
