/**
 * createCommandRunner — `executeCommand` の `config` / `store` / `handler` を
 * curry で固定する consumer-side factory。
 *
 * 同じ Aggregate に対する handler が多いコードベースでは、呼び出し側が毎回 5〜7 個の
 * object params を渡すのが冗長になる。この 3 行の factory をドメイン層に置けば
 * 呼び出しは `increment(aggregateId, input)` まで縮む。
 *
 * `executeCommand` の object params は optional 拡張 (`maxRetries` / `correlationId` /
 * 将来の追加) を breaking change にしないための意図選択。本 factory は本体 API に
 * 昇格させず、consumer が各自でコピーする recipe のまま維持する。
 */
import {
  type AggregateConfig,
  type CommandHandler,
  type EventMap,
  type EventStore,
  executeCommand,
} from "../../src/index.js";

export type RunCommandOptions = {
  readonly maxRetries?: number;
  readonly correlationId?: string;
};

export function createCommandRunner<TState, TMap extends EventMap, TInput>(
  config: AggregateConfig<TState, TMap>,
  store: EventStore<TMap>,
  handler: CommandHandler<TState, TMap, TInput>,
) {
  return (aggregateId: string, input: TInput, options: RunCommandOptions = {}) =>
    executeCommand({ config, store, handler, aggregateId, input, ...options });
}
