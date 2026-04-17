import type { ReadonlyDeep } from "../types.js";

/**
 * ドメインイベント: 「何が起きたか」を表す不変のファクト。
 *
 * Aggregate の状態変更は必ず `DomainEvent` として表現する。
 * `type` はイベントの識別子、`data` は payload。
 *
 * @typeParam TType - イベント型名を表す string literal。
 * @typeParam TData - payload の型。`EventMap` 経由で与えると narrow される。
 */
export interface DomainEvent<TType extends string = string, TData = unknown> {
  /** イベント型の識別子 (`"Incremented"` など)。`EventMap` の key と 1:1 対応。 */
  readonly type: TType;
  /** payload。`EventMap` の value 型と一致する。 */
  readonly data: TData;
}

/**
 * 永続化されたイベント: Event Store が付与するメタデータを含む。
 *
 * `timestamp` は ISO 8601 UTC 形式 (例: `"2026-04-12T04:00:00.000Z"`)。
 * `correlationId` は `AppendOptions.correlationId` の値を optional で保持する。
 *
 * @typeParam TType - イベント型名。
 * @typeParam TData - payload の型。
 */
export interface StoredEvent<TType extends string = string, TData = unknown>
  extends DomainEvent<TType, TData> {
  /** 所属する Aggregate の ID (event stream key)。 */
  readonly aggregateId: string;
  /** Aggregate ごとのローカル連番 (DEC-007)。1 始まり、連続かつ一意。 */
  readonly version: number;
  /** append 時の ISO 8601 UTC timestamp (例: `"2026-04-17T00:00:00.000Z"`)。 */
  readonly timestamp: string;
  /** `AppendOptions.correlationId` の値 (未指定のときは property 自体が存在しない)。 */
  readonly correlationId?: string;
}

/**
 * イベント型名 → payload 型の対応表。
 *
 * Aggregate 毎に 1 つ定義し、`EventsOf` / `StoredEventsOf` / `Evolver` の
 * 型パラメータとして貫通させる。
 *
 * @example
 * ```ts
 * type CounterEvents = {
 *   Incremented: { amount: number };
 *   Reset: { reason: string };
 * };
 * ```
 */
export type EventMap = Record<string, unknown>;

/**
 * EventMap から `DomainEvent` の discriminated union を生成する。
 *
 * `EventsOf<{ A: X; B: Y }>` は `DomainEvent<"A", X> | DomainEvent<"B", Y>`。
 * `EventsOf<{}>` は `never`。
 */
export type EventsOf<TMap extends EventMap> = {
  [K in keyof TMap & string]: DomainEvent<K, TMap[K]>;
}[keyof TMap & string];

/**
 * EventMap から `StoredEvent` の discriminated union を生成する。
 *
 * `EventStore.load` / `EventStore.append` の返り値型に使う。
 */
export type StoredEventsOf<TMap extends EventMap> = {
  [K in keyof TMap & string]: StoredEvent<K, TMap[K]>;
}[keyof TMap & string];

/**
 * 状態進化関数のマップ: 各イベント型に対して state を進化させる純粋関数。
 *
 * - state と data は `ReadonlyDeep` で渡される。破壊的変更は型で禁止する
 * - 戻り値で次の state を明示的に返す
 * - 副作用を含めてはならない (`rehydrate` が複数回呼ぶ可能性がある)
 *
 * @typeParam TState - Aggregate の状態型。
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 */
export type Evolver<TState, TMap extends EventMap> = {
  [K in keyof TMap & string]: (state: ReadonlyDeep<TState>, data: ReadonlyDeep<TMap[K]>) => TState;
};
