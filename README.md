# minamo

**English** | [日本語](README.ja.md)

[![npm version](https://img.shields.io/npm/v/@seike460/minamo.svg)](https://www.npmjs.com/package/@seike460/minamo)
[![Node.js ≥24](https://img.shields.io/node/v/@seike460/minamo)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Type-safe CQRS + Event Sourcing for AWS Serverless.**

minamo is a CQRS + Event Sourcing library for TypeScript / Node 24 / AWS SDK v3 that stays thin, strict, and lets you write the write side in your domain's own words. It exposes exactly four public surfaces — Aggregate, Command, Event, and Projection Bridge — and never takes AWS primitives out of your hands.

- **No SLA.** Production guarantees are the consumer's responsibility
- **Single-maintainer** ([@seike460](https://github.com/seike460)). Pull requests welcome
- **MIT License**

> Status: v0.1.0 released on npm as `@seike460/minamo`. The public API follows [`docs/concept.md`](docs/concept.md) §5 verbatim.

---

## Install

```bash
pnpm add @seike460/minamo
# AWS SDK v3 is an optional peer dependency — only needed when you use DynamoEventStore
pnpm add @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/util-dynamodb
```

- `"type": "module"`, ESM only. Node ≥ 24
- Include the `.js` extension in `import` paths (`verbatimModuleSyntax`)

## Quick Start — InMemory in one minute

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

`InMemoryEventStore` is for tests and local exploration. In production you swap it for `DynamoEventStore`. Both implementations run the same Contract Tests, so behavioural drift between them is structurally constrained.

## Production — switch to DynamoEventStore

```ts
import { DynamoEventStore } from "@seike460/minamo";

const store = new DynamoEventStore<CounterEvents>({
  tableName: "events",
  // Use clientConfig when you need region / credentials, or
  // pass a pre-built DocumentClient via `client` (see API reference)
});

await executeCommand({
  config: counter,
  store,
  handler: increment,
  aggregateId: "counter-1",
  input: { amount: 5 },
});
```

Table schema (concept.md §3 / C11):

| attribute | kind | type |
|---|---|---|
| `aggregateId` | PK (HASH) | S |
| `version` | SK (RANGE) | N |

Enable `StreamViewType=NEW_IMAGE` and use `parseStreamRecord` in a Projection Lambda to build Read Models.

## Projection — Stream → Read Model

```ts
import { eventNamesOf, parseStreamRecord } from "@seike460/minamo";

const accepted = eventNamesOf(counter); // ["Incremented"]

export const handler = async (event: { Records: unknown[] }) => {
  for (const record of event.Records) {
    const stored = parseStreamRecord<CounterEvents>(record, accepted);
    if (stored === null) continue; // MODIFY / REMOVE / unregistered type is skipped safely
    // consumer updates the Read Model
    await updateReadModel(stored);
  }
};
```

Isolate poison pills by configuring `BisectBatchOnFunctionError`, an OnFailure destination, and `ReportBatchItemFailures` on the consumer side (DEC-013 / DEC-014).

## Optional — validate input with Standard Schema

`CommandHandler` is synchronous, deterministic, and side-effect free. Runtime validation happens at the boundary (outside `executeCommand`), and the validated value flows in as `input` (DEC-005 / DEC-010 / DEC-015). minamo does not depend on any validator implementation; instead it ships a `validate` helper that accepts the [Standard Schema v1](https://standardschema.dev) interface.

```ts
import { type CommandHandler, type InferSchemaOutput, executeCommand, validate } from "@seike460/minamo";
import { z } from "zod"; // Zod v3.24+ / Valibot v1 / ArkType v2 — any Standard Schema-compatible validator

const incrementInputSchema = z.object({ amount: z.number().int() });
type IncrementInput = InferSchemaOutput<typeof incrementInputSchema>;

const handler: CommandHandler<number, CounterEvents, IncrementInput> = (_agg, input) => {
  if (input.amount === 0) return [];
  return [{ type: "Incremented", data: { amount: input.amount } }];
};

// Validate at the boundary — throws ValidationError on failure, returns a typed value on success
const input = await validate(incrementInputSchema, rawInput);
await executeCommand({ config: counter, store, handler, aggregateId: "counter-1", input });
```

See [`docs/concept.md` §5.9](docs/concept.md#59-optional-input-validation-standard-schema-v1) / DEC-015 for the full specification.

## Design

- [`docs/concept.md`](docs/concept.md) — Design philosophy and the canonical public API spec (§5 API Design / §11 Decisions)
- [`docs/design/v0.1.0/`](docs/design/v0.1.0/) — Per-unit detailed design (U1–U9)
- [`docs/design/v0.1.0.md`](docs/design/v0.1.0.md) — Implementation order and module structure
- [`docs/pitfalls.md`](docs/pitfalls.md) — Pitfalls and gotchas learned from real production use
- API reference — Auto-generated by typedoc, served on GitHub Pages

## Examples

Runnable examples under [`examples/`](examples/) mirror the code in this README and provide canonical patterns for common use cases:

- [`examples/counter/`](examples/counter/) — Minimal InMemory and DynamoEventStore demos (concept.md §4)
- [`examples/multi-aggregate-projection/`](examples/multi-aggregate-projection/) — Route N Aggregates through one Lambda with `parseStreamRecord` + `eventNamesOf` (DEC-009 + DEC-013)
- [`examples/dynamodb-local/`](examples/dynamodb-local/) — End-to-end `DynamoEventStore` on Docker DynamoDB Local (append / load / rehydrate / `ConcurrencyError`)

## License

[MIT](LICENSE) © Shiro Seike
