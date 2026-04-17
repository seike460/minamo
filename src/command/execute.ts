import type { Aggregate, AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEventsOf } from "../core/types.js";
import { ConcurrencyError, InvalidEventStreamError } from "../errors.js";
import type { AppendOptions, EventStore } from "../event-store/types.js";
import type { ReadonlyDeep } from "../types.js";
import type { CommandHandler } from "./types.js";

/**
 * 永続化済みイベント列から Aggregate を再構築する純関数。
 *
 * 検証順序 (concept.md §5.6 postcondition、U6 design §6.1 で固定):
 * 1. `aggregateId_mismatch` — events[i].aggregateId !== id
 * 2. `invalid_initial_version` — events[0].version !== 1
 * 3. `non_monotonic_version` — events[i].version <= events[i-1].version (逆戻り)
 * 4. `version_gap` — events[i].version !== events[i-1].version + 1 (抜け)
 * 5. `missing_evolve_handler` — events[i].type が `config.evolve` に無い
 *
 * 各違反は `InvalidEventStreamError` として throw。壊れた stream を再現するため
 * `details.eventIndex / expected* / actual* / eventType` を埋める。
 *
 * events が空なら version=0 の Aggregate を返す (initialState の structuredClone)。
 *
 * @typeParam TState - Aggregate の状態型。structured-cloneable であること (DEC-011)。
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 */
export function rehydrate<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
  id: string,
  events: ReadonlyArray<StoredEventsOf<TMap>>,
): Aggregate<TState> {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue;

    if (e.aggregateId !== id) {
      throw new InvalidEventStreamError(
        id,
        "aggregateId_mismatch",
        `event at index ${i} belongs to aggregate "${e.aggregateId}", expected "${id}"`,
        { eventIndex: i, expectedAggregateId: id, actualAggregateId: e.aggregateId },
      );
    }

    if (i === 0) {
      if (e.version !== 1) {
        throw new InvalidEventStreamError(
          id,
          "invalid_initial_version",
          `first event must have version 1, got ${e.version}`,
          { eventIndex: 0, expectedVersion: 1, actualVersion: e.version },
        );
      }
    } else {
      const prev = events[i - 1];
      const prevVersion = prev?.version ?? 0;
      if (e.version <= prevVersion) {
        throw new InvalidEventStreamError(
          id,
          "non_monotonic_version",
          `event at index ${i} version ${e.version} is not after previous version ${prevVersion}`,
          { eventIndex: i, expectedVersion: prevVersion + 1, actualVersion: e.version },
        );
      }
      if (e.version !== prevVersion + 1) {
        throw new InvalidEventStreamError(
          id,
          "version_gap",
          `event at index ${i} version ${e.version} creates a gap from previous version ${prevVersion}`,
          { eventIndex: i, expectedVersion: prevVersion + 1, actualVersion: e.version },
        );
      }
    }

    if (!(e.type in config.evolve)) {
      throw new InvalidEventStreamError(
        id,
        "missing_evolve_handler",
        `no evolve handler registered for event type "${e.type}"`,
        { eventIndex: i, eventType: e.type },
      );
    }
  }

  let state = structuredClone(config.initialState) as TState;
  for (const e of events) {
    const handler = config.evolve[e.type as keyof TMap & string];
    if (handler === undefined) continue;
    state = handler(
      state as ReadonlyDeep<TState>,
      e.data as ReadonlyDeep<TMap[keyof TMap & string]>,
    );
  }

  return {
    id,
    state: state as ReadonlyDeep<TState>,
    version: events.length,
  };
}

/**
 * Command 実行の全サイクル (Load → Rehydrate → Decide → Append) を管理する。
 *
 * `ConcurrencyError` を observed した場合のみ自動再試行し、それ以外のエラー
 * (handler throw / InvalidEventStreamError / SDK error / EventLimitError) は
 * そのまま伝播する (C8, concept.md §4)。
 *
 * - `maxRetries` は "追加" の再試行回数。初回 + retry で計 `1 + maxRetries` 回試行
 * - `maxRetries` 非負整数 (整数でない / 負 / NaN / Infinity) は Load 前に `RangeError`
 * - `handler` が `[]` を return したら no-op。append を呼ばず version 不変で返す
 * - retry 枯渇時は最後の `ConcurrencyError` をそのまま throw (concept.md §4 逐字)
 *
 * @typeParam TState - Aggregate の状態型。
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 * @typeParam TInput - Command input 型。
 */
export async function executeCommand<TState, TMap extends EventMap, TInput>(params: {
  config: AggregateConfig<TState, TMap>;
  store: EventStore<TMap>;
  handler: CommandHandler<TState, TMap, TInput>;
  aggregateId: string;
  input: TInput;
  maxRetries?: number;
  correlationId?: string;
}): Promise<{
  /** append 後の最新 Aggregate (newEvents を evolve で反映済)。no-op 時は rehydrate 結果そのまま。 */
  aggregate: Aggregate<TState>;
  /** append で追加された server-assigned metadata 付きの StoredEvent 列。no-op 時は `[]`。 */
  newEvents: ReadonlyArray<StoredEventsOf<TMap>>;
}> {
  const { config, store, handler, aggregateId, input, maxRetries = 3, correlationId } = params;

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError(`maxRetries must be a non-negative integer, got: ${String(maxRetries)}`);
  }

  const appendOptions: AppendOptions | undefined =
    correlationId !== undefined ? { correlationId } : undefined;

  let lastConcurrency: ConcurrencyError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const events = await store.load(aggregateId);
    const aggregate = rehydrate(config, aggregateId, events);
    const decided = handler(aggregate, input);

    if (decided.length === 0) {
      return { aggregate, newEvents: [] };
    }

    try {
      const newEvents = await store.append(aggregateId, decided, aggregate.version, appendOptions);
      let updatedState = structuredClone(aggregate.state) as TState;
      for (const e of newEvents) {
        const evolveHandler = config.evolve[e.type as keyof TMap & string];
        if (evolveHandler === undefined) continue;
        updatedState = evolveHandler(
          updatedState as ReadonlyDeep<TState>,
          e.data as ReadonlyDeep<TMap[keyof TMap & string]>,
        );
      }
      return {
        aggregate: {
          id: aggregateId,
          state: updatedState as ReadonlyDeep<TState>,
          version: aggregate.version + newEvents.length,
        },
        newEvents,
      };
    } catch (err) {
      if (err instanceof ConcurrencyError) {
        lastConcurrency = err;
        continue;
      }
      throw err;
    }
  }

  // retry 枯渇: 少なくとも 1 回 append を試行しているため lastConcurrency は非 null
  throw lastConcurrency as ConcurrencyError;
}
