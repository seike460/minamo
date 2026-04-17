import type { EventMap, EventsOf, StoredEvent, StoredEventsOf } from "../core/types.js";
import { ConcurrencyError, EventLimitError } from "../errors.js";
import type { AppendOptions, EventStore } from "./types.js";

type AnyStored = StoredEvent<string, unknown>;

/**
 * テスト用 in-memory EventStore 実装。
 *
 * - DynamoEventStore と同じ汎用制約を実装する (version 検証、ギャップ検出、
 *   ConcurrencyError、空配列で EventLimitError、fresh read 保証)
 * - DynamoDB 固有のサイズ制約 (400KB / 4MB) は検証しない (DEC-006)
 * - Contract Tests (CT-01〜13) で DynamoEventStore との振る舞い一致を保証する
 *
 * 本番環境では使わないこと。`allEvents` / `clear` はテスト専用。
 *
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 */
export class InMemoryEventStore<TMap extends EventMap> implements EventStore<TMap> {
  readonly #streams: Map<string, AnyStored[]> = new Map();
  readonly #insertionOrder: AnyStored[] = [];

  async append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    if (events.length === 0) {
      throw new EventLimitError(aggregateId, "events must not be empty");
    }

    const existing = this.#streams.get(aggregateId) ?? [];
    const currentVersion = existing.length;

    if (currentVersion !== expectedVersion) {
      throw new ConcurrencyError(aggregateId, expectedVersion);
    }

    const timestamp = new Date().toISOString();
    const stored: AnyStored[] = events.map((e, i) => {
      const base = {
        type: e.type,
        data: e.data,
        aggregateId,
        version: expectedVersion + i + 1,
        timestamp,
      } as const;
      return options?.correlationId !== undefined
        ? { ...base, correlationId: options.correlationId }
        : base;
    });

    this.#streams.set(aggregateId, [...existing, ...stored]);
    this.#insertionOrder.push(...stored);

    return stored as ReadonlyArray<StoredEventsOf<TMap>>;
  }

  async load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    const events = this.#streams.get(aggregateId);
    if (events === undefined) return [];
    return [...events] as ReadonlyArray<StoredEventsOf<TMap>>;
  }

  /** 全ストリームの全イベントを insertion order で返す (テスト専用)。 */
  allEvents(): ReadonlyArray<StoredEventsOf<TMap>> {
    return [...this.#insertionOrder] as ReadonlyArray<StoredEventsOf<TMap>>;
  }

  /** 全ストリームを初期化する (テスト専用)。 */
  clear(): void {
    this.#streams.clear();
    this.#insertionOrder.length = 0;
  }
}
