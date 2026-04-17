import type { EventMap, EventsOf, StoredEventsOf } from "../core/types.js";

/**
 * Event Store の抽象インターフェース。
 *
 * 単一 Aggregate ストリームの `append` / `load` 契約だけを定義する。
 * `TMap` で型を貫通させ、入出力を型安全にする。
 * 件数上限・サイズ上限・fresh read の実現方法などの実装詳細は各実装の責務。
 *
 * Version Model (DEC-007):
 * - version は Aggregate ごとのローカル連番であり、グローバル連番ではない
 * - 空のストリームの Aggregate.version は 0
 * - 永続化済みイベントの version は 1 始まり
 * - expectedVersion は append 開始時点の Aggregate.version を表す
 * - append で N 件成功した後の Aggregate.version は expectedVersion + N
 * - append の返り値は expectedVersion + 1 から expectedVersion + N までの連番になる
 *
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 */
export interface EventStore<TMap extends EventMap> {
  /**
   * イベントを Aggregate ストリームにアトミックに追加する。
   *
   * Preconditions:
   * - `expectedVersion >= 0`
   * - `events.length >= 1` (空配列は `EventLimitError`)
   *
   * Postconditions:
   * - 返り値の長さ === events.length
   * - 返り値は入力 events と同じ順序で永続化される
   * - 返り値は version 昇順・連番の `StoredEvent` 配列
   * - 返り値[0].version === expectedVersion + 1
   * - 返り値[events.length - 1].version === expectedVersion + events.length
   * - 返り値の各 StoredEvent.aggregateId === 引数の aggregateId
   * - 返り値の各 StoredEvent.correlationId === options?.correlationId
   * - 返り値の各 StoredEvent.timestamp は ISO 8601 UTC
   *
   * Error conditions:
   * - expectedVersion と実際の最大バージョンが一致しない → `ConcurrencyError`
   * - events.length === 0 → `EventLimitError`
   * - 実装固有の制約超過 (件数・サイズ等) → 実装が定義するエラー
   */
  append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;

  /**
   * Aggregate の全イベントをバージョン順で読み込む。
   *
   * - 存在しない aggregateId に対しては空配列を返す (エラーではない)
   * - 直前に成功した `append` の結果を観測できることを保証する (fresh read)
   * - 返り値の各 StoredEvent.aggregateId === 引数の aggregateId
   * - 返り値は version 昇順・連番
   * - 返り値が空でない場合、最初の version は 1
   * - fresh read の実現方法は実装が責任を持つ
   */
  load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
}

/**
 * `append` のオプション。
 *
 * 将来の拡張 (AbortSignal 等) を breaking change にしないため、object に wrap する。
 */
export interface AppendOptions {
  /**
   * この append を起動した command / ingest event を identify する相関 ID。
   * 設定されると全 stored event の `correlationId` に複製され、OTel の
   * `messaging.message.correlation_id` や Projection の trace 連結に使える。
   * undefined のときは stored event に property 自体が付かない (DEC-011 plain data)。
   */
  readonly correlationId?: string;
}
