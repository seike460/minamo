import type { ReadonlyDeep } from "../types.js";
import type { EventMap, Evolver } from "./types.js";

/**
 * Aggregate の定義: 初期状態とイベントごとの状態進化関数。
 *
 * `TState` は structured-cloneable な plain data に限定する。
 * `rehydrate` 時に `structuredClone` で `initialState` を複製するため、
 * 関数、Symbol、DOM ノード等を含む型は使用不可。
 * 公開 API では state は immutable view として扱う (DEC-008)。
 *
 * @typeParam TState - Aggregate の状態型 (structured-cloneable かつ DynamoDB marshallable な plain data)。
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 */
export interface AggregateConfig<TState, TMap extends EventMap> {
  /** 空ストリーム時の initial state。`rehydrate` が `structuredClone` で複製する。 */
  readonly initialState: ReadonlyDeep<TState>;
  /** 各 event type に対応する evolve 純関数のマップ。 */
  readonly evolve: Evolver<TState, TMap>;
}

/**
 * ハイドレーション済みの Aggregate: Load + Rehydrate の結果。
 *
 * `version` は Aggregate ごとのローカル連番。空ストリームは `0`、
 * 永続化済みイベントは `1` 始まり (DEC-007)。
 *
 * @typeParam TState - Aggregate の状態型。
 */
export interface Aggregate<TState> {
  /** Aggregate の識別子 (event stream key)。 */
  readonly id: string;
  /** rehydrate 済みの状態。`ReadonlyDeep` で compile 時に immutable 契約を強制。 */
  readonly state: ReadonlyDeep<TState>;
  /** 空ストリームは `0`、永続化済み event がある場合は最新 event の version。 */
  readonly version: number;
}
