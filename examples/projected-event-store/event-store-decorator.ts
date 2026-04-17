/**
 * ProjectedEventStore — `EventStore<TMap>` を wrap して、append 成功後に
 * projection callback を同期実行する Decorator recipe。
 *
 * minamo 本体は projection 層を契約しない。Stream → Read Model 配信は consumer 責務
 * だが、local 開発 / テスト runtime では「append の直後に projection を走らせたい」
 * 場面がある。本ファイル ~50 行をプロジェクトにコピーして使う想定。
 *
 * 設計判断: `onAppended` / `onAppendedError` がいずれも throw しても握りつぶす。
 * event はすでに永続化済みで、projection 失敗を上位に伝えると caller が "append 失敗"
 * と誤認して retry を走らせ duplicate command effect を誘発する。DynamoDB Streams の
 * 非同期セマンティクス (projection 失敗は append を巻き戻さない) と挙動を揃える判断。
 * 観測したい場合は `onAppendedError` に logger / OTel span を渡す。
 *
 * projection 失敗を command 呼び出し側に伝えたい場合は、このファイルをコピーして
 * try/catch を外した variant を作る。本 recipe と本体契約は独立している。
 */
import type {
  AppendOptions,
  EventMap,
  EventStore,
  EventsOf,
  StoredEventsOf,
} from "../../src/index.js";

export type ProjectionCallback<TMap extends EventMap> = (
  stored: ReadonlyArray<StoredEventsOf<TMap>>,
) => void | Promise<void>;

export type ProjectionErrorCallback = (err: unknown) => void;

export class ProjectedEventStore<TMap extends EventMap> implements EventStore<TMap> {
  readonly #inner: EventStore<TMap>;
  readonly #onAppended: ProjectionCallback<TMap>;
  readonly #onAppendedError: ProjectionErrorCallback | undefined;

  constructor(
    inner: EventStore<TMap>,
    onAppended: ProjectionCallback<TMap>,
    onAppendedError?: ProjectionErrorCallback,
  ) {
    this.#inner = inner;
    this.#onAppended = onAppended;
    this.#onAppendedError = onAppendedError;
  }

  async append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    const stored = await this.#inner.append(aggregateId, events, expectedVersion, options);
    try {
      await this.#onAppended(stored);
    } catch (err) {
      try {
        this.#onAppendedError?.(err);
      } catch {
        // observer 自身の失敗は最終砦でも握りつぶす。append はすでに成功している。
      }
    }
    return stored;
  }

  load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    return this.#inner.load(aggregateId);
  }
}
