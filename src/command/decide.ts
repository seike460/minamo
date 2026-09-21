import type { AggregateConfig } from "../core/aggregate.js";
import type { EventMap } from "../core/types.js";
import { InvalidEventStreamError } from "../errors.js";
import { clip, isObjectRecord } from "../internal/guards.js";
import { assertPlainData, normalizePlainData } from "../internal/plain-data.js";
import type { ReadonlyDeep } from "../types.js";
import { assertEvolveResult, hasEvolveHandler } from "./rehydrate.js";
import type { CommandResult } from "./types.js";

/**
 * handler の出力 (decided events) を commit 前に検証する。
 *
 * handler が evolve 未登録の type を emit した場合、そのイベントが永続化されると以後の
 * rehydrate が必ず missing_evolve_handler で失敗する (stream poison)。commit 前に fail-fast
 * する。`in` ではなく hasEvolveHandler を使い、Object.prototype の builtin 参照の
 * 拾い上げ (toString 等の未登録名) も確実に弾く。
 *
 * `data` は optional (v0.2.0 互換): `data: undefined` の event は DynamoDB で
 * removeUndefinedValues により属性ごと落ちて永続化され、読み出しでは
 * `data: undefined` として復元される。存在する場合のみ plain data を要求する。
 * assertPlainData は store.append 側 (assertDomainEvents) でも走るが、custom
 * EventStore がその検証を実装しない場合に非 plain data がすり抜けるのと、
 * evolve 用の clone が生 DataCloneError を投げるのを防ぐため
 * ここでも TypeError に揃えて弾く。
 */
export function assertDecidableEvents<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
  decided: CommandResult<TMap>,
  aggregateId: string,
): void {
  for (let i = 0; i < decided.length; i++) {
    const d = decided[i];
    if (!isObjectRecord(d) || typeof d.type !== "string" || d.type.length === 0) {
      throw new TypeError(`handler returned an invalid event at index ${i}`);
    }
    if (d.data !== undefined) {
      assertPlainData(d.data, `handler returned event at index ${i} data`);
    }
    if (!hasEvolveHandler(config, d.type)) {
      throw new InvalidEventStreamError(
        aggregateId,
        "missing_evolve_handler",
        `handler returned event type ${clip(d.type)} which has no evolve handler`,
        { eventIndex: i, eventType: d.type },
      );
    }
  }
}

/**
 * 検証済みの decided events を state に畳み、永続化と同じ正規化形の次 state を返す。
 *
 * evolve の適用と state clone は append 前に行う。commit 後に structuredClone / evolve が
 * throw すると「イベントは永続化済みなのに呼び出し側には失敗に見える」状態になり、
 * caller の再実行が二重 append を招く (DEC-026 と同型の hazard)。
 */
export function applyDecided<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
  state: TState,
  decided: CommandResult<TMap>,
): TState {
  let updatedState: TState;
  try {
    // caller へ返す state は永続化と同じ正規化形に揃える (undefined 値 key の除去
    // 等)。「reload したら見える形」と一致させることで「その場だけ見える値」を防ぐ。
    updatedState = normalizePlainData(state) as TState;
  } catch {
    // replayed state が非 cloneable (consumer evolve の DEC-011 違反) の場合、
    // 生の DataCloneError ではなく契約違反の TypeError に揃える。
    throw new TypeError("aggregate state is not structured-cloneable");
  }
  for (const [i, d] of decided.entries()) {
    const evolveHandler = config.evolve[d.type as keyof TMap & string];
    // evolve には data の正規化済み clone を渡す: 不純な evolve が payload を
    // mutate しても永続化される `decided` に波及しないのに加え、evolve が見る
    // data は永続化・reload 後の形 (undefined 値 key 除去済み) と一致する。
    let eventData: ReadonlyDeep<TMap[keyof TMap & string]>;
    try {
      eventData = normalizePlainData(d.data) as typeof eventData;
    } catch {
      // Proxy 等の非 cloneable な data (DEC-011 違反) を生の DataCloneError
      // ではなく契約違反の TypeError に揃える。
      throw new TypeError(`handler returned event at index ${i} with non-cloneable data`);
    }
    const next = evolveHandler(updatedState as ReadonlyDeep<TState>, eventData);
    updatedState = assertEvolveResult(next, d.type);
  }
  return updatedState;
}
