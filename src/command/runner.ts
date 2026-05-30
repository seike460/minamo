import type { Aggregate, AggregateConfig } from "../core/aggregate.js";
import type { EventMap, StoredEventsOf } from "../core/types.js";
import type { EventStore } from "../event-store/types.js";
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
  const { config, store, defaults } = deps;

  return <TInput>(args: {
    handler: CommandHandler<TState, TMap, NoInfer<TInput>>;
    aggregateId: string;
    input: TInput;
    maxRetries?: number;
    correlationId?: string;
    observer?: ExecuteObserver;
  }) => {
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
