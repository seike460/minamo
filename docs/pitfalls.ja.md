# よくあるハマりどころ

[English](pitfalls.md) | **日本語**

`@seike460/minamo` で production を組んだ consumer から実際に報告された躓きどころ。大半は「知っていれば 1 行で済む」類。

---

## 1. State 内の配列は `ReadonlyArray<T>` で宣言する

`ReadonlyDeep<TState>` は State に再帰的に適用され、配列にも readonly 化が及ぶ。mutable array で書くと `evolve` の戻り値が readonly array になり、`TState` への代入が拒否される。

```ts
// ❌ TS2322: readonly 型は mutable に代入不可
interface InvoiceState {
  items: InvoiceLineItem[];
}

// ✅ State の配列フィールドはすべて ReadonlyArray で書く
interface InvoiceState {
  items: ReadonlyArray<InvoiceLineItem>;
}
```

**経験則**: Aggregate State 内の配列はすべて `ReadonlyArray<T>`。初見で最も踏みやすい罠。

---

## 2. 空 event payload は `Record<string, never>` ではなく optional field で書く

```ts
// ❌ tuple / union narrowing が壊れ、CommandResult<TMap> から脱落する
type ContractEvents = {
  "Contract.Activated": Record<string, never>;
};

// ✅ optional マーカーを一つ付ける
type ContractEvents = {
  "Contract.Activated": { activatedAt?: string };
};
```

TypeScript は tuple narrowing の過程で `{ signedAt?: undefined }` を派生させ、`Record<string, never>` はこれを受け付けない。optional field 一つで衝突を回避できる。

---

## 3. Projection layer は consumer の責務

`EventStore.append` / `EventStore.load` は minamo の契約下にあるが、**Stream → Read Model の配信は Non-Goals** (`concept.md` §6)。

複数 Aggregate を 1 Lambda で route する実行可能なパターンは [`examples/multi-aggregate-projection/`](../examples/multi-aggregate-projection/) を参照。

ローカル開発やテストで projection を同期に発火させたい場合は、自前で `EventStore` をラップする:

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
      // DynamoDB Streams の非同期 semantics を模倣: projector の失敗が
      // append 成功を rollback しないように swallow する
    }
    return stored;
  }
  async load(...args: Parameters<EventStore<TMap>["load"]>) {
    return this.inner.load(...args);
  }
}
```

**注意**: `InMemoryEventStore` + 同期 `ProjectedEventStore` は、DynamoDB Streams の数百ミリ秒〜数秒の遅延を再現しない。production を模倣したいテストで「append 直後に projection が読める」前提を置かないこと。

---

## 4. 非決定値は `input` 経由で注入する

`CommandHandler` は同期・決定的・副作用なし (DEC-005 / DEC-010)。時刻 / UUID / 外部 sequence はすべて `input` 経由で渡す:

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

handler 内で `new Date()` を呼びたくなったら、その値は `TInput` に追加して境界で計算する方向に倒す。

---

## 5. peer dependency ポリシー (`@aws-sdk/*`)

`@aws-sdk/client-dynamodb` / `@aws-sdk/lib-dynamodb` / `@aws-sdk/util-dynamodb` は **`^3.0.0` の optional peer dependency**。minamo は AWS SDK の breaking 要件を patch / minor で導入しない。

開発中に `pnpm link:` / `npm link` を使うと SDK が二重に resolve され `clientConfig` が構造的に不一致で代入できないことがある。解決策は npm registry から install するか、`client` を consumer 側で組み立てて渡す (境界で SDK 型が跨がない):

```ts
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));

const store = new DynamoEventStore<Events>({
  tableName: "events",
  client, // consumer が完全に所有する instance
});
```

---

## 6. Contract Tests は `append` / `load` の契約を保証する。projection timing は保証しない

minamo の Contract Tests は `InMemoryEventStore` / `DynamoEventStore` の以下の振る舞いを同一に保つ:

- version の単調増加
- expected-version 不一致時の `ConcurrencyError`
- `append` 成功後の fresh read
- 空配列に対する `EventLimitError`

ただし **projection 側の読み取り収束速度は保証対象外**。production の `DynamoEventStore` → Streams → projection には実際の遅延がある。結果整合性のウィンドウを意識した integration test を consumer 側で書くこと。

---

## 7. `executeCommand` の自動リトライは `ConcurrencyError` 限定

`append` が `ConcurrencyError` (楽観的ロックの衝突) を投げた場合のみリトライされる。それ以外のエラー (handler throw / `InvalidEventStreamError` / SDK 通信エラー / `EventLimitError`) はそのまま伝播する (concept.md §4)。

SDK の transient error に対するリトライが必要なら、`DynamoEventStore` をリトライ付き `EventStore` で wrap する。minamo の retry 層と混同しない。
