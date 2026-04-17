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
  constructor(
    private inner: EventStore<TMap>,
    private onStored: (events: ReadonlyArray<StoredEventsOf<TMap>>) => void,
  ) {}

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
