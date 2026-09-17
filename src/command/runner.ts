import type { Aggregate, AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEventsOf } from "../core/types.js";
import type { EventStore } from "../event-store/types.js";
import {
  assertAggregateConfig,
  assertEventStoreShape,
  assertSnapshotStoreShape,
  isObjectRecord,
} from "../internal/guards.js";
import type { ExecuteObserver } from "../observability.js";
import type { SnapshotPolicy, SnapshotStore } from "../snapshot/types.js";
import { executeCommand } from "./execute.js";
import type { CommandHandler } from "./types.js";

/**
 * `config` / `store`（および任意の defaults）を固定し、`handler` + `aggregateId` + `input` だけで
 * 呼べる command runner を返す (concept.md §5.13, DEC-023)。
 *
 * 同一 Aggregate に多数の handler を持つ consumer で `config` / `store` の繰り返しを解消する。
 * `executeCommand` の薄いラッパーであり公開契約を変えない。`defaults` で `maxRetries` /
 * `observer` / `snapshotStore` / `snapshotPolicy` の既定値を束ねられ、呼び出し時の引数が優先される。
 *
 * @example
 * ```ts
 * const run = createCommandRunner({ config: counter, store });
 * await run({ handler: increment, aggregateId: "c-1", input: { amount: 5 } });
 * ```
 *
 * @typeParam TState - Aggregate の状態型。
 * @typeParam TMap - Aggregate が扱うイベント型マップ。
 */
export function createCommandRunner<TState, TMap extends EventMap>(deps: {
  config: AggregateConfig<TState, TMap>;
  store: EventStore<TMap>;
  defaults?: {
    maxRetries?: number;
    observer?: ExecuteObserver;
    snapshotStore?: SnapshotStore<TState>;
    snapshotPolicy?: SnapshotPolicy;
  };
}): <TInput>(args: {
  handler: CommandHandler<TState, TMap, NoInfer<TInput>>;
  aggregateId: string;
  input: TInput;
  maxRetries?: number;
  correlationId?: string;
  observer?: ExecuteObserver;
}) => Promise<{
  /** append 後の最新 Aggregate (no-op 時は現在の状態そのまま)。 */
  aggregate: Aggregate<TState>;
  /** append で追加された StoredEvent 列 (no-op 時は `[]`)。 */
  newEvents: ReadonlyArray<StoredEventsOf<TMap>>;
}> {
  // `createEventStoreTable` の tableName 検証と同じく、設定ミスを factory 生成時点で
  // 弾き、初回 `run()` 呼び出しまで持ち越さない。非 object の `defaults` は
  // `defaults?.maxRetries` 等が silent skip になるためここで弾く。値域違反
  // (`maxRetries` 非整数 / `everyNEvents` 非有限) も同じく factory 時点で弾く —
  // エラー型は executeCommand の検証 (RangeError / TypeError) と揃える。
  if (!isObjectRecord(deps)) {
    throw new TypeError("deps must be an object with config and store");
  }
  const { config, store, defaults } = deps;
  assertAggregateConfig(config);
  assertEventStoreShape(store);
  if (defaults !== undefined) {
    if (!isObjectRecord(defaults)) {
      throw new TypeError("defaults must be an object");
    }
    if (
      defaults.maxRetries !== undefined &&
      (!Number.isInteger(defaults.maxRetries) || defaults.maxRetries < 0)
    ) {
      throw new RangeError(
        `defaults.maxRetries must be a non-negative integer, got: ${String(defaults.maxRetries)}`,
      );
    }
    if (defaults.observer !== undefined && !isObjectRecord(defaults.observer)) {
      throw new TypeError("defaults.observer must be an object of ExecuteObserver hooks");
    }
    if (defaults.snapshotStore !== undefined) {
      assertSnapshotStoreShape(defaults.snapshotStore);
    }
    if (defaults.snapshotPolicy !== undefined) {
      if (!isObjectRecord(defaults.snapshotPolicy)) {
        throw new TypeError("defaults.snapshotPolicy must be an object");
      }
      if (!Number.isFinite(defaults.snapshotPolicy.everyNEvents)) {
        throw new TypeError(
          `defaults.snapshotPolicy.everyNEvents must be a finite number, got: ${String(defaults.snapshotPolicy.everyNEvents)}`,
        );
      }
    }
  }

  return <TInput>(args: {
    handler: CommandHandler<TState, TMap, NoInfer<TInput>>;
    aggregateId: string;
    input: TInput;
    maxRetries?: number;
    correlationId?: string;
    observer?: ExecuteObserver;
  }) => {
    // 非 object の args は `args.maxRetries` 等が undefined に揃って silent skip
    // (or 生 TypeError) になるため入口で弾く。
    if (!isObjectRecord(args)) {
      throw new TypeError("args must be an object with handler, aggregateId and input");
    }
    // exactOptionalPropertyTypes: true のため、optional プロパティは値が確定したときだけ含める。
    const maxRetries = args.maxRetries ?? defaults?.maxRetries;
    const observer = args.observer ?? defaults?.observer;
    const snapshotStore = defaults?.snapshotStore;
    const snapshotPolicy = defaults?.snapshotPolicy;
    return executeCommand<TState, TMap, TInput>({
      config,
      store,
      handler: args.handler,
      aggregateId: args.aggregateId,
      input: args.input,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
      ...(observer !== undefined ? { observer } : {}),
      ...(snapshotStore !== undefined ? { snapshotStore } : {}),
      ...(snapshotPolicy !== undefined ? { snapshotPolicy } : {}),
    });
  };
}
