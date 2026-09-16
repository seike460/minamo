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
  // 検証・変換の順序 (concept.md §5.11 / DEC-020 で固定): 各イベントについて
  //   raw.aggregateId 検証 → raw.version 検証 → upcast → 変換後 type の evolve 検査
  // の順に適用する。metadata は upcast 前の raw イベントで検証するため、consumer の
  // upcast が壊れていても stream 破損 (他 aggregate 混入 / version gap) は正しく
  // InvalidEventStreamError として報告される。
  const { upcast } = config;
  const normalized: StoredEventsOf<TMap>[] = new Array(events.length);

  let prevVersion = baseVersion;
  for (let i = 0; i < events.length; i++) {
    const raw = events[i];
    // sparse array / undefined / 非 object 要素は malformed stream として fail-loud する。
    // (skip すると evolve ループで raw TypeError になり診断情報が失われる)
    if (raw === null || typeof raw !== "object") {
      throw new TypeError(
        `event at index ${i} is not a StoredEvent (got ${raw === null ? "null" : typeof raw})`,
      );
    }

    if (raw.aggregateId !== id) {
      throw new InvalidEventStreamError(
        id,
        "aggregateId_mismatch",
        `event at index ${i} belongs to aggregate "${raw.aggregateId}", expected "${id}"`,
        { eventIndex: i, expectedAggregateId: id, actualAggregateId: raw.aggregateId },
      );
    }

    if (i === 0) {
      const expectedFirst = baseVersion + 1;
      if (raw.version !== expectedFirst) {
        if (baseVersion === 0) {
          throw new InvalidEventStreamError(
            id,
            "invalid_initial_version",
            `first event must have version 1, got ${raw.version}`,
            { eventIndex: 0, expectedVersion: 1, actualVersion: raw.version },
          );
        }
        // snapshot からの replay で先頭が連続していない = snapshot と stream の不整合
        throw new InvalidEventStreamError(
          id,
          "version_gap",
          `first replayed event must have version ${expectedFirst} (after snapshot ${baseVersion}), got ${raw.version}`,
          { eventIndex: 0, expectedVersion: expectedFirst, actualVersion: raw.version },
        );
      }
    } else {
      if (raw.version <= prevVersion) {
        throw new InvalidEventStreamError(
          id,
          "non_monotonic_version",
          `event at index ${i} version ${raw.version} is not after previous version ${prevVersion}`,
          { eventIndex: i, expectedVersion: prevVersion + 1, actualVersion: raw.version },
        );
      }
      if (raw.version !== prevVersion + 1) {
        throw new InvalidEventStreamError(
          id,
          "version_gap",
          `event at index ${i} version ${raw.version} creates a gap from previous version ${prevVersion}`,
          { eventIndex: i, expectedVersion: prevVersion + 1, actualVersion: raw.version },
        );
      }
    }

    // upcast はメタデータ (aggregateId/version/timestamp) を保持する契約。保持は consumer 責務であり、
    // ここでは変換結果が evolve 可能な最小 shape を持つことのみを検証する。
    const e = upcast === undefined ? raw : (upcast(raw) as StoredEventsOf<TMap>);
    if (e === null || typeof e !== "object" || typeof e.type !== "string") {
      throw new TypeError(
        upcast === undefined
          ? `event at index ${i} has no string type`
          : `upcast returned an invalid event at index ${i}`,
      );
    }

    // `in` 演算子は prototype chain を辿るため "toString" 等の Object.prototype メンバー名が
    // missing_evolve_handler を素通りし、prototype method が evolve として呼ばれて state を
    // 静かに破壊する。own property に限定する。
    if (!Object.hasOwn(config.evolve, e.type)) {
      throw new InvalidEventStreamError(
        id,
        "missing_evolve_handler",
        `no evolve handler registered for event type "${e.type}"`,
        { eventIndex: i, eventType: e.type },
      );
    }

    normalized[i] = e;
    prevVersion = raw.version;
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
 * イベント列の shape 破壊（非 object 要素・type 非 string・upcast の不正返り値）は
 * ストリーム契約違反ではなく入力 shape の破壊として `TypeError` を throw する。
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
      // null 以外の非 object (undefined 含む) を返す custom store の契約違反を
      // プロパティアクセスの生 TypeError ではなく明示的に弾く。
      if (typeof snapshot !== "object") {
        throw new TypeError(
          `SnapshotStore.load must return Snapshot | null (got ${typeof snapshot})`,
        );
      }
      // custom SnapshotStore の契約違反を弾く (strict 方針): 別 aggregate の snapshot や
      // 不正 version を起点に replay すると silent corruption / RetryExhaustedError への
      // 誤分類になる (snapshot が stream より進んでいる破損ケースは append の
      // ConditionCheck が ConcurrencyError として検出する = fail-loud)。
      if (snapshot.aggregateId !== aggregateId) {
        throw new TypeError(
          `SnapshotStore.load returned snapshot for "${snapshot.aggregateId}", expected "${aggregateId}"`,
        );
      }
      if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
        throw new TypeError(
          `SnapshotStore.load returned invalid version ${String(snapshot.version)} for "${aggregateId}"`,
        );
      }
      // state の欠落・undefined は DEC-011 (plain data 制約) 違反として弾く。
      // own property 存在だけでは {state: undefined} を通してしまうため値も見る。
      if (!Object.hasOwn(snapshot, "state") || snapshot.state === undefined) {
        throw new TypeError(
          `SnapshotStore.load returned snapshot missing state for "${aggregateId}"`,
        );
      }
      const tail =
        typeof store.loadFrom === "function"
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
 * - handler の返すイベントや custom `SnapshotStore.load` の返り値など、入力 shape の破壊は
 *   `TypeError` で fail-fast する（commit 前の pre-append 検証を含む）
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

    // handler が evolve 未登録の type を emit した場合、そのイベントが永続化されると以後の
    // rehydrate が必ず missing_evolve_handler で失敗する (stream poison)。commit 前に fail-fast
    // する。`in` ではなく hasOwn を使い、Object.prototype 由来の名前 (toString 等) も確実に弾く。
    for (let i = 0; i < decided.length; i++) {
      const d = decided[i];
      if (d === null || typeof d !== "object" || typeof d.type !== "string") {
        throw new TypeError(`handler returned an invalid event at index ${i}`);
      }
      if (!Object.hasOwn(config.evolve, d.type)) {
        throw new InvalidEventStreamError(
          aggregateId,
          "missing_evolve_handler",
          `handler returned event type "${d.type}" which has no evolve handler`,
          { eventIndex: i, eventType: d.type },
        );
      }
    }

    // retry の発火条件は append の ConcurrencyError のみ (concept.md §5.6)。commit 後処理
    // (evolve 再適用 / onCommitted / snapshot save) をこの catch の射程に入れると、それらが
    // ConcurrencyError を投げた際に commit 済み append を再試行して二重書き込みになる
    // (DEC-026 と同型の hazard)。try は append 呼び出しに限定する。
    let newEvents: ReadonlyArray<StoredEventsOf<TMap>>;
    try {
      newEvents = await store.append(aggregateId, decided, aggregate.version, appendOptions);
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

    let updatedState = structuredClone(aggregate.state) as TState;
    for (const e of newEvents) {
      // append の返り値が decided と異なる type を含む custom store の契約違反でも、
      // prototype chain 由来のメソッド (toString 等) を evolve として呼ばない。
      const evolveHandler = Object.hasOwn(config.evolve, e.type)
        ? config.evolve[e.type as keyof TMap & string]
        : undefined;
      if (evolveHandler === undefined) continue;
      updatedState = evolveHandler(
        updatedState as ReadonlyDeep<TState>,
        e.data as ReadonlyDeep<TMap[keyof TMap & string]>,
      );
    }
    const version = aggregate.version + newEvents.length;
    observer?.onCommitted?.({ aggregateId, newEventCount: newEvents.length, version });

    if (snapshotStore !== undefined && shouldSnapshot(snapshotPolicy, aggregate.version, version)) {
      const snapshot: Snapshot<TState> = {
        aggregateId,
        version,
        state: updatedState,
        timestamp: new Date().toISOString(),
      };
      // snapshot save は best-effort (DEC-026): append は既に commit 済みのため、save 失敗で
      // command 全体を reject すると、呼び出し側が「失敗」とみなして再実行し二重書き込みを招く。
      // snapshot は rehydration の最適化であり、save が失敗しても次回は前回 snapshot か full replay
      // で正答する。framework-free を保つため log もしない（可観測性 hook は public surface を
      // 拡大するため別途扱い）。
      try {
        await snapshotStore.save(snapshot);
      } catch {
        // best-effort: swallow（上記コメントの理由により command の成功を妨げない）
      }
    }

    return {
      aggregate: {
        id: aggregateId,
        state: updatedState as ReadonlyDeep<TState>,
        version,
      },
      newEvents,
    };
  }

  // retry 枯渇: 少なくとも 1 回 append を試行しているため lastConcurrency は非 null
  const attempts = maxRetries + 1;
  observer?.onRetryExhausted?.({ aggregateId, attempts });
  throw new RetryExhaustedError(aggregateId, attempts, lastConcurrency as ConcurrencyError);
}
