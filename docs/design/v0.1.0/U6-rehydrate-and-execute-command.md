# U6 — rehydrate & executeCommand

**Upstream**: concept.md §5.6 Functions
**Depends on**: U1, U2, U3, U4 (interface), U7 (errors)
**Applied constraints**: C1, C4, C5, C7, C8
**Applied risks**: R1, R2, R9, R11, R12

---

## 1. Unit 定義

minamo の核となる 2 関数を提供する:

- `rehydrate<TState, TMap>(config, id, events)`: イベント列から Aggregate を構築
- `executeCommand<TState, TMap, TInput>({ config, store, handler, aggregateId, input, maxRetries?, correlationId? })`: Load → Rehydrate → Decide → Append の全サイクルを管理し、ConcurrencyError 発生時に Load から自動再試行

---

## 2. 公開 API (concept.md §5.6 逐字)

```ts
export declare function rehydrate<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
  id: string,
  events: ReadonlyArray<StoredEventsOf<TMap>>,
): Aggregate<TState>;

export declare function executeCommand<
  TState,
  TMap extends EventMap,
  TInput,
>(params: {
  config: AggregateConfig<TState, TMap>;
  store: EventStore<TMap>;
  handler: CommandHandler<TState, TMap, TInput>;
  aggregateId: string;
  input: TInput;
  maxRetries?: number;
  correlationId?: string;
}): Promise<{
  aggregate: Aggregate<TState>;
  newEvents: ReadonlyArray<StoredEventsOf<TMap>>;
}>;
```

---

## 3. Module 配置

- `src/command/execute.ts` — 新規作成 (both `rehydrate` and `executeCommand`)
- `src/index.ts` — `export { rehydrate, executeCommand } from "./command/execute.js";`

本来 rehydrate は Aggregate 構築関数で command と独立とも言えるが、executeCommand 内で必ず一緒に使われ、同一モジュールに置くことで型ジェネリクスの import を抑制できる。

---

## 4. Internal Types

```ts
// executeCommand の試行状態 (internal)
interface Attempt<TState, TMap extends EventMap> {
  readonly attemptIndex: number;   // 0 = 初回, 1+ = retry
  readonly events: ReadonlyArray<StoredEventsOf<TMap>>;
  readonly aggregate: Aggregate<TState>;
}

// rehydrate の検証結果
type ValidationResult =
  | { ok: true }
  | { ok: false; reason: InvalidEventStreamReason; details: InvalidEventStreamDetails };
```

---

## 5. Runtime 依存

- internal: U1 (`EventMap`, `StoredEventsOf`), U2 (`Aggregate`, `AggregateConfig`), U3 (`CommandHandler`), U4 (`EventStore`), U7 (`ConcurrencyError`, `InvalidEventStreamError`)
- 標準組み込み: `structuredClone` (Node 17+ global; C6 前提)
- AWS SDK: 不使用

---

## 6. Algorithm / 実装方針

### 6.1 rehydrate

```text
function rehydrate<TState, TMap>(config, id, events):
  # Step 1: validate events stream (R9)
  for i in 0..events.length-1:
    e = events[i]
    if e.aggregateId !== id:
      throw InvalidEventStreamError(id, "aggregateId_mismatch", ..., {
        eventIndex: i, expectedAggregateId: id, actualAggregateId: e.aggregateId
      })
    expectedVersion = i + 1
    if i === 0 and e.version !== 1:
      throw InvalidEventStreamError(id, "invalid_initial_version", ..., {
        eventIndex: 0, expectedVersion: 1, actualVersion: e.version
      })
    if i > 0 and e.version <= events[i-1].version:
      throw InvalidEventStreamError(id, "non_monotonic_version", ..., {
        eventIndex: i, expectedVersion: events[i-1].version + 1, actualVersion: e.version
      })
    if i > 0 and e.version !== events[i-1].version + 1:
      throw InvalidEventStreamError(id, "version_gap", ..., {
        eventIndex: i, expectedVersion: events[i-1].version + 1, actualVersion: e.version
      })
    if !(e.type in config.evolve):
      throw InvalidEventStreamError(id, "missing_evolve_handler", ..., {
        eventIndex: i, eventType: e.type
      })

  # Step 2: initialState を structuredClone で複製 (DEC-008 / C6 / R12)
  state = structuredClone(config.initialState)

  # Step 3: イベントを順次 evolve で適用
  for e in events:
    handler = config.evolve[e.type]
    state = handler(state, e.data)

  # Step 4: Aggregate を返す
  return {
    id,
    state: freeze(state) as ReadonlyDeep<TState>,   # compile-time cast のみ
    version: events.length,
  }
```

**validation 順序の意味**:

1. `aggregateId_mismatch` を最優先: id が違う event は他 Aggregate の混入で意味論的に最も重大
2. `invalid_initial_version`: stream head の整合性 (version=1 始まり C4)
3. `non_monotonic_version`: 逆戻り検出。`version_gap` より緩い条件 (`v[i].version <= v[i-1].version`)
4. `version_gap`: +1 ちょうどでない
5. `missing_evolve_handler`: 後続ステージで evolve が死ぬ前に検出

順序は implementation-defined だが doc で固定し、test で固定順序を assert する (壊れた stream の分類不変性のため)。

**version / gap 検出のコストを O(N)** に抑えるため、1 pass で順次検証 + 適用を同時に行っても良い。設計上は validation と evolve を分離して書いた方が可読性が高く、N ≤ 1000 想定では問題ない。

### 6.2 executeCommand

```text
async function executeCommand<TState, TMap, TInput>(params):
  { config, store, handler, aggregateId, input, maxRetries = 3, correlationId } = params

  # Step 0: maxRetries の validation (C4, R11)
  if !Number.isInteger(maxRetries) or maxRetries < 0:
    throw new RangeError(
      `maxRetries must be a non-negative integer, got: ${String(maxRetries)}`
    )

  # Step 1: 試行ループ
  let lastConcurrency: ConcurrencyError | null = null
  for (attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex++):
    # 1a. Load
    events = await store.load(aggregateId)
    # 1b. Rehydrate
    aggregate = rehydrate(config, aggregateId, events)
    # 1c. Decide
    decided = handler(aggregate, input)    # 同期呼び出し (DEC-005)

    # 1d. No-op check (DEC-005)
    if decided.length === 0:
      return { aggregate, newEvents: [] }

    # 1e. Append
    try:
      newEvents = await store.append(
        aggregateId,
        decided,
        aggregate.version,
        correlationId !== undefined ? { correlationId } : undefined,
      )
      # 成功 — 返す Aggregate は evolve を再適用したもの
      updatedState = structuredClone(aggregate.state)
      for e in newEvents:
        updatedState = config.evolve[e.type](updatedState, e.data)
      return {
        aggregate: { id: aggregateId, state: updatedState, version: aggregate.version + newEvents.length },
        newEvents,
      }
    catch (err):
      if err instanceof ConcurrencyError:
        lastConcurrency = err
        continue    # retry
      throw err    # C8: その他は即伝播 (handler throw, SDK error, EventLimitError, InvalidEventStreamError)

  # ループ抜けた = retry 枯渇
  throw lastConcurrency!    # 非 null (少なくとも 1 回 append を試行してる)
```

### 6.3 設計判断の理由

- **retry 対象は ConcurrencyError のみ** (C8, DEC-012)
- **maxRetries は「追加」の回数** (C4, DEC-007)。ループは `<= maxRetries` で `1 + maxRetries` 回試行
- **no-op short-circuit は 1e 直前**。append を呼ばないため version も進まない (concept.md §4)
- **成功後の Aggregate 再構築**: `newEvents` に対して evolve を再適用する方法を採用。理由は (1) `rehydrate` を再呼び出しすると load を再度呼ぶことになり不要、(2) DynamoEventStore で append が返す stored events に server-assigned metadata (timestamp) が入るため、consumer に返す Aggregate はこの最新 data を反映すべき
- **structuredClone で state を複製**: evolve 呼び出し前後で state を可変にできるよう local copy を使う。original `aggregate.state` は immutable view 契約 (C5)
- **correlationId が undefined の場合 options を undefined にする**: spread によるプロパティ省略 (DEC-011)

---

## 7. Edge Cases

| ケース | 期待挙動 |
|---|---|
| `maxRetries = 0` | 初回のみ 1 回試行。ConcurrencyError なら throw |
| `maxRetries = 3` | 初回 + retry 3 回 = 計 4 回 |
| `maxRetries = -1` | RangeError (Load 前) |
| `maxRetries = 1.5` | RangeError (Load 前) |
| `maxRetries = NaN` | RangeError |
| `maxRetries = Infinity` | RangeError (Number.isInteger(Infinity) = false) |
| handler が `[]` を return | no-op、`newEvents: []`、version 不変 |
| handler が throw | そのまま伝播。retry しない |
| ConcurrencyError 後 retry で成功 | 新 aggregate + newEvents を返す |
| ConcurrencyError 後 retry で handler が throw (新 state で違反) | handler の throw を伝播 (C8, concept.md §4) |
| `store.load` が version_gap な events を返す | rehydrate が InvalidEventStreamError throw (concept.md §5.6 postcondition) |
| `store.load` が他 aggregateId の event を返す | rehydrate が aggregateId_mismatch throw |
| `correlationId` undefined | append options = undefined |
| `correlationId = "abc"` | append options = {correlationId:"abc"} |
| `EventLimitError` | retry しない、そのまま伝播 (C8) |
| `rehydrate` の events = [] | version=0、state=initialState clone で成功 |

---

## 8. Test Plan

### 8.1 Unit tests for `rehydrate`

| case | assertion |
|---|---|
| CT-RH-01 events=[] | `{id, state: initialState (cloned), version: 0}` |
| CT-RH-02 events=[v1] | state = evolve(initial, v1.data), version=1 |
| CT-RH-03 events=[v1,v2,v3] | state = fold, version=3 |
| CT-RH-04 events[0].version = 2 | InvalidEventStreamError(invalid_initial_version, details: {eventIndex:0, expected:1, actual:2}) |
| CT-RH-05 events[0].version=1, events[1].version=3 | version_gap(eventIndex:1, expected:2, actual:3) |
| CT-RH-06 events[0].version=1, events[1].version=1 | non_monotonic_version(eventIndex:1, expected:2, actual:1) |
| CT-RH-07 events[i].aggregateId = "other" | aggregateId_mismatch(eventIndex:i, expected:id, actual:"other") |
| CT-RH-08 unknown event type | missing_evolve_handler(eventIndex:i, eventType) |
| CT-RH-09 initialState に Date (非 plain) | structuredClone 通過 (Date はクローン可能)。ただし DynamoDB 側で marshall error なので consumer 責務 |
| CT-RH-10 initialState に Function | structuredClone で DataCloneError (R12)。throw を assert |
| CT-RH-11 state immutability | 返り値 aggregate.state に TS の readonly 属性が付く (expectTypeOf) |
| CT-RH-12 detect 順序 | [aggId mismatch + version gap] を同時に持つ event → aggId mismatch 優先 |

### 8.2 Unit tests for `executeCommand`

test double を使い deterministic に検証:

| case | double | assertion |
|---|---|---|
| CT-EC-01 初回成功 | InMemory | handler 1 回、aggregate.version 増加、newEvents に expected type |
| CT-EC-02 no-op | InMemory + handler returns [] | newEvents=[], version 不変、append 未呼び出し (CountingStore.appendCalls=0) |
| CT-EC-03 maxRetries=0 + ConcurrencyError | FailOnce | ConcurrencyError 伝播 (retry なし) |
| CT-EC-04 maxRetries=3 + FailOnce | FailOnce | 成功、handler 2 回呼ばれる |
| CT-EC-05 maxRetries=3 + AlwaysFail | AlwaysFail | ConcurrencyError 伝播、handler 4 回呼ばれる |
| CT-EC-06 maxRetries=-1 | — | RangeError (Load 前 = store.load 未呼び出し) |
| CT-EC-07 maxRetries=1.5 | — | RangeError |
| CT-EC-08 maxRetries=NaN | — | RangeError |
| CT-EC-09 maxRetries=Infinity | — | RangeError |
| CT-EC-10 handler throws domain error | InMemory | error 伝播、append 未呼び出し |
| CT-EC-11 append 成功後 version 正 | InMemory | aggregate.version = initial + newEvents.length |
| CT-EC-12 retry 後の state は最新 | FailOnce (再 load で新イベントを返す) | 2 回目の handler が new state を受け取る |
| CT-EC-13 retry 後 input 不変 | FailOnce | 2 回目も同じ input が渡る (R2) |
| CT-EC-14 correlationId 伝搬 | InMemory | append options.correlationId, newEvents[*].correlationId |
| CT-EC-15 correlationId undefined | InMemory | stored events に correlationId property なし |
| CT-EC-16 retry-safe: 同じ event を返す | FailOnce + deterministic handler | 2 回目の handler 呼び出しで同じ event array |
| CT-EC-17 EventLimitError 伝播 | InMemory + handler returns 0 件 (実は CT-EC-02 で no-op) — ここは events=[] を直接 append する test は InMemoryEventStore 側にあるので、execute 側では EventLimitError が handler 外の原因で出るケースを検証不能 | — |
| CT-EC-18 handler が null/undefined return | TS で compile error。runtime テスト不要 |

### 8.3 Contract tests との交差

U6 は rehydrate/executeCommand の単体 test が中心。EventStore の振る舞い一致は U4 Contract Tests に委任。

### 8.4 Type-level regression

| case | assertion |
|---|---|
| `rehydrate<number, CounterEvents>(...)` | `Aggregate<number>` |
| `executeCommand<number, CounterEvents, {amount:number}>(...)` 戻り値 | `Promise<{aggregate: Aggregate<number>; newEvents: readonly StoredEvent<"Incremented", {amount:number}>[]}>` |
| `maxRetries: "3"` | compile error |
| `correlationId: 42` | compile error |

### 8.5 Test doubles

`test/doubles/event-store-doubles.ts`:

```ts
class FailOnce<TMap>: implements EventStore<TMap>
  - wraps InMemoryEventStore
  - 1 回目 append で ConcurrencyError を強制 throw、2 回目以降は委譲

class AlwaysFail<TMap>: implements EventStore<TMap>
  - 常に ConcurrencyError throw

class CountingStore<TMap>: implements EventStore<TMap>
  - wraps EventStore、loadCalls / appendCalls をカウント
```

`test/fixtures/counter.ts`: counter Aggregate config + handler (U3 で定義したもの)

---

## 9. Performance

- rehydrate: O(N) (N=events.length)
- executeCommand (best case, no retry): O(N) load + O(1) handler + O(N+M) append where M=new events
- retry 時: O((1 + maxRetries) × N)
- structuredClone は O(|state|)。large state (>10KB) で slow報告あれば consumer が snapshot を検討 (OQ-1)
- v1 は snapshot なし。Aggregate 粒度が短いことを前提 (concept.md §3)

---

## 10. Observability Hooks

v0.2.0 で以下 span 構造を予定:

```text
span: minamo.execute_command
  attributes:
    minamo.aggregate.id
    minamo.aggregate.initial_version
    minamo.aggregate.final_version
    minamo.command.no_op: boolean
    minamo.command.event_count
    minamo.command.retry_count (attemptIndex - 1)
    messaging.message.correlation_id? (only if present)
  child spans:
    minamo.event_store.load
    minamo.event_store.append
    (rehydrate は同期、child span 無し)
```

v0.1.0 は hook point 記述のみ。実装は U8 / v0.2.0 timeline に先送り。

---

## 11. Error Paths

| Error | 条件 | retry? |
|---|---|---|
| `RangeError` | maxRetries 不正 | Load 前に throw |
| `ConcurrencyError` | append で expectedVersion 不一致 | retry (C8) |
| `InvalidEventStreamError` | rehydrate validation 失敗 | retry しない (C8) |
| `EventLimitError` | append の pre-flight (U8) | retry しない (C8) |
| handler throw (any Error) | handler 内のビジネス検証 | retry しない (C8) |
| AWS SDK エラー | store.append / load 固有 | retry しない (C8) |

最終 retry exhausted: 最後の `ConcurrencyError` をそのまま throw (concept.md §4)。`RetryExhaustedError` は v0.1.0 では **導入しない** (concept.md §5 型シグネチャに存在しないため、独自 error 追加は逐字違反)。`lastConcurrency` をそのまま throw。

→ v0.1.0.md §6 "DEC-017 候補" との整合性: v0.1.0.md §3 の U7 に "RetryExhaustedError (§5.5 定義分)" とあるが、concept.md §5.5 には RetryExhaustedError の型は **存在しない**。これは v0.1.0.md の記述ミス / Spike 期の暫定判断であり、concept.md 逐字準拠を優先して導入しない。U7 design doc で同件を明示。

---

## 12. 2026 Trend Application

- **structuredClone** (Node 17+): C6 下で活用
- **AbortSignal** (Node 24): v0.2.0 で `executeCommand({ signal })` を追加する余地。`signal.aborted` で retry loop 脱出、`signal.throwIfAborted()` で AbortError を伝播
- **Error cause chain** (ES2022): v0.1.0 では最後の ConcurrencyError を直接 throw するため cause chain なし。v0.2.0 で `RetryExhaustedError { cause: ConcurrencyError }` を追加する場合に採用予定

---

## § Accepted Trade-offs

- retry 試行数を loop の `<=` で数える設計。`< (1 + maxRetries)` とどちらでも可だが、読みやすさで `<=` を選択。unit test で境界 (0, 3) を固定
- 最終 retry exhausted で独自 error を投げない。`RetryExhaustedError` を入れると retry した回数や cause を保持できるが、concept.md §5 逐字違反になる。v0.2.0 で DEC を起こし検討
- rehydrate の validation を 1 pass (validation + evolve 同時) にしない。可読性優先
- `structuredClone` を失敗した場合の error は `DataCloneError` (DOMException)。`InvalidEventStreamError` に wrap せず透過する (consumer が DEC-011 違反を気づきやすい)。ただし doc で明示

---

## § Unresolved

- v0.1.0.md §6 と concept.md §5.5 の `RetryExhaustedError` 不整合は concept.md 逐字準拠で解決済。v0.1.0.md の §3 U7 記述は実装フェーズで修正 (本 PR スコープ外)

---

## § Links

- concept.md §5.6 (canonical), §4 executeCommand 再試行契約
- DEC-005 handler 同期・純粋
- DEC-007 Version Model / maxRetries 数え方
- DEC-008 immutable view
- DEC-010 非決定要素 input 注入
- DEC-011 plain data (structuredClone 互換)
- DEC-012 即時 retry
- U1 `StoredEventsOf`
- U2 `Aggregate`, `AggregateConfig`
- U3 `CommandHandler`
- U4 `EventStore`
- U7 `ConcurrencyError`, `InvalidEventStreamError`
- Fact: MDN structuredClone — https://developer.mozilla.org/en-US/docs/Web/API/Window/structuredClone (checked: 2026-04-17)
- Fact: ES2022 Error cause — https://tc39.es/proposal-error-cause/ (checked: 2026-04-17)
