# U5 — InMemoryEventStore

**Upstream**: concept.md §5.8 (InMemoryEventStore 項)
**Depends on**: U1, U4
**Applied constraints**: C1, C4, C9, C10
**Applied risks**: R6, R15

---

## 1. Unit 定義

`EventStore<TMap>` を `Map`-based で実装する in-memory バージョン。テスト用 / ローカル学習用。Contract Tests の target #1 として DynamoEventStore (U8) と振る舞い一致を保証する (§1 痛み C への回答)。

---

## 2. 公開 API (concept.md §5.8 逐字)

```ts
/**
 * テスト用 EventStore 実装。
 *
 * DynamoEventStore と同じ汎用制約を実装する:
 * - バージョン検証、ギャップ検出、ConcurrencyError 発火条件
 * - 空配列チェック（EventLimitError）
 * - fresh read 保証（同期的にメモリから読むため、直前の append 結果を確実に観測できる）
 * - DynamoDB 固有のサイズ制約（400KB/4MB）はチェックしない
 *
 * Contract Tests で両実装の振る舞い一致を保証する。
 */
export declare class InMemoryEventStore<TMap extends EventMap> implements EventStore<TMap> {
  append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
  load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
  /** 全ストリームの全イベントを取得（テスト用） */
  allEvents(): ReadonlyArray<StoredEventsOf<TMap>>;
  /** 全ストリームをクリア（テスト用） */
  clear(): void;
}
```

---

## 3. Module 配置

- `src/event-store/in-memory.ts` — 新規作成
- `src/index.ts` — `export { InMemoryEventStore } from "./event-store/in-memory.js";`

---

## 4. Internal Types

```ts
// 内部ストレージ構造
type StreamMap = Map<string, StoredEvent<string, unknown>[]>;

// allEvents の戻り値構築で使う helper
type AnyStored = StoredEvent<string, unknown>;
```

内部的に `unknown` で保持するが、公開 API は `TMap` で型安全。

---

## 5. Runtime 依存

- internal: U1 (`EventMap`, `EventsOf`, `StoredEventsOf`), U4 (`EventStore`, `AppendOptions`), U7 (`ConcurrencyError`, `EventLimitError`)
- AWS SDK: 不使用
- 標準組み込み: `Map`, `Date`

---

## 6. Algorithm / 実装方針

```text
class InMemoryEventStore<TMap> implements EventStore<TMap>:

  private streams: Map<string, StoredEvent[]> = new Map()
  private insertionOrder: StoredEvent[] = []   # allEvents が全体順序を返すための補助

  async append(aggregateId, events, expectedVersion, options?):
    if events.length === 0:
      throw new EventLimitError(aggregateId, "events must not be empty")

    existing = streams.get(aggregateId) ?? []
    currentVersion = existing.length  # version = 長さ (連番かつ 0/1 始まり契約 C4)

    if currentVersion !== expectedVersion:
      throw new ConcurrencyError(aggregateId, expectedVersion)

    timestamp = new Date().toISOString()   # 同一 append で単一 timestamp に統一
    stored: StoredEvent[] = []
    for i in 0..events.length-1:
      stored.push({
        type: events[i].type,
        data: events[i].data,
        aggregateId,
        version: expectedVersion + i + 1,
        timestamp,
        correlationId: options?.correlationId,   # undefined 時は property を付けない
      })

    # atomicity: 上の検証〜push までの間に他の async 割込みは入らない
    # (JS event loop の単一スレッドモデル + 非 await 領域)
    # → push は slice で mutable array を作り atomically 差し替え
    streams.set(aggregateId, [...existing, ...stored])
    insertionOrder.push(...stored)

    return freeze(stored)   # ReadonlyArray への narrow

  async load(aggregateId):
    events = streams.get(aggregateId) ?? []
    return freeze([...events])   # shallow copy + readonly narrow

  allEvents():
    return freeze([...insertionOrder])

  clear():
    streams.clear()
    insertionOrder = []
```

**Key points**:

1. `correlationId: options?.correlationId` を optional chaining で取得。undefined のときは JS spread で property が付かない実装にする (DEC-011 の "undefined を値に持たない" に準拠)
2. `timestamp` は 1 回の append で single value。同一 TransactWrite が atomic timestamp を持つ DynamoEventStore (U8) と揃える
3. append は `async` 宣言だが内部で `await` しない。Promise をすぐ resolve する。JS event loop の single thread 性により atomic に見える (R15: 外部から async 割込みが入らない)
4. `allEvents()` は insertionOrder を保持して全体順序を返す。テストで Projection Bridge 検証時に使用
5. `clear()` は test teardown 用。本番で誤用されても致命ではないが、documentation で "テスト専用" を明示

### undefined property 省略の技法

```ts
const base = {
  type: events[i].type,
  data: events[i].data,
  aggregateId,
  version,
  timestamp,
};
const stored: StoredEvent<string, unknown> = options?.correlationId !== undefined
  ? { ...base, correlationId: options.correlationId }
  : base;
```

JSON serialization / structuredClone / DynamoDB marshal 全層で undefined が漏れないようにする (R5, DEC-011)。

---

## 7. Edge Cases

| ケース | 期待挙動 |
|---|---|
| 初回 append (version 0 → 1) | stream = [v1] |
| 並列 "疑似同時" append (JS event loop 上は直列) | 後勝ち。version 連番の gap なし |
| 同一 aggregateId に異なる TMap を混在 | TS 上は generic instance で 1 Store 1 TMap 固定。runtime は `unknown` で混在可能だが public API では reject される |
| append N=10000 (DynamoDB なら制約違反) | InMemory は制約なし、成功 (DEC-006) |
| append events = [] | EventLimitError |
| expectedVersion = 負数 | 実際の currentVersion が負になることはないため、常に mismatch で ConcurrencyError |
| clear() 後 load | [] |
| clear() 後 append | version = 1 から再開 |
| allEvents() | 全 aggregateId の events を insertion order で |

---

## 8. Test Plan

### 8.1 Contract Tests (U4 で定義した CT-01〜13)

InMemoryEventStore<CounterEvents> を対象に 13 case 全 pass。

### 8.2 Unit-specific tests

| case | assertion |
|---|---|
| CT-InMem-01 allEvents 全体順序 | aggregateId=A の event1, aggregateId=B の event1 を順に append → allEvents の順序が [A1, B1] |
| CT-InMem-02 clear | append 後 clear() → load でも allEvents でも [] |
| CT-InMem-03 correlationId 省略 | append(opts={}) → stored.correlationId プロパティが存在しない (not just undefined) |
| CT-InMem-04 correlationId 空文字 | append(opts={correlationId:""}) → stored.correlationId === "" |
| CT-InMem-05 timestamp 単一性 | append 5 件 → 全 event の timestamp が等しい |
| CT-InMem-06 fresh read | append → load で直前の結果が観測される (await 間で resolve されている) |
| CT-InMem-07 異なる aggregateId 独立 | A に append, B の version は 0 のまま |

### 8.3 Type-level regression

| case | assertion |
|---|---|
| `new InMemoryEventStore<CounterEvents>()` の `append` 第 2 引数 | `ReadonlyArray<DomainEvent<"Incremented", {amount:number}>>` |
| `append` の戻り値の要素 | `StoredEvent<"Incremented", {amount:number}>` (keyof TMap に narrow) |

### 8.4 Test doubles 必要性

U5 自身は test double ではなく実装。U6 test で用いる `FailOnce` / `AlwaysFail` / `CountingLoad` は "InMemoryEventStore wrapper" として `test/doubles/` に配置。InMemory の内部を wrap することで 現実的な ConcurrencyError flow を模擬する。

---

## 9. Performance

- append: O(events.length + existing.length) (concat)。large stream で degraded するが test 用途では問題なし
- load: O(existing.length) (spread copy)
- allEvents: O(insertionOrder.length)
- Memory: O(total events)。clear() で解放
- 本番で使うべきでない。docstring と README で明示

---

## 10. Observability Hooks

InMemory なので OTel hook は不要。DynamoEventStore (U8) の hook 箇所と対称性を保つため、内部的に append / load の call site 識別子 (`"minamo.in-memory.append"`) をコード上にコメントで残す。v0.2.0 で optional hook を追加する際の起点。

---

## 11. Error Paths

| 条件 | Error |
|---|---|
| events.length === 0 | EventLimitError |
| currentVersion !== expectedVersion | ConcurrencyError(aggregateId, expectedVersion) |

その他の例外はなし (サイズ制約なし、SDK 依存なし)。

---

## 12. 2026 Trend Application

- **Node 24 `Map`**: 組み込みを使う。`WeakMap` は aggregateId が string で不可
- **structuredClone**: append で event を保存する際、consumer が渡した event 参照をそのまま保持する。U6 rehydrate 側で initialState の structuredClone を行う。U5 の `load` で再度 structuredClone するかは迷ったが、DynamoEventStore が serialize→deserialize で自然に copy を返すのとの対称性 **のため U5 でも load 時に deep copy を検討 → 却下**。理由: contract が "同じ event 列を返す" 以上を要求していないため、consumer が mutate した場合は consumer 責務 (DEC-008 の型 ReadonlyDeep で防ぐ)
- **AbortSignal**: v0.2.0 で検討 (U4 参照)

---

## § Accepted Trade-offs

- `load` / `append` で deep copy しないため、consumer が返り値をキャストして mutate すると内部 state が壊れる。`ReadonlyArray` + `readonly` property で compile 時は防ぐ。runtime 防御は freeze を入れないかぎり不可。freeze は O(N) で overhead (DEC-008 rejected alternative と同じ議論)
- `allEvents` は insertionOrder を単一配列で保持するため、N stream × M events で O(N*M) メモリ。テスト用なので許容
- `clear()` を持たせると consumer が本番でも使える API になるが、docstring で "テスト専用" と明示することで回避

---

## § Unresolved

なし。

---

## § Links

- concept.md §5.8 InMemoryEventStore (canonical)
- DEC-006 EventStore interface の汎用性
- DEC-007 Version Model
- DEC-011 plain data (undefined 禁止)
- §1 痛み C (InMemory と本番の差異)
- U4 Contract Tests CT-01〜13
- Fact: JS event loop single-thread model — https://html.spec.whatwg.org/multipage/webappapis.html#event-loops (checked: 2026-04-17)
