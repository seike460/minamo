import type { Aggregate, AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEventsOf } from "../core/types.js";
import { ConcurrencyError, RetryExhaustedError } from "../errors.js";
import type { AppendOptions, EventStore } from "../event-store/types.js";
import {
  assertAggregateConfig,
  assertAggregateId,
  assertEventStoreShape,
  assertSnapshotStoreShape,
  isObjectRecord,
} from "../internal/guards.js";
import { normalizePlainData } from "../internal/plain-data.js";
import type { ExecuteObserver } from "../observability.js";
import type { Snapshot, SnapshotPolicy, SnapshotStore } from "../snapshot/types.js";
import type { ReadonlyDeep } from "../types.js";
import { applyDecided, assertDecidableEvents } from "./decide.js";
import { loadAndRehydrate } from "./load.js";
import type { CommandHandler } from "./types.js";

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
 * EventStore contract の postcondition (件数一致・連番・aggregateId 一致) を検証する。
 * custom store の契約違反を握ると返す aggregate.version / snapshot.version が静かに腐る
 * (SnapshotStore.load の envelope 検証と同じ fail-loud 方針)。
 */
function assertStoredBatch<TMap extends EventMap>(
  newEvents: unknown,
  expectedCount: number,
  aggregateId: string,
  baseVersion: number,
): asserts newEvents is ReadonlyArray<StoredEventsOf<TMap>> {
  if (!Array.isArray(newEvents) || newEvents.length !== expectedCount) {
    throw new TypeError(
      `EventStore.append must return ${expectedCount} stored event(s), got ${
        Array.isArray(newEvents) ? newEvents.length : typeof newEvents
      }`,
    );
  }
  for (let i = 0; i < newEvents.length; i++) {
    const e = newEvents[i];
    if (
      !isObjectRecord(e) ||
      typeof e.type !== "string" ||
      e.aggregateId !== aggregateId ||
      e.version !== baseVersion + i + 1
    ) {
      throw new TypeError(`EventStore.append returned an invalid stored event at index ${i}`);
    }
  }
}

/**
 * commit 済み append の後に、閾値到達時だけ snapshot を save する。
 *
 * snapshot save は best-effort (DEC-026): append は既に commit 済みのため、save 失敗で
 * command 全体を reject すると、呼び出し側が「失敗」とみなして再実行し二重書き込みを招く。
 * snapshot は rehydration の最適化であり、save が失敗しても次回は前回 snapshot か full replay
 * で正答する。framework-free を保つため log もしない（可覚測性 hook は public surface を
 * 拡大するため別途扱い）。
 */
async function maybeSaveSnapshot<TState>(
  snapshotStore: SnapshotStore<TState>,
  aggregateId: string,
  version: number,
  state: TState,
): Promise<void> {
  // clone も try の内側: 非 cloneable な state (DEC-011 違反) での DataCloneError も
  // post-commit の失敗に見せない。
  try {
    const snapshot: Snapshot<TState> = {
      aggregateId,
      version,
      // caller へ返す aggregate.state と共有しない (custom SnapshotStore が参照を
      // 保持する場合に、caller 側の mutation が保存済み snapshot に波及しないように)。
      // 永続化と同じ normalize (undefined 値 key 除去) を掛け、両 backend で
      // 同一内容が保存されるようにする。
      state: normalizePlainData(state) as TState,
      timestamp: new Date().toISOString(),
    };
    await snapshotStore.save(snapshot);
  } catch {
    // best-effort: swallow（上記コメントの理由により command の成功を妨げない）
  }
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
  // params 自体が非 object だと destructure の生 TypeError になるため入口で弾く。
  if (!isObjectRecord(params)) {
    throw new TypeError("params must be an object");
  }
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
  if (snapshotPolicy !== undefined) {
    if (!isObjectRecord(snapshotPolicy)) {
      throw new TypeError("snapshotPolicy must be an object");
    }
    // NaN / ±Infinity は `everyNEvents < 1` の「無効化」分岐をすり抜けて
    // 二度と発火しない (または比較不能になる) ため明示的に弾く。
    if (!Number.isFinite(snapshotPolicy.everyNEvents)) {
      throw new TypeError(
        `snapshotPolicy.everyNEvents must be a finite number, got: ${String(snapshotPolicy.everyNEvents)}`,
      );
    }
  }
  assertAggregateId(aggregateId);
  if (correlationId !== undefined && typeof correlationId !== "string") {
    throw new TypeError(`correlationId must be a string (got ${typeof correlationId})`);
  }
  // 依存オブジェクトの shape 検証。非関数の `store.load` や欠落した `handler` は
  // 呼び出し時の生 TypeError になるだけだが、非 object の `observer` / 非関数の
  // `store.loadFrom` のように「静かに効かない」入力をここで弾く (fail-loud 方針)。
  assertAggregateConfig(config);
  if (typeof handler !== "function") {
    throw new TypeError("handler must be a function");
  }
  assertEventStoreShape(store);
  // `ExecuteObserver` は method signature のため `is Record` で narrow すると
  // hook の呼び出し型が潰れる。実行側では hook を呼ぶため inline 判定に留める。
  if (
    observer !== undefined &&
    (observer === null || typeof observer !== "object" || Array.isArray(observer))
  ) {
    throw new TypeError("observer must be an object of ExecuteObserver hooks");
  }
  if (snapshotStore !== undefined) {
    assertSnapshotStoreShape(snapshotStore);
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

    // `{length: 0}` のような非配列・Promise (async handler の付け忘れ)・単一 event
    // オブジェクトの返却は no-op 誤認や深い位置での生 TypeError になるため弾く。
    if (!Array.isArray(decided)) {
      throw new TypeError("handler must return an array of events");
    }

    if (decided.length === 0) {
      return { aggregate, newEvents: [] };
    }

    // stream poison 防止を含む commit 前の decided 検証 (詳細は rehydrate.ts 参照)。
    assertDecidableEvents(config, decided, aggregateId);
    // append 前に state へ畳み込む (commit 後の clone/evolve 失敗で「永続化済みなのに
    // 失敗に見える」状態を作らないための順序)。
    const updatedState = applyDecided(config, aggregate.state as TState, decided);

    // append 成功後の version (postcondition で newEvents.length === decided.length が
    // 検証されるため、この時点で確定的に計算できる)。
    // NOTE: snapshot 対象 state の検証をここ (commit 前) に置かない。snapshot は
    // rehydration の最適化層 (DEC-026) であり、state が非 plain data でも command 自体は
    // 成立する — commit 前に弾くと v0.2.0 で動いていた aggregate が閾値到達のたびに
    // throw して恒久的に command 不能になる。保存可否は save 側 (assertSnapshot →
    // best-effort swallow) に委ねる。
    const committedVersion = aggregate.version + decided.length;

    // retry の発火条件は append の ConcurrencyError のみ (concept.md §5.6)。commit 後処理
    // (onCommitted / snapshot save) をこの catch の射程に入れると、それらが
    // ConcurrencyError を投げた際に commit 済み append を再試行して二重書き込みになる
    // (DEC-026 と同型の hazard)。try は append 呼び出しに限定する。
    let newEvents: ReadonlyArray<StoredEventsOf<TMap>>;
    try {
      newEvents = await store.append(aggregateId, decided, aggregate.version, appendOptions);
    } catch (err) {
      // dual-install 耐性: 別コピーの minamo 経由で投げられた ConcurrencyError も
      // retry 対象にする (TransactionCanceledException の name 判定と同じ方針)。
      const isConcurrency =
        err instanceof ConcurrencyError ||
        (err instanceof Error &&
          err.name === "ConcurrencyError" &&
          // name 一致だけだと custom store が投げる「名前だけ ConcurrencyError」の
          // foreign error も retry 対象になり、cause.expectedVersion が undefined で
          // `cause: ConcurrencyError` の型と食い違う。envelope field を要求して
          // dual-install の真の ConcurrencyError のみを拾う。
          isObjectRecord(err) &&
          typeof err.aggregateId === "string" &&
          typeof err.expectedVersion === "number");
      if (isConcurrency) {
        lastConcurrency = err as ConcurrencyError;
        observer?.onConcurrencyConflict?.({
          aggregateId,
          expectedVersion: aggregate.version,
          attempt,
        });
        continue;
      }
      throw err;
    }

    // append は resolve 済み (永続化成功) — 返り値検査の失敗を append の競合と
    // 誤認して再 append しないよう、検査は retry 用 catch の外で行う。
    assertStoredBatch<TMap>(newEvents, decided.length, aggregateId, aggregate.version);

    const version = committedVersion;
    try {
      observer?.onCommitted?.({ aggregateId, newEventCount: newEvents.length, version });
    } finally {
      // onCommitted が throw しても閾値到達済みの snapshot save は試行する
      // (observer の失敗で snapshot が静かに欠落し、次回 rehydrate が full replay に
      // 戻る二次障害を防ぐ)。
      if (
        snapshotStore !== undefined &&
        shouldSnapshot(snapshotPolicy, aggregate.version, version)
      ) {
        await maybeSaveSnapshot(snapshotStore, aggregateId, version, updatedState);
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
