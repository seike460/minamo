# U2 — Aggregate

**Upstream**: concept.md §5.2 Aggregate
**Depends on**: U1
**Applied constraints**: C1, C5, C6
**Applied risks**: R12

---

## 1. Unit 定義

Aggregate 定義型 (`AggregateConfig`) と hydrated Aggregate 型 (`Aggregate`) を提供する。U6 rehydrate の結果型、U3 CommandHandler の第 1 引数、U8 DynamoEventStore の TMap 推論起点として全層で使われる。

---

## 2. 公開 API (concept.md §5.2 逐字)

```ts
/**
 * Aggregate の定義: 初期状態とイベントごとの状態進化関数。
 *
 * TState は structured-cloneable な plain data に限定する。
 * rehydrate 時に structuredClone で initialState を複製するため、
 * 関数、Symbol、DOM ノード等を含む型は使用不可。
 * 公開 API では state は immutable view として扱う。
 */
export interface AggregateConfig<TState, TMap extends EventMap> {
  readonly initialState: ReadonlyDeep<TState>;
  readonly evolve: Evolver<TState, TMap>;
}

/** ハイドレーション済みの Aggregate: Load + Rehydrate の結果 */
export interface Aggregate<TState> {
  readonly id: string;
  readonly state: ReadonlyDeep<TState>;
  readonly version: number;
}
```

---

## 3. Module 配置

- `src/core/aggregate.ts` — 新規作成
- `src/index.ts` — `export type { AggregateConfig, Aggregate } from "./core/aggregate.js";`

---

## 4. Internal Types

内部 helper なし。U6 の `rehydrate` 内で `Aggregate<TState>` を構築するヘルパーは U6 に配置する (本 unit には置かない)。

---

## 5. Runtime 依存

- internal: U1 (`EventMap`, `Evolver`, `ReadonlyDeep`)
- AWS SDK: 不使用
- 型のみ、runtime output なし

---

## 6. Algorithm / 実装方針

型定義のみ。invariant の記述:

- `AggregateConfig.initialState` は consumer が `satisfies` で固定する literal を許容するが、ライブラリ側は `ReadonlyDeep<TState>` として受ける
- `Aggregate.state` は immutable view。consumer が `as TState` で書き戻すのは禁止 (DEC-008 の意図)
- `Aggregate.version` は非負整数。初期状態は 0 (C4)

---

## 7. Edge Cases

| ケース | 期待挙動 |
|---|---|
| `initialState: null` | 型的に可能 (`TState = null`)。rehydrate が返す state は `null` になる |
| `initialState: 0` (number) | C6 plain data に含まれる。変更後の state も number なら問題なし |
| `initialState: undefined` | **禁止**。C6 の "undefined は値として扱わない" に抵触。TypeScript 上は `TState = undefined` で成立するが、runtime で structuredClone を通っても DynamoDB marshall で失敗するため、consumer docs で非推奨を明示 |
| `evolve` の一部 key 未定義 | `Evolver<TState, TMap>` の mapped type で compile error (U1 spec) |
| `evolve` で state を mutate して return | `ReadonlyDeep` で compile error。ただし consumer が `as TState` で escape すれば runtime で通る (設計契約違反) |
| `TState` が class instance | C6 で禁止。compile で止めないため consumer 責務 (typedoc と DEC-011 で強警告) |
| `TState` が `readonly` tuple | IsTuple で tuple 構造保持 |
| `TState` に Map/Set/Date | C6 で禁止。structuredClone は通るが DynamoDB marshall で round-trip 失敗。doc で警告 |

---

## 8. Test Plan

### 8.1 Type-level regression

| case | assertion |
|---|---|
| `AggregateConfig<number, { A: {x:1} }>` | `initialState: ReadonlyDeep<number>` (= `number`) を持つ |
| `AggregateConfig<{a:1}, { B: void }>` | `evolve.B: (state: readonly {a:1}, data: never) => {a:1}` |
| `Aggregate<{n:number}>.state` | `ReadonlyDeep<{n:number}>` に narrow |
| `AggregateConfig` で `evolve` key 不足 | compile error |

### 8.2 Runtime test

- U2 自身は runtime code なし
- U6 rehydrate の test で間接検証

### 8.3 Test doubles

U6 で使う "counter" fixture (`AggregateConfig<number, { Incremented: {amount:number} }>`) を `test/fixtures/counter.ts` として配置。U2 自身の test ではこの fixture を import して型推論を確認。

---

## 9. Performance

- 型のみ、runtime コスト 0
- compile time: `Evolver<TState, TMap>` の mapped type は TMap のキー数に比例 (O(|keys|))

---

## 10. Observability Hooks

`Aggregate.id` / `Aggregate.version` は U6 executeCommand の結果 trace で以下の span attribute として投影される (v0.2.0):

- `minamo.aggregate.id = aggregate.id`
- `minamo.aggregate.version = aggregate.version`

v0.1.0 は hook point を docs で明示するのみ。実装は U6 / U8 に先送り。

---

## 11. Error Paths

本 unit は runtime 例外を throw しない。

---

## 12. 2026 Trend Application

- **`satisfies` operator**: consumer docs で `const counter = { initialState: 0, evolve: { ... } } satisfies AggregateConfig<number, CounterEvents>;` を推奨。ライブラリ API は satisfies を要求しない
- **structuredClone (Node 17+)**: U6 で initialState 複製に使う。U2 の型契約 (plain data only) がこの前提を支える
- **Temporal API**: 採用しない。`timestamp` は ISO 8601 string (U1)。Temporal は Node 24 LTS で未 stable

---

## § Accepted Trade-offs

- `Aggregate.state` を `ReadonlyDeep` で expose することで、consumer が state を直接 Read Model の表示に使うと型が過度に readonly になり UI library 側で `readonly [] not assignable to []` エラーが出る可能性。対策は consumer 側で `structuredClone` + cast で mutable copy を作る。ライブラリ側は immutability を貫く
- `id` を `string` に固定。branded type (`AggregateId`) を導入するとユーザビリティが下がる (DEC-007 rejected alternative (c) と同じ理由)

---

## § Unresolved

なし。

---

## § Links

- concept.md §5.2 (canonical)
- DEC-008 immutable view
- DEC-011 plain data 制約 (structuredClone 互換)
- U1 Core Types (ReadonlyDeep, EventMap, Evolver)
- Fact: structuredClone algorithm — https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal (checked: 2026-04-17)
