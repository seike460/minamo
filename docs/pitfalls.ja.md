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
  // loadFrom は EventStore の optional method。inner が実装する場合だけ転送する —
  // 転送を忘れると snapshot 起点の部分 rehydration が load() 全件 + filter に
  // 静かに退化する。
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

SDK は利用時点で lazy 解決される (DEC-027)。SDK 未 install でも `import` 自体は成功し、Dynamo 系の利用時のみ明示的なエラーになる。handler を bundler (esbuild 等) で bundle する場合は `@aws-sdk/*` を **external** にすること — lazy 解決は `node_modules` を探すため、SDK を bundle に含めると「not installed」エラーになる。Lambda runtime は AWS SDK を同梱するため external は容量面でも有利。出力は **ESM のまま** にすること — lazy 解決は `import.meta.url` 上に構築されており、bundler が CJS に変換するとこれが消えて InMemory 利用の import すら壊れる。

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

自動リトライの対象は `store.append` 自体が投げたエラーのみ。`evolve` の適用は append **前**に行われる（evolve が投げれば commit 自体が起きない）一方、`ExecuteObserver.onCommitted` と snapshot save は commit 後の処理。`onCommitted` が `ConcurrencyError` を投げた場合はリトライされず呼び出し側に伝播する（リトライすると同じイベントを二重に append するため）。したがって `ConcurrencyError` を見た呼び出し側は「コマンドが commit されなかった」とは断定できない。end user に再試行を促す前に stream を読み直すか、consumer 側の冪等キーで再実行可否を判定すること。

リトライは load → rehydrate → handler → append の全サイクルを回し直すため、`maxRetries` は競合したコマンドの worst-case の読み込みコストをそのまま倍増させる点に注意。

---

## 8. runtime 検証と DynamoDB parity

組み込みの両 store は同じ入力契約を強制する。`InMemoryEventStore` のテストが `DynamoEventStore` の挙動と静かに乖離しないようにするためである:

- `aggregateId` は非空文字列かつ UTF-8 で 2048 byte 以下 (DynamoDB partition key 上限)。`append` / `load` / `loadFrom` / `SnapshotStore` のいずれでも違反は `TypeError`
- 各 event は非空の string `type` と own property の `data` が必須。違反は `EventLimitError`。不正な event が実 stream に commit されると以後の `rehydrate` が全て失敗するため、`append` は書き込み前に reject する
- `correlationId` は指定するなら string。違反は `TypeError` (非文字列は marshall で数値化され、読み出し時に静かに消える)

型レベルの制約も 2 点ある:

- `EventMap` は `Record<string, unknown>`。event map は `type` alias で宣言すること。index signature を持たない `interface` は制約を**満たさない**
- event の `data` に `undefined` を実行時に渡してはいけない。`structuredClone` は `undefined` field を保持するが DynamoDB の `marshall` は落とすため、InMemory と DynamoDB で永続化内容が食い違う。payload field は optional で宣言する (`{ activatedAt?: string }`)

同じ理由で `executeCommand` は `EventStore` / `SnapshotStore` の契約を実行時に検証する (load は配列を返す、append は commit した event と同数・連番を返す、snapshot は `aggregateId` / `version` / `state` を持つ)。契約違反の custom store は stream を腐らせる代わりに `TypeError` で fail-loud する。

最後に、`DynamoEventStore` は cancellation reason が `TransactionConflict` の `TransactionCanceledException` も `ConditionalCheckFailed` 同様 `ConcurrencyError` に map する。並行 transaction による同一 aggregate への同時書き込み競合は、`executeCommand` で楽観的ロック衝突と同じくリトライされる。
