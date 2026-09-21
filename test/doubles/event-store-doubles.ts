import type {
  AppendOptions,
  EventMap,
  EventStore,
  EventsOf,
  StoredEventsOf,
} from "../../src/index.js";
import { ConcurrencyError, InMemoryEventStore } from "../../src/index.js";

/**
 * 1 回目の `append` で必ず `ConcurrencyError` を throw し、2 回目以降は
 * wrap した InMemoryEventStore に委譲する deterministic double。
 *
 * U6 executeCommand の retry path を timing なしに検証するため (R2)。
 */
export class FailOnce<TMap extends EventMap> implements EventStore<TMap> {
  readonly #inner: InMemoryEventStore<TMap>;
  #remainingFailures = 1;

  constructor() {
    this.#inner = new InMemoryEventStore<TMap>();
  }

  /**
   * wrap した InMemory の直接参照。retry 直前の "他者の先行書き込み" を模擬する
   * ため、`#inner.append` を tests から呼んで stream を進められるようにする。
   */
  get inner(): InMemoryEventStore<TMap> {
    return this.#inner;
  }

  async append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    if (this.#remainingFailures > 0) {
      this.#remainingFailures -= 1;
      throw new ConcurrencyError(aggregateId, expectedVersion);
    }
    return this.#inner.append(aggregateId, events, expectedVersion, options);
  }

  async load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    return this.#inner.load(aggregateId);
  }
}

/**
 * 1 回目の `append` で、競合する他者の書き込みを inner に先行 commit してから
 * `ConcurrencyError` を throw する double (実際の楽観ロック衝突の再現)。
 *
 * `FailOnce` は stream を進めずに失敗するため、「retry が再 load して
 * 競合分を含む新 state・進んだ expectedVersion を使う」ことを検証できない。
 * この double は実際に stream を進めるため、再 load を省いた退化実装
 * (aggregate の使い回し・expectedVersion の据え置き) を検出できる。
 */
export class FailOnceAndAdvance<TMap extends EventMap> implements EventStore<TMap> {
  readonly #inner = new InMemoryEventStore<TMap>();
  readonly #conflicting: ReadonlyArray<EventsOf<TMap>>;
  #remainingFailures = 1;
  #loadCalls = 0;
  readonly seenExpectedVersions: number[] = [];

  constructor(conflicting: ReadonlyArray<EventsOf<TMap>>) {
    this.#conflicting = conflicting;
  }

  /** wrap した InMemory の直接参照 (永続化結果の assert 用)。 */
  get inner(): InMemoryEventStore<TMap> {
    return this.#inner;
  }

  get loadCalls(): number {
    return this.#loadCalls;
  }

  async append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    this.seenExpectedVersions.push(expectedVersion);
    if (this.#remainingFailures > 0) {
      this.#remainingFailures -= 1;
      // 競合する他者の commit: 同じ expectedVersion で stream を進めてから衝突を報告する。
      await this.#inner.append(aggregateId, this.#conflicting, expectedVersion);
      throw new ConcurrencyError(aggregateId, expectedVersion);
    }
    return this.#inner.append(aggregateId, events, expectedVersion, options);
  }

  async load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    this.#loadCalls += 1;
    return this.#inner.load(aggregateId);
  }
}

/**
 * `append` を呼ぶたびに `ConcurrencyError` を throw する double。
 * maxRetries 枯渇 → ConcurrencyError 伝播の path を検証する。
 */
export class AlwaysFail<TMap extends EventMap> implements EventStore<TMap> {
  async append(
    aggregateId: string,
    _events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    _options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    throw new ConcurrencyError(aggregateId, expectedVersion);
  }

  async load(_aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    return [];
  }
}

/**
 * wrap した EventStore の `load` / `append` の呼び出し回数を数える double。
 * maxRetries validation が Load より先に実行されたか等を assert する。
 */
export class CountingStore<TMap extends EventMap> implements EventStore<TMap> {
  #loadCalls = 0;
  #appendCalls = 0;

  constructor(private readonly inner: EventStore<TMap>) {}

  get loadCalls(): number {
    return this.#loadCalls;
  }

  get appendCalls(): number {
    return this.#appendCalls;
  }

  async append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    this.#appendCalls += 1;
    return this.inner.append(aggregateId, events, expectedVersion, options);
  }

  async load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>> {
    this.#loadCalls += 1;
    return this.inner.load(aggregateId);
  }
}
