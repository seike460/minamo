import type { Aggregate, AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEventsOf } from "../core/types.js";
import { ConcurrencyError, InvalidEventStreamError, RetryExhaustedError } from "../errors.js";
import type { AppendOptions, EventStore } from "../event-store/types.js";
import type { ExecuteObserver } from "../observability.js";
import type { Snapshot, SnapshotPolicy, SnapshotStore } from "../snapshot/types.js";
import type { ReadonlyDeep } from "../types.js";
import type { CommandHandler } from "./types.js";

/**
 * 検証済みイベント列を baseState / baseVersion の上に replay して Aggregate を構築する内部共通関数。
 *
 * `rehydrate`（baseVersion=0、initialState 起点）と snapshot からの部分 replay
 * （baseVersion=snapshot.version、snapshot.state 起点）の両方がこれを使う。
 *
 * 検証順序 (concept.md §5.6 / U6 design §6.1 で固定):
 * 1. `aggregateId_mismatch` — events[i].aggregateId !== id
 * 2. 先頭 version — baseVersion=0 のとき `invalid_initial_version`(!=1)、baseVersion>0 のとき `version_gap`(!=base+1)
 * 3. `non_monotonic_version` — version が逆戻り
 * 4. `version_gap` — version が連番でない
 * 5. `missing_evolve_handler` — type が config.evolve に無い
 *
 * `baseState` は呼び出し側が複製済み (structuredClone) であること。
 */
function replayEvents<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
  id: string,
  baseState: TState,
  baseVersion: number,
  events: ReadonlyArray<StoredEventsOf<TMap>>,
): Aggregate<TState> {
  // upcasting (DEC-020): version/aggregateId 検証・evolve の前に consumer 所有の変換を適用する。
  // upcast はメタデータ (aggregateId/version) を保持する契約なので version 検証は変換後でも等価。
  const { upcast } = config;
  const normalized = upcast === undefined ? events : events.map((e) => upcast(e));

  let prevVersion = baseVersion;
  for (let i = 0; i < normalized.length; i++) {
    const e = normalized[i];
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
      const expectedFirst = baseVersion + 1;
      if (e.version !== expectedFirst) {
        if (baseVersion === 0) {
          throw new InvalidEventStreamError(
            id,
            "invalid_initial_version",
            `first event must have version 1, got ${e.version}`,
            { eventIndex: 0, expectedVersion: 1, actualVersion: e.version },
          );
        }
        // snapshot からの replay で先頭が連続していない = snapshot と stream の不整合
        throw new InvalidEventStreamError(
          id,
          "version_gap",
          `first replayed event must have version ${expectedFirst} (after snapshot ${baseVersion}), got ${e.version}`,
          { eventIndex: 0, expectedVersion: expectedFirst, actualVersion: e.version },
        );
      }
    } else {
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

    prevVersion = e.version;
  }

  let state = baseState;
  for (const e of normalized) {
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
    version: baseVersion + normalized.length,
  };
}

/**
 * 永続化済みイベント列から Aggregate を再構築する純関数。
 *
 * 各違反は `InvalidEventStreamError` として throw（`details` に index / expected / actual / eventType）。
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
  return replayEvents(config, id, structuredClone(config.initialState) as TState, 0, events);
}

/**
 * load → rehydrate を実行する。snapshotStore があれば snapshot 経路を使い、
 * snapshot 以降のイベントだけを replay して rehydration コストを抑える (DEC-019)。
 *
 * - snapshot 経路: snapshotStore.load → (loadFrom があれば部分ロード、無ければ load 全件 + filter)
 *   → snapshot.state を起点に replay
 * - 非 snapshot 経路: store.load 全件 → rehydrate
 *
 * 返り値 `replayedCount` は実際に replay したイベント数 (observer.onLoaded の eventCount)。
 */
async function loadAndRehydrate<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
  store: EventStore<TMap>,
  aggregateId: string,
  snapshotStore: SnapshotStore<TState> | undefined,
): Promise<{ aggregate: Aggregate<TState>; replayedCount: number }> {
  if (snapshotStore !== undefined) {
    const snapshot = await snapshotStore.load(aggregateId);
    if (snapshot !== null) {
      const tail = store.loadFrom
        ? await store.loadFrom(aggregateId, snapshot.version)
        : (await store.load(aggregateId)).filter((e) => e.version > snapshot.version);
      const aggregate = replayEvents(
        config,
        aggregateId,
        structuredClone(snapshot.state) as TState,
        snapshot.version,
        tail,
      );
      return { aggregate, replayedCount: tail.length };
    }
  }

  const events = await store.load(aggregateId);
  return { aggregate: rehydrate(config, aggregateId, events), replayedCount: events.length };
}

/** version が everyNEvents の倍数を跨いだら true (append 前後の version 比較)。 */
function shouldSnapshot(
  policy: SnapshotPolicy | undefined,
  prevVersion: number,
  nextVersion: number,
): boolean {
  if (policy === undefined || policy.everyNEvents < 1) return false;
  return (
    Math.floor(prevVersion / policy.everyNEvents) < Math.floor(nextVersion / policy.everyNEvents)
  );
}

/**
 * Command 実行の全サイクル (Load → Rehydrate → Decide → Append) を管理する。
 *
 * `ConcurrencyError` を observed した場合のみ自動再試行し、それ以外のエラー
 * (handler throw / InvalidEventStreamError / SDK error / EventLimitError) は
 * そのまま伝播する (C8, concept.md §4)。
 *
 * - `maxRetries` は "追加" の再試行回数。初回 + retry で計 `1 + maxRetries` 回試行
 * - `maxRetries` 非負整数でなければ Load 前に `RangeError`
 * - `handler` が `[]` を return したら no-op。append を呼ばず version 不変で返す
 * - retry 枯渇時は `RetryExhaustedError`（`cause` に最後の ConcurrencyError、`attempts` に総試行回数。DEC-022）
 * - `snapshotStore` 指定時は snapshot 経路で rehydration コストを抑え、append 後に policy が該当すれば snapshot を save
 * - `observer` 指定時はライフサイクル各点で hook を発火 (concept.md §5.12, DEC-021)
 *
 * @typeParam TState - Aggregate の状態型。
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 * @typeParam TInput - Command input 型。
 */
export async function executeCommand<TState, TMap extends EventMap, TInput>(params: {
  config: AggregateConfig<TState, TMap>;
  store: EventStore<TMap>;
  handler: CommandHandler<TState, TMap, NoInfer<TInput>>;
  aggregateId: string;
  input: TInput;
  maxRetries?: number;
  correlationId?: string;
  /** Optional: 実行ライフサイクルの観測 hook (concept.md §5.12, DEC-021)。 */
  observer?: ExecuteObserver;
  /** Optional: Snapshot による rehydration 短縮 (concept.md §5.10, DEC-019)。 */
  snapshotStore?: SnapshotStore<TState>;
  /** Optional: append 成功後に snapshot を save する閾値ポリシー (snapshotStore 指定時のみ有効)。 */
  snapshotPolicy?: SnapshotPolicy;
}): Promise<{
  /** append 後の最新 Aggregate (newEvents を evolve で反映済)。no-op 時は rehydrate 結果そのまま。 */
  aggregate: Aggregate<TState>;
  /** append で追加された server-assigned metadata 付きの StoredEvent 列。no-op 時は `[]`。 */
  newEvents: ReadonlyArray<StoredEventsOf<TMap>>;
}> {
  const {
    config,
    store,
    handler,
    aggregateId,
    input,
    maxRetries = 3,
    correlationId,
    observer,
    snapshotStore,
    snapshotPolicy,
  } = params;

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError(`maxRetries must be a non-negative integer, got: ${String(maxRetries)}`);
  }

  const appendOptions: AppendOptions | undefined =
    correlationId !== undefined ? { correlationId } : undefined;

  let lastConcurrency: ConcurrencyError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    observer?.onAttempt?.({ aggregateId, attempt });

    const { aggregate, replayedCount } = await loadAndRehydrate(
      config,
      store,
      aggregateId,
      snapshotStore,
    );
    observer?.onLoaded?.({ aggregateId, eventCount: replayedCount, version: aggregate.version });

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
      const version = aggregate.version + newEvents.length;
      observer?.onCommitted?.({ aggregateId, newEventCount: newEvents.length, version });

      if (
        snapshotStore !== undefined &&
        shouldSnapshot(snapshotPolicy, aggregate.version, version)
      ) {
        const snapshot: Snapshot<TState> = {
          aggregateId,
          version,
          state: updatedState,
          timestamp: new Date().toISOString(),
        };
        await snapshotStore.save(snapshot);
      }

      return {
        aggregate: {
          id: aggregateId,
          state: updatedState as ReadonlyDeep<TState>,
          version,
        },
        newEvents,
      };
    } catch (err) {
      if (err instanceof ConcurrencyError) {
        lastConcurrency = err;
        observer?.onConcurrencyConflict?.({
          aggregateId,
          expectedVersion: aggregate.version,
          attempt,
        });
        continue;
      }
      throw err;
    }
  }

  // retry 枯渇: 少なくとも 1 回 append を試行しているため lastConcurrency は非 null
  const attempts = maxRetries + 1;
  observer?.onRetryExhausted?.({ aggregateId, attempts });
  throw new RetryExhaustedError(aggregateId, attempts, lastConcurrency as ConcurrencyError);
}
