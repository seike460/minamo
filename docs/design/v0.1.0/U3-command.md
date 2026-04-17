# U3 — Command

**Upstream**: concept.md §5.3 Command
**Depends on**: U1, U2
**Applied constraints**: C1, C7
**Applied risks**: R2, R10

---

## 1. Unit 定義

Command Handler 型 (`CommandHandler`) と戻り値型 (`CommandResult`) を定義する。決定性・副作用なし・再試行安全 (DEC-005) を型レベルで強制することが本 unit の中核責務。

---

## 2. 公開 API (concept.md §5.3 逐字)

```ts
/** Command の実行結果: 0 個以上の DomainEvent */
export type CommandResult<TMap extends EventMap> = ReadonlyArray<EventsOf<TMap>>;

/**
 * Command Handler: 現在の Aggregate と input からイベントを決める同期の純粋関数。
 *
 * - executeCommand の再試行で複数回呼ばれうる
 * - 副作用（外部 API 呼び出し、I/O）を含めてはならない
 * - 非同期バリデーションが必要な場合は executeCommand の外で行い、結果を input に含める
 * - ビジネスルール違反時は例外を throw する
 * - 空配列を返すと「何もしない」を意味する（no-op command）
 */
export type CommandHandler<
  TState,
  TMap extends EventMap,
  TInput,
> = (
  aggregate: Aggregate<TState>,
  input: TInput,
) => CommandResult<TMap>;
```

---

## 3. Module 配置

- `src/command/types.ts` — 新規作成
- `src/index.ts` — `export type { CommandHandler, CommandResult } from "./command/types.js";`

---

## 4. Internal Types

なし。U6 の `executeCommand` ロジックが必要とする internal helper 型 (例: retry attempt state) は U6 側に置く。

---

## 5. Runtime 依存

- internal: U1 (`EventMap`, `EventsOf`), U2 (`Aggregate`)
- 型のみ、runtime output なし

---

## 6. Algorithm / 実装方針

型定義のみ。設計契約の核:

1. **戻り値が同期 `ReadonlyArray<EventsOf<TMap>>`**: `Promise<...>` を型で排除 (DEC-005)。async keyword を handler に付けた瞬間 compile error
2. **入力の immutability**: `Aggregate<TState>` は U2 で `ReadonlyDeep<TState>` を保持しているため、handler が state を書き換えると TS エラー
3. **空配列 = no-op**: U6 executeCommand が `result.length === 0` を検出して append をスキップする規約。型の上では length 0 の `readonly never[]` も成立する

---

## 7. Edge Cases

| ケース | 期待挙動 |
|---|---|
| handler が `[]` を return | U6 で no-op として扱われ、append 呼ばれない |
| handler が 1 件 return | U6 で append(aggregateId, events, expectedVersion=aggregate.version) |
| handler が 2 件以上 return | U6 で同じ TransactWriteItems で append。100 件超で EventLimitError (U8) |
| handler が throw | U6 は re-throw (retry しない, C8) |
| handler が `async` で宣言される | `Promise<readonly [...]>` は `ReadonlyArray<EventsOf<TMap>>` に代入不可で compile error |
| handler が fire-and-forget `setTimeout` / `Promise.resolve()` | 型で検出不可。DEC-005 の契約違反、code review + docs で扱う |
| input に `Date` が含まれる | DEC-011 で禁止 (plain data)。consumer が違反した場合 handler は通るが U8 append で marshall error |
| TInput = void | 型的には handler signature `(aggregate, input: void)` が成立。U6 呼び出し側で `input: undefined as void` を要求するため実用では TInput を object にするのが典型 |
| TMap = {} | `EventsOf<{}> = never`、`CommandResult<{}> = readonly never[]`、戻り値は `[]` 以外 impossible |

---

## 8. Test Plan

### 8.1 Type-level regression (`test/unit.test.ts`)

| case | assertion |
|---|---|
| `CommandHandler<number, { A: {x:1} }, {y:2}>` | `(aggregate: Aggregate<number>, input: {y:2}) => readonly DomainEvent<"A", {x:1}>[]` |
| handler が `async () => []` で定義 | compile error (Promise 返却) |
| handler が state を mutate (`state.x = 1`) | compile error (ReadonlyDeep) |
| `CommandResult<{ A: {x:1}, B: {y:2} }>` 要素 | `DomainEvent<"A", {x:1}> \| DomainEvent<"B", {y:2}>` |

### 8.2 Runtime test

本 unit は runtime code なし。U6 で handler が複数回呼ばれる test を必須化:

- ConcurrencyError 発生 → retry 時に handler が同一 aggregate + input で再呼び出しされ、同じ event 列が返ることを assert (R2)
- handler throw → retry されず伝播 (C8)

### 8.3 Test doubles

`test/fixtures/counter.ts` に `incrementHandler: CommandHandler<number, CounterEvents, {amount: number}>` を定義:

```ts
export const incrementHandler: CommandHandler<
  number,
  CounterEvents,
  { amount: number }
> = (aggregate, input) => {
  if (input.amount === 0) return [];
  if (aggregate.state + input.amount > 100) throw new Error("overflow");
  return [{ type: "Incremented", data: { amount: input.amount } }];
};
```

U6 test はこの fixture を使い retry determinism / throw propagation を検証する。

---

## 9. Performance

- 型のみ
- compile: TInput は通常 flat object のため instantiation cost は無視できる

---

## 10. Observability Hooks

executeCommand trace で以下を span attribute として投影予定 (v0.2.0):

- `minamo.command.input_hash` (consumer が opt-in して hash を渡す場合のみ)
- `minamo.command.event_count = result.length`
- `minamo.command.no_op = (result.length === 0)`

v0.1.0 は hook point を docs で明示。

---

## 11. Error Paths

- handler throw: U6 が検出し、`ConcurrencyError` でなければそのまま伝播 (C8)
- handler が non-array を return: `CommandResult` に代入不可で compile error
- handler が mutable array (`[]` without `as const` / 型注釈) を return: `readonly` 要求により共変で受け入れられるため compile OK (JS 配列は readonly に widening 可)

---

## 12. 2026 Trend Application

- **`NoInfer<TInput>` (TS 5.4+)**: 現状は適用しない。consumer が `executeCommand<S, M, I>({ handler, input })` で TInput を明示する方が推論が安定する。U6 で `NoInfer` を検討したが DEC 候補には入れず (v0.2.0 検討)
- **`satisfies` operator**: consumer 側で `const handler = (...) => [...] satisfies CommandResult<CounterEvents>;` が可能
- **Standard Schema v1**: input validation は handler の外で行うことを推奨。minamo 内部は `validate(schema, raw)` を提供 (既存 src/validation.ts)。DEC-015 候補

---

## § Accepted Trade-offs

- 型で防げる決定性違反は `Promise` 返却のみ。`Date.now()` / `Math.random()` / global state 参照は runtime でも検出困難 → DEC-010 で "input 注入" を規約化。code review + test で担保
- `CommandHandler` に `context` param を追加する案は DEC-010 で rejected。TInput に詰める方がシンプル
- 例外を Result 型 (`Result<E, CommandResult>`) にすると関数型派には嬉しいが、JS/TS エコシステムの既成 try/catch と乖離する。throw 統一で docs を分かりやすく

---

## § Unresolved

なし。

---

## § Links

- concept.md §5.3 (canonical)
- DEC-005 handler 決定性
- DEC-010 非決定要素は input 経由
- U1 `EventsOf`
- U2 `Aggregate`
- Fact: TS 5.4 NoInfer — https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-4.html (checked: 2026-04-17)
