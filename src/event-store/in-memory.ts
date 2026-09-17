import type { EventMap, EventsOf, StoredEvent, StoredEventsOf } from "../core/types.js";
import { ConcurrencyError, EventLimitError } from "../errors.js";
import {
  assertAfterVersion,
  assertAggregateId,
  assertAppendOptions,
  assertDomainEvents,
} from "../internal/guards.js";
import type { AppendOptions, EventStore } from "./types.js";

type AnyStored = StoredEvent<string, unknown>;

/**
 * テスト用 in-memory EventStore 実装。
 *
 * - DynamoEventStore と同じ汎用制約を実装する (version 検証、ギャップ検出、
 *   ConcurrencyError、空配列で EventLimitError、fresh read 保証)
 * - DynamoDB 固有のサイズ制約 (400KB / 4MB) は検証しない (DEC-006)
 * - Contract Tests (CT-01〜22) で DynamoEventStore との振る舞い一致を保証する
 * - append 入力と load/loadFrom/allEvents の返り値は structuredClone で caller と切り離す
 *   (DynamoDB の marshall/unmarshall 相当の隔離)。非 plain data (関数・class instance 等、
 *   DEC-011 違反) は `assertDomainEvents` → `assertPlainData` が `TypeError` で fail-loud に弾く
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
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new EventLimitError(
        aggregateId,
        `expectedVersion must be a non-negative integer (got ${String(expectedVersion)})`,
      );
    }
    assertAggregateId(aggregateId);
    assertAppendOptions(aggregateId, options);
    if (events.length === 0) {
      throw new EventLimitError(aggregateId, "events must not be empty");
    }
    assertDomainEvents(aggregateId, events);

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

    // DynamoDB の marshall round-trip と同じく、保存時に live object と切り離す (痛み C 対策)。
    // structuredClone を通せない非 plain data (関数・class instance 等) はここで fail-loud に検出
    // される (DEC-011)。
    const persisted = structuredClone(stored) as AnyStored[];
    this.#streams.set(aggregateId, [...existing, ...persisted]);
    this.#insertionOrder.push(...persisted);

    // 返り値も clone する: `stored` は入力 `events[i].data` と参照を共有するため、
    // caller が append 後に input を mutate すると返り値が永続化内容と食い違う。
    return structuredClone(stored) as ReadonlyArray<StoredEventsOf<TMap>>;
  }

  async load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    assertAggregateId(aggregateId);
    const events = this.#streams.get(aggregateId);
    if (events === undefined) return [];
    // DynamoDB の unmarshall と同様、返すたびに複製して呼び出し側の mutation から隔離する。
    return structuredClone(events) as ReadonlyArray<StoredEventsOf<TMap>>;
  }

  /**
   * version が `afterVersion` より大きいイベントだけを昇順で返す (concept.md §5.4, DEC-019)。
   *
   * DynamoEventStore.loadFrom (`version > :v` query) と同一セマンティクスを実装し、
   * Snapshot からの部分 rehydration を InMemory でも本番と同じ振る舞いで検証できるようにする
   * (Contract Test CT-14 / 痛み C)。`#streams` は append 順 = version 昇順なので追加ソートは不要。
   */
  async loadFrom(
    aggregateId: string,
    afterVersion: number,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    assertAggregateId(aggregateId);
    assertAfterVersion(afterVersion);
    const events = this.#streams.get(aggregateId);
    if (events === undefined) return [];
    return structuredClone(events.filter((e) => e.version > afterVersion)) as ReadonlyArray<
      StoredEventsOf<TMap>
    >;
  }

  /** 全ストリームの全イベントを insertion order で返す (テスト専用)。 */
  allEvents(): ReadonlyArray<StoredEventsOf<TMap>> {
    return structuredClone(this.#insertionOrder) as ReadonlyArray<StoredEventsOf<TMap>>;
  }

  /** 全ストリームを初期化する (テスト専用)。 */
  clear(): void {
    this.#streams.clear();
    this.#insertionOrder.length = 0;
  }
}
