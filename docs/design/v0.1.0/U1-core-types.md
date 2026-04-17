# U1 — Core Types

**Upstream**: concept.md §5.1 Core Types
**Depends on**: —
**Applied constraints**: C1, C5, C6
**Applied risks**: R10

---

## 1. Unit 定義

minamo 全 unit の型基盤。`DomainEvent` / `StoredEvent` / `EventMap` / `EventsOf` / `StoredEventsOf` / `ReadonlyDeep` / `IsTuple` / `Evolver` を提供する。`ReadonlyDeep` / `IsTuple` は Spike 済 (src/types.ts:1-39)。本 unit では **残り API を concept.md §5.1 と 1 文字違わずに** 整備する。

依存: なし (minamo の最下層)。
下流: U2〜U9 全て。

---

## 2. 公開 API (concept.md §5.1 逐字)

```ts
/** ドメインイベント: 「何が起きたか」を表す不変のファクト */
export interface DomainEvent<
  TType extends string = string,
  TData = unknown,
> {
  readonly type: TType;
  readonly data: TData;
}

/**
 * 永続化されたイベント: Event Store が付与するメタデータを含む。
 * timestamp は ISO 8601 UTC 形式（例: "2026-04-12T04:00:00.000Z"）。
 */
export interface StoredEvent<
  TType extends string = string,
  TData = unknown,
> extends DomainEvent<TType, TData> {
  readonly aggregateId: string;
  readonly version: number;
  readonly timestamp: string;
  readonly correlationId?: string;
}

/** イベント型名 → payload 型の対応表 */
export type EventMap = Record<string, unknown>;

/** EventMap から DomainEvent のユニオン型を生成 */
export type EventsOf<TMap extends EventMap> = {
  [K in keyof TMap & string]: DomainEvent<K, TMap[K]>;
}[keyof TMap & string];

/** EventMap から StoredEvent のユニオン型を生成 */
export type StoredEventsOf<TMap extends EventMap> = {
  [K in keyof TMap & string]: StoredEvent<K, TMap[K]>;
}[keyof TMap & string];

/** object / array / tuple を再帰的に readonly 化する */
export type ReadonlyDeep<T> =
  T extends (...args: any[]) => unknown ? T :
  T extends readonly unknown[]
    ? IsTuple<T> extends true
      ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
      : ReadonlyArray<ReadonlyDeep<T[number]>>
    : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } :
  T;

type IsTuple<T extends readonly unknown[]> =
  number extends T["length"]
    ? T extends readonly [unknown, ...unknown[]] | readonly [...unknown[], unknown]
      ? true
      : false
    : true;

/**
 * 状態進化関数のマップ: 各イベント型に対して state を進化させる純粋関数。
 */
export type Evolver<TState, TMap extends EventMap> = {
  [K in keyof TMap & string]: (
    state: ReadonlyDeep<TState>,
    data: ReadonlyDeep<TMap[K]>,
  ) => TState;
};
```

---

## 3. Module 配置

- `src/core/types.ts` — 新規作成。`DomainEvent`, `StoredEvent`, `EventMap`, `EventsOf`, `StoredEventsOf`, `Evolver` を export
- `src/types.ts` — 既存 `ReadonlyDeep`, `IsTuple` を保持 (touch しない)
- `src/index.ts` — `export type { ... } from "./core/types.js";` を追加

U1 では src/types.ts を move しない理由: Spike 期の import グラフ (`src/index.ts` → `src/types.js`) を維持して diff を最小化する。U2 以降で必要なら再整理を検討するが、本 unit では out-of-scope。

---

## 4. Internal Types

本 unit で公開しない内部型はなし。`IsTuple` は typedoc の `intentionallyNotExported` で既に除外済 (typedoc.json)。

---

## 5. Runtime 依存

- internal: なし
- AWS SDK peer: 不使用
- Standard Schema: 不使用

U1 は型のみ。runtime code は emit されない (tsdown の ESM 出力は export const のみ)。

---

## 6. Algorithm / 実装方針

型定義のみで runtime ロジックなし。以下を保証する構造:

1. **`EventsOf<TMap>`**: mapped type + indexed access で distributed union を生成する。`[keyof TMap & string]` の indexed access は各 K で `DomainEvent<K, TMap[K]>` を作り union 化する
2. **`StoredEventsOf<TMap>`**: 同様の distributed union。`StoredEvent extends DomainEvent` により `aggregateId` / `version` / `timestamp` / `correlationId?` を含む
3. **`Evolver<TState, TMap>`**: mapped type でイベント type 名毎の handler を強制。`ReadonlyDeep<TState>` と `ReadonlyDeep<TMap[K]>` で data/state を immutable view 化する (C5)

---

## 7. Edge Cases

| ケース | 期待挙動 |
|---|---|
| `TMap = {}` (空 EventMap) | `EventsOf<{}>` は `never`。handler の戻り値 `CommandResult<{}>` も `readonly never[]` (= `readonly []`) |
| `TMap = { A: void }` | `DomainEvent<"A", void>` が生成される。data 必須 (omit はできない) |
| `TData = unknown` default | 未指定時は `unknown`。consumer の narrow を強制 |
| 重複 type 名 | `Record<string, unknown>` なので TS 的に可能だが、EventMap は最終的にユニオンなので重複は type 衝突で reject される (`EventMap` として定義時は key 一意) |
| non-string key | `[K in keyof TMap & string]` で string key のみ抽出 (symbol/number key は無視) |
| `ReadonlyDeep<TState>` で TState に function を含む | function は `T extends (...args: any[]) => unknown ? T :` で identity。immutable readonly は関数に適用されない |
| `ReadonlyDeep<TState>` で variadic tuple | `IsTuple` が `true` を返し、indexed mapped type で tuple 構造保持 |
| `ReadonlyDeep<TState>` で `readonly [string, ...number[]]` | variadic tuple と判定、`{ readonly [K in keyof T]: ReadonlyDeep<T[K]> }` で元構造保持 |

---

## 8. Test Plan

### 8.1 Type-level regression (`test/unit.test.ts` / `test/types.test-d.ts`)

expectTypeOf で以下を検証:

| case | assertion |
|---|---|
| `EventsOf<{ A: {x: 1}; B: {y: 2} }>` | `DomainEvent<"A", {x:1}> \| DomainEvent<"B", {y:2}>` |
| `EventsOf<{}>` | `never` |
| `StoredEventsOf<TMap>` の要素 | `aggregateId: string; version: number; timestamp: string; correlationId?: string` を含む |
| `Evolver<S, { A: {x:1} }>` | `{ A: (state: ReadonlyDeep<S>, data: ReadonlyDeep<{x:1}>) => S }` に代入可能 |
| `Evolver` で key 不足 | handler 未定義で compile error |
| `Evolver` で余分な key | excess property で compile error (strict object types) |
| `ReadonlyDeep<[1, 2]>` | `readonly [1, 2]` (IsTuple) |
| `ReadonlyDeep<readonly [string, ...number[]]>` | variadic tuple 保持 (Spike 期に regression test 済) |
| `ReadonlyDeep<(x: number) => string>` | `(x: number) => string` (function は identity) |

### 8.2 Runtime test

U1 自身は runtime code を持たない。下流 unit (U6 rehydrate) の test で間接検証。

### 8.3 Test doubles

不要。

---

## 9. Performance

- Type-only unit。compile time のみ。`EventsOf` / `StoredEventsOf` の distributed conditional は `TMap` のキー数に比例 (O(|keys|))
- tsc の instantiation depth は EventMap の深さに依存。deeply nested EventMap (>10 level) で slow compile 報告があれば flatten を検討
- runtime: 0 byte (type-only export は dist に emit されない)

---

## 10. Observability Hooks

本 unit は型のみで trace 対象なし。ただし `StoredEvent.correlationId` が存在することが U8 append 時の OpenTelemetry span 属性に投影される (v0.2.0 実装時に `messaging.message.id` または `messaging.message.correlation_id` として参照)。

---

## 11. Error Paths

throw せず。型は instantiate 時に "Type 'X' is not assignable to type 'Y'" で compile error を出す。

---

## 12. 2026 Trend Application

- **`NoInfer<T>` (TS 5.4+)**: U3 の `CommandHandler<TState, TMap, TInput>` で `NoInfer<TMap>` を検討中。U1 では適用しない (推論方向を塞ぐと downstream unit が壊れる)
- **`const` type parameter (TS 5.0+)**: consumer が `const counter = { ... } as const;` を使うケースは consumer 責務。ライブラリ側で `<const T>` を入れるとユニオン合成が widening 抑制に寄せすぎる
- **`satisfies` operator (TS 4.9+)**: consumer sample で推奨 (concept.md §4 最小コード例)。ライブラリ API には現れない
- **`infer X extends Y` (TS 4.7+)**: 直接は使わない。`EventsOf` の indexed access で代替

---

## § Accepted Trade-offs

- `DomainEvent<TType extends string>` の default を `string` にした結果、consumer が型ジェネリクスを省略すると `DomainEvent<string, unknown>` に広がる。minamo 公開 API では必ず `TMap` 経由で狭めるため実害なし
- `StoredEventsOf<TMap>` の `correlationId?: string` を optional のままに。`AppendOptions.correlationId` を undefined で呼んだ場合に property が存在しないのが正しい観測可能状態 (C6: undefined を plain data に入れない)
- `ReadonlyDeep<TState>` を関数 arg に入れるため、consumer が state の一部を mutate した後 return すると TS エラー。これは DEC-008 の狙いそのものであり trade-off ではなく contract

---

## § Unresolved

なし。

---

## § Links

- concept.md §5.1 (canonical)
- DEC-008 immutable view
- DEC-011 plain data 制約
- Spike: src/types.ts (ReadonlyDeep / IsTuple 実装)
- Fact: TypeScript distributed conditional types — https://www.typescriptlang.org/docs/handbook/2/conditional-types.html (checked: 2026-04-17)
