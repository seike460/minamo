import type { Aggregate, AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEventsOf } from "../core/types.js";
import { InvalidEventStreamError } from "../errors.js";
import {
  assertAggregateConfig,
  assertAggregateId,
  clip,
  isObjectRecord,
} from "../internal/guards.js";
import { normalizePlainData } from "../internal/plain-data.js";
import type { ReadonlyDeep } from "../types.js";

/**
 * `config.evolve` に `type` の callable な handler が登録されているか。
 *
 * `Object.hasOwn` は key の存在だけを見るため `{ X: undefined }` のような登録を
 * 通してしまい、application 側の `=== undefined → continue` が event を「永続化済み
 * だが state には反映されない」静かな乖離にする。値の callable 性を必須とする。
 * prototype 経由で解決された callable については、解決結果が Object.prototype の
 * builtin そのもの (未登録名の拾い上げ: `toString` 等) のみを弾く — class instance
 * を evolve map にする構成 (methods は prototype 上にあり own property ではない) は
 * v0.2.0 で動いていたため、consumer 定義の prototype method は builtin と同名でも
 * (`toString` の override を含む) 正当な handler として認める。
 */
export function hasEvolveHandler<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
  type: string,
): boolean {
  const handler = (config.evolve as Record<string, unknown>)[type];
  if (typeof handler !== "function") return false;
  if (Object.hasOwn(config.evolve, type)) return true;
  // prototype chain 経由の callable は、Object.prototype の builtin 参照そのものなら
  // 未登録名の拾い上げとして弾く。利用者が定義した method は builtin と同名でも
  // 参照が異なるため handler として認める。
  return handler !== (Object.prototype as Record<string, unknown>)[type];
}

/**
 * `evolve` の戻り値が「次の state」として成立するかを検証する。
 *
 * `undefined` (return 忘れ) と thenable (async evolve の付け忘れ) を弾く。
 * 前者は `state: undefined` の Aggregate を、後者は `state` が Promise に
 * なる静かな破綻を生む — どちらも evolve の契約 (純粋な同期関数) 違反。
 * `null` は plain data として合法な TState になりうるため通す。
 */
export function assertEvolveResult<TState>(next: TState, eventType: string): TState {
  if (next === undefined || typeof (next as { then?: unknown })?.then === "function") {
    throw new TypeError(
      `evolve handler for event type ${clip(eventType)} must return a state synchronously`,
    );
  }
  return next;
}

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
export function replayEvents<TState, TMap extends EventMap>(
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
    if (!isObjectRecord(raw)) {
      throw new TypeError(
        `event at index ${i} is not a StoredEvent (got ${
          raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw
        })`,
      );
    }

    if (raw.aggregateId !== id) {
      throw new InvalidEventStreamError(
        id,
        "aggregateId_mismatch",
        `event at index ${i} belongs to aggregate ${clip(raw.aggregateId)}, expected ${clip(id)}`,
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
    // `data` の存在は要求しない: v0.2.0 は `data: undefined` の event を受理しており
    // (DynamoDB では removeUndefinedValues で `data` 属性ごと落ちて永続化された)、
    // その legacy item を含む stream を read 側でも読めるようにするため `data` は
    // optional として evolve に流す (write 側は assertDomainEvents で同じ契約)。
    const e = upcast === undefined ? raw : (upcast(raw) as StoredEventsOf<TMap>);
    if (!isObjectRecord(e) || typeof e.type !== "string") {
      throw new TypeError(
        upcast === undefined
          ? `event at index ${i} has no string type`
          : `upcast returned an invalid event at index ${i}`,
      );
    }

    // `in` 演算子は prototype chain を無差別に辿るため "toString" 等の Object.prototype
    // メンバー名が missing_evolve_handler を素通りし、prototype method が evolve として
    // 呼ばれて state を静かに破壊する。callable であることを要求しつつ、非 own property は
    // Object.prototype builtin 名のみを弾く (`{X: undefined}` 登録も弾く)。
    if (!hasEvolveHandler(config, e.type)) {
      throw new InvalidEventStreamError(
        id,
        "missing_evolve_handler",
        `no evolve handler registered for event type ${clip(e.type)}`,
        { eventIndex: i, eventType: e.type },
      );
    }

    normalized[i] = e;
    prevVersion = raw.version;
  }

  let state = baseState;
  for (const e of normalized) {
    // 上の hasEvolveHandler 検証で own callable handler の存在は保証済み (防御的に undefined を除く)
    const handler = config.evolve[e.type as keyof TMap & string];
    if (handler === undefined) continue;
    const next = handler(
      state as ReadonlyDeep<TState>,
      e.data as ReadonlyDeep<TMap[keyof TMap & string]>,
    );
    state = assertEvolveResult(next, e.type);
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
  assertAggregateConfig(config);
  assertAggregateId(id);
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  let initialState: TState;
  try {
    // persist 経路と同じ normalize (undefined 値 key の除去) を掛け、state が
    // 「reload 後に見える形」と最初から一致するようにする。
    initialState = normalizePlainData(config.initialState) as TState;
  } catch {
    // 非 cloneable な initialState (関数・Symbol 等、DEC-011 違反) を生の
    // DataCloneError ではなく契約違反の TypeError に揃える。
    throw new TypeError("config.initialState must be structured-cloneable");
  }
  return replayEvents(config, id, initialState, 0, events);
}
