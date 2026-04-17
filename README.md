# minamo

[![npm version](https://img.shields.io/npm/v/@seike460/minamo.svg)](https://www.npmjs.com/package/@seike460/minamo)
[![Node.js ≥24](https://img.shields.io/node/v/@seike460/minamo)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Type-safe CQRS + Event Sourcing for AWS Serverless.**

minamo は TypeScript / Node 24 / AWS SDK v3 を前提とした、薄く・厳しく・ドメインの言葉で書ける CQRS+ES ライブラリです。Aggregate / Command / Event / Projection Bridge の 4 つの公開 API だけを提供し、AWS プリミティブは consumer の手から取り上げません。

- **SLA なし**。production 保証は consumer 責務です
- **1 人メンテ** ([@seike460](https://github.com/seike460))。Pull Request 歓迎
- **MIT License**

> Status: v0.1.0 release pending (npm publish 待ち)。API は [`docs/concept.md`](docs/concept.md) §5 に逐字従属します。publish 後は上部バッジが version を示します。

---

## Install

```bash
pnpm add @seike460/minamo
# AWS SDK v3 は peer dependency (optional)。DynamoEventStore を使うときのみ追加
pnpm add @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/util-dynamodb
```

- `"type": "module"`、ESM only。Node ≥ 24
- `import` path に `.js` 拡張子を付けること (`verbatimModuleSyntax`)

## Quick Start — InMemory で 1 分

```ts
import {
  type AggregateConfig,
  type CommandHandler,
  InMemoryEventStore,
  executeCommand,
} from "@seike460/minamo";

type CounterEvents = {
  Incremented: { amount: number };
};

const counter: AggregateConfig<number, CounterEvents> = {
  initialState: 0,
  evolve: {
    Incremented: (state, data) => state + data.amount,
  },
};

const increment: CommandHandler<number, CounterEvents, { amount: number }> = (agg, input) => {
  if (input.amount === 0) return [];
  return [{ type: "Incremented", data: { amount: input.amount } }];
};

const store = new InMemoryEventStore<CounterEvents>();
const { aggregate } = await executeCommand({
  config: counter,
  store,
  handler: increment,
  aggregateId: "counter-1",
  input: { amount: 5 },
});

console.log(aggregate.state); // 5
```

`InMemoryEventStore` は test / ローカル学習用。本番では `DynamoEventStore` に差し替えます。同じ Contract Tests が両実装で green になるよう設計されているため、切替時の挙動差は構造的に抑えられています。

## Production — DynamoEventStore に切替

```ts
import { DynamoEventStore } from "@seike460/minamo";

const store = new DynamoEventStore<CounterEvents>({
  tableName: "events",
  // region / credentials を指定したい場合は clientConfig、
  // 既存 DocumentClient を再利用したい場合は client を渡す (詳細は API reference)
});

await executeCommand({
  config: counter,
  store,
  handler: increment,
  aggregateId: "counter-1",
  input: { amount: 5 },
});
```

テーブル schema (concept.md §3 / C11):

| attribute | kind | type |
|---|---|---|
| `aggregateId` | PK (HASH) | S |
| `version` | SK (RANGE) | N |

`StreamViewType=NEW_IMAGE` を有効化し、Projection Lambda で `parseStreamRecord` を使うと Read Model が組めます。

## Projection — Stream → Read Model

```ts
import { eventNamesOf, parseStreamRecord } from "@seike460/minamo";

const accepted = eventNamesOf(counter); // ["Incremented"]

export const handler = async (event: { Records: unknown[] }) => {
  for (const record of event.Records) {
    const stored = parseStreamRecord<CounterEvents>(record, accepted);
    if (stored === null) continue; // MODIFY / REMOVE / 未登録 type は安全に skip
    // consumer が Read Model を更新する
    await updateReadModel(stored);
  }
};
```

`BisectBatchOnFunctionError` + OnFailure destination + `ReportBatchItemFailures` の 3 点を consumer 側で構成することで poison pill を隔離できます (DEC-013 / DEC-014)。

## Optional — Standard Schema で input を validate

`CommandHandler` は同期・決定的・副作用なし。runtime validation は境界 (`executeCommand` の外) で行い、検証済みの値を `input` として注入します (DEC-005 / DEC-010 / DEC-015)。minamo は validator 実装には依存せず、[Standard Schema v1](https://standardschema.dev) interface のみを受け取る `validate` helper を提供します。

```ts
import { type CommandHandler, type InferSchemaOutput, executeCommand, validate } from "@seike460/minamo";
import { z } from "zod"; // Zod v3.24+ / Valibot v1 / ArkType v2 等、Standard Schema 対応 validator

const incrementInputSchema = z.object({ amount: z.number().int() });
type IncrementInput = InferSchemaOutput<typeof incrementInputSchema>;

const handler: CommandHandler<number, CounterEvents, IncrementInput> = (_agg, input) => {
  if (input.amount === 0) return [];
  return [{ type: "Incremented", data: { amount: input.amount } }];
};

// 境界で validate → 失敗なら ValidationError、成功なら型化された input
const input = await validate(incrementInputSchema, rawInput);
await executeCommand({ config: counter, store, handler, aggregateId: "counter-1", input });
```

仕様は [`docs/concept.md` §5.9](docs/concept.md#59-optional-input-validation-standard-schema-v1) / DEC-015 を参照。

## Design

- [`docs/concept.md`](docs/concept.md) — 設計思想と公開 API の canonical 仕様 (§5 API Design / §11 Decisions)
- [`docs/design/v0.1.0/`](docs/design/v0.1.0/) — unit 単位の detailed design (U1〜U9)
- [`docs/design/v0.1.0.md`](docs/design/v0.1.0.md) — implementation order と module structure
- API reference — typedoc で自動生成、GitHub Pages 配信 (D-06 で deploy 予定)

## v0.1.0 Exit Criteria

- U1〜U9 全 merged / Contract Tests が InMemory / Dynamo 両方で green
- concept.md §5 と `src/` の型シグネチャが逐字一致
- npm provenance 付き `@seike460/minamo@0.1.0` publish
- typedoc API reference の GitHub Pages 配信
- README.md に Quick Start (本ドキュメント)

## License

[MIT](LICENSE) © Shiro Seike
