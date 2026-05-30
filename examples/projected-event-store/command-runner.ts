/**
 * createCommandRunner — `executeCommand` の `config` / `store` / `handler` を
 * curry で固定する consumer-side factory。
 *
 * 同じ Aggregate に対する handler が多いコードベースでは、呼び出し側が毎回 5〜7 個の
 * object params を渡すのが冗長になる。この 3 行の factory をドメイン層に置けば
 * 呼び出しは `increment(aggregateId, input)` まで縮む。
 *
 * `executeCommand` の object params は optional 拡張 (`maxRetries` / `correlationId` /
 * 将来の追加) を breaking change にしないための意図選択。
 *
 * NOTE: v0.2.0 でこの recipe は first-party `createCommandRunner`（DEC-023, concept.md §5.13）
 * に昇格した。新規コードでは `import { createCommandRunner } from "@seike460/minamo"` を推奨する
 * （`observer` / `snapshotStore` の defaults もまとめられる）。本 recipe は「内部で何が起きているか」
 * を示す教材として残す。
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
