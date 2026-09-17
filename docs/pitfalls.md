# Pitfalls and Gotchas

[English](pitfalls.md) | [日本語](pitfalls.ja.md)

Common traps encountered when building production systems with `@seike460/minamo`. Most are one-line fixes if you know them up front.

---

## 1. Array state must be declared `ReadonlyArray<T>`

`ReadonlyDeep<TState>` is applied recursively to State, including arrays. If you declare a mutable array, `evolve` returns a readonly array that TypeScript refuses to assign back to `TState`.

```ts
// ❌ TS2322: readonly ... is not assignable to mutable ...
interface InvoiceState {
  items: InvoiceLineItem[];
}

// ✅ Use ReadonlyArray for every array field in your State
interface InvoiceState {
  items: ReadonlyArray<InvoiceLineItem>;
}
```

**Rule of thumb**: any array inside Aggregate State should be `ReadonlyArray<T>`. This is the most common first-hour stumbling block.

---

## 2. Empty event payloads: use optional fields, not `Record<string, never>`

```ts
// ❌ Breaks tuple / union narrowing — the event drops out of CommandResult<TMap>
type ContractEvents = {
  "Contract.Activated": Record<string, never>;
};

// ✅ Use an optional marker field
type ContractEvents = {
  "Contract.Activated": { activatedAt?: string };
};
```

TypeScript infers `{ signedAt?: undefined }` on the fly during tuple narrowing, and `Record<string, never>` rejects it. An optional field sidesteps the conflict.

---

## 3. The projection layer is consumer-owned

`EventStore.append` / `EventStore.load` are under minamo's contract. **Stream → Read Model delivery is out of scope** (see `concept.md` §6 Non-Goals).

A runnable routing pattern (multiple Aggregates through one Lambda) is at [`examples/multi-aggregate-projection/`](../examples/multi-aggregate-projection/).

For local development or testing where you want projections to fire synchronously, wrap `EventStore` yourself:

```ts
class ProjectedEventStore<TMap extends EventMap> implements EventStore<TMap> {
  // loadFrom is optional on EventStore — forward it only when the inner store
  // implements it, or snapshot-based partial rehydration silently degrades to
  // a full load() + filter.
  readonly loadFrom?: EventStore<TMap>["loadFrom"];

  constructor(
    private inner: EventStore<TMap>,
    private onStored: (events: ReadonlyArray<StoredEventsOf<TMap>>) => void,
  ) {
    if (inner.loadFrom) this.loadFrom = inner.loadFrom.bind(inner);
  }

  async append(...args: Parameters<EventStore<TMap>["append"]>) {
    const stored = await this.inner.append(...args);
    try {
      this.onStored(stored);
    } catch {
      // swallow to mirror DynamoDB Streams async semantics — projector errors
      // must not roll back the successful append
    }
    return stored;
  }
  async load(...args: Parameters<EventStore<TMap>["load"]>) {
    return this.inner.load(...args);
  }
}
```

**Warning**: a synchronous `ProjectedEventStore` over `InMemoryEventStore` does **not** model the DynamoDB Streams latency of hundreds of milliseconds to seconds. Do not rely on "the projection is ready immediately after `append`" in tests that are meant to reflect production behaviour.

---

## 4. Inject non-deterministic values through `input`

`CommandHandler` is synchronous, deterministic, and side-effect free (DEC-005 / DEC-010). Clocks, UUIDs, and external sequences go through `input`:

```ts
await executeCommand({
  config,
  store,
  handler,
  aggregateId,
  input: {
    currentTime: new Date().toISOString(),
    correlationId: randomUUID(),
    ...userInput,
  },
});
```

Do this consistently. If you find yourself wanting `new Date()` inside the handler, the right move is to add that field to the handler's `TInput` and compute it at the boundary.

---

## 5. Peer dependency policy (`@aws-sdk/*`)

`@aws-sdk/client-dynamodb` / `@aws-sdk/lib-dynamodb` / `@aws-sdk/util-dynamodb` are declared as **optional peer dependencies at `^3.0.0`**. minamo will not introduce breaking AWS SDK requirements in patch or minor releases.

When you use `pnpm link:` or `npm link` during development, two separate SDK instances can be resolved and `clientConfig` assignments may fail with structural type mismatches. The fix is to install minamo from the npm registry (or to pass `client` directly so the typings never cross the boundary):

```ts
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));

const store = new DynamoEventStore<Events>({
  tableName: "events",
  client, // consumer-owned; no SDK type bridging across the minamo boundary
});
```

The SDK is resolved lazily at use time (DEC-027), so importing minamo without the SDK installed works and only Dynamo-backed calls fail. If you bundle your handler (esbuild, etc.), mark `@aws-sdk/*` as **external** — the lazy resolution looks in `node_modules`, so a bundled-in SDK would still surface as "not installed". Lambda runtimes ship the AWS SDK anyway, so keeping it external is also the size-optimal setup. Keep the bundle output **ESM**: the lazy resolver is built on `import.meta.url`, which bundlers erase in CJS output — degrading to CJS breaks even InMemory-only imports.

The same optionality holds at the type level as long as `skipLibCheck` is on (the `tsc --init` default and the community recommendation). The published `.d.ts` files still carry `import type` references to `@aws-sdk/*` — with `skipLibCheck: false` and no SDK installed, `tsc` reports `TS2307` inside minamo's declarations even for InMemory-only consumers. Keep `skipLibCheck: true`, or install the SDK packages as devDependencies if you deliberately check libraries.

---

## 6. Contract Tests cover `append` / `load`, not projection timing

minamo's Contract Tests guarantee that `InMemoryEventStore` and `DynamoEventStore` behave identically for:

- version monotonicity
- `ConcurrencyError` on expected-version mismatch
- fresh-read after successful `append`
- `EventLimitError` on empty input

They **do not** guarantee that projection-side reads converge at the same rate. In production, `DynamoEventStore` append → Streams → projection has real latency. Write integration tests that exercise eventual-consistency windows explicitly.

---

## 7. `executeCommand` retries are for `ConcurrencyError` only

Automatic retry happens when `append` throws `ConcurrencyError` (optimistic-locking collision). Any other error — handler throwing, `InvalidEventStreamError`, SDK transport error, `EventLimitError` — propagates as-is (concept.md §4).

If you want retries for transient SDK errors, wrap `DynamoEventStore` in a retrying `EventStore` adapter on the consumer side. Do not conflate the two retry layers.

Only errors thrown by `store.append` itself are eligible for the automatic retry. `evolve` runs **before** the append (so a throwing `evolve` prevents the commit entirely), while `ExecuteObserver.onCommitted` and snapshot saves run *after* the commit. If `onCommitted` throws a `ConcurrencyError`, it propagates to the caller **without** a retry — retrying it would re-append the same events. This also means a caller that sees `ConcurrencyError` cannot assume the command was not committed; if you surface this error to end users, re-read the stream (or use your own idempotency key) before asking them to retry.

Each retry re-runs the full cycle (load → rehydrate → handler → append), so `maxRetries` directly multiplies the worst-case read cost of a contended command.

---

## 8. Runtime validation and DynamoDB parity

Both built-in stores enforce the same input contract, so an `InMemoryEventStore` test cannot silently diverge from `DynamoEventStore` behaviour:

- `aggregateId` must be a non-empty string of at most 2048 UTF-8 bytes (the DynamoDB partition-key limit) — `TypeError` otherwise, on `append` / `load` / `loadFrom` / `SnapshotStore` alike
- every event needs a non-empty string `type` — `EventLimitError` otherwise. A malformed event committed to a real stream would poison every future `rehydrate`, so `append` rejects it before any write. `data` is optional: v0.2.0 accepted `data: undefined` (or no `data` key), which DynamoDB persisted without the attribute, so both stores still accept it and read it back as `data: undefined`
- `correlationId`, when provided, must be a string — `TypeError` otherwise (a non-string would marshall as a number and silently vanish on read)

Every object-shaped parameter — `config`, `config.evolve`, `options`, `observer`, `snapshotPolicy`, `createCommandRunner`'s `deps`/`defaults`, `run()` args, and the `client`/`clientConfig` pair — must be a plain record. `null`, arrays, functions and primitives are rejected with `TypeError` at the boundary (in `createCommandRunner`'s case, at factory creation), because an absent or mistyped optional object would otherwise be silently ignored (`options?.correlationId` collapsing to `undefined`) rather than failing loudly.

Event `data` (when present) and snapshot `state` must additionally be *plain data* (DEC-011) — the set of values that round-trip identically through `structuredClone` and DynamoDB marshall/unmarshall. `append` and `SnapshotStore.save` validate this recursively:

- rejected: functions, symbols, non-finite numbers (`NaN`/`Infinity`), `bigint`, `Map`, `Set`, `Date`, `RegExp`, class instances, `ArrayBuffer`/views other than `Uint8Array` (including `Buffer` and `Uint8Array` subclasses — unmarshall always returns a plain `Uint8Array`), circular references, own `__proto__` keys, enumerable symbol keys, `undefined` **array elements**, and payload nesting deeper than 30 levels (DynamoDB's 32-level item limit minus one level for the `data`/`state` attribute itself and one for the leaf scalar)
- accepted: `null`, booleans, finite numbers, strings, `Uint8Array`, arrays, and objects whose prototype is `Object.prototype` or `null`
- normalized, not rejected: `undefined` **object properties**. DynamoDB's `removeUndefinedValues` drops them attribute-by-attribute, so both stores strip them at persist time instead (`{ a: { b: undefined } }` is stored as `{ a: {} }`). Array elements are different — marshall silently drops `undefined` elements and shifts positions (`[1, undefined, 3]` → `[1, 3]`), so those stay rejected rather than silently corrupting data. The `undefined`-stripped form is also what snapshot saves persist and what store-loaded `data` looks like when it reaches `evolve`, so InMemory and DynamoDB persist and replay identical payload content

Two type-level constraints to know about:

- `EventMap` is `Record<string, unknown>`, so declare event maps with `type` aliases. An `interface` without an index signature does **not** satisfy the constraint.
- An event emitted without `data` (or with `data: undefined`) is persisted *without* the `data` attribute — the same form v0.2.0 produced via `removeUndefinedValues`. Reads restore it as `data: undefined`, and `evolve` handlers therefore see `data === undefined` for such events. Prefer declaring a payload type even when it is `{}` so `evolve` can rely on `data` being an object. Note that an optional EventMap *key* (`{ A?: { ... } }`) still makes `A` a required entry in `evolve` — omitting it is a compile error, since a persisted `A` event with no handler would make the stream un-rehydratable.

For the same reason `executeCommand` validates the `EventStore` / `SnapshotStore` contracts at runtime (load must return an array, append must return exactly the committed events with sequential versions, snapshots must carry `aggregateId` / `version` / `state` / `timestamp`). A custom store that violates the contract fails loudly with `TypeError` instead of corrupting the stream.

Finally, `DynamoEventStore` maps a `TransactionCanceledException` whose cancellation reason is `TransactionConflict` — not just `ConditionalCheckFailed` — to `ConcurrencyError`, so same-aggregate contention under parallel transactions is retried by `executeCommand` like any other optimistic-locking collision.
