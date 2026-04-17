# minamo — 水面

Type-safe CQRS+ES library for Amazon DynamoDB and AWS Lambda.

Everything Will Be Serverless.

---

## 1. Problem

### Amazon DynamoDB の読み取りパターンは構造的に制約される

Amazon DynamoDB の GetItem は PK+SK 指定で一桁ミリ秒の応答を返す。
しかし、複数のアクセスパターンを1つのテーブルで解こうとすると GSI の追加やキーのオーバーローディングが必要になる。
Single Table Design（STD）はこれを1テーブル内で解く手法だが、アクセスパターンが増えるほど GSI の追加が必要になり、書き込みコストが増加し、テーブル設計の複雑性が上がる。

> **Fact:** DynamoDB の GSI は、GSI に反映が必要な書き込みが発生するたびに追加の書き込みコストが発生する。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html (checked: 2026-04-12)

CQRS（Command Query Responsibility Segregation）は、アクセスパターンが多く STD では GSI が膨らみすぎる場合に有効な構造的回答の一つである。
書き込みモデルと読み取りモデルを分離し、読み取りモデルをアクセスパターンごとに最適化する。
各 Read Model は GetItem や最適化された Query で応答できる設計にする。必要なら GSI も使う。

### Event Sourcing が CQRS を AWS Serverless で実現可能にする

Event Sourcing（ES）は状態の変更をイベントとして記録し、イベントの再生で状態を復元する。
CQRS と組み合わせることで、Event Store に書き込まれたイベントが Read Model の構築に自然に流れる。

AWS はこのアーキテクチャの構成要素を提供している:

- **Amazon DynamoDB** — Event Store として PK=aggregateId, SK=version でイベントを格納。Read Model のストレージにもなる
- **DynamoDB Streams** — Event Store への書き込みを自動的にキャプチャし、AWS Lambda にイベントを配信する
- **AWS Lambda** — Command Handler の実行と、Streams からのイベントを受けた Read Model の構築を担う。ステートレスな実行モデルは Command Handler と構造的に一致する

> **Fact:** DynamoDB Streams は、テーブルへの変更をキャプチャし、同一アイテムへの変更が行われた順序でストリームレコードを提供する。保持期間は 24 時間。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html (checked: 2026-04-12)
>
> **Assumption:** 異なるアイテム間の順序は保証されない（詳細はセクション 3 Constraints の Assumption を参照）。

### しかし CQRS+ES の Write 側を DynamoDB で正しく実装するのは構造的に難しい

CQRS+ES のアーキテクチャ自体は AWS のプリミティブで構成できる。
しかし、Event Store の Write 側（Aggregate ライフサイクル: Load → Decide → Append）を正しく実装するには、DynamoDB 固有の構造的困難がある。

#### 痛み A: 楽観的ロックの正しい実装

DynamoDB 上の Event Store で ConditionExpression を正しく書くことがデータ整合性の生命線になる。
Lambda の同時実行モデルは、同一 Aggregate への並列アクセスを構造的に発生させるため、この問題がより顕在化する。

| 問題 | 原因 | 影響 |
|------|------|------|
| バージョン重複 | ConditionExpression なしの PutItem | 後の書き込みが先行イベントをサイレントに上書き。データ消失 |
| バージョンギャップ | 現在の最大バージョンが期待値と一致するか検証しない | v=5 → v=7 が成立。v=6 が永久欠落 |
| 部分書き込み | 複数イベントを個別 PutItem で書く | 2 個目が失敗すると 1 個目だけが残る。アトミック性の欠如 |

> **Fact:** castore の DynamoDB adapter で重複検知バグが報告されている（Issue #92、CLOSED）。
> Source: https://github.com/castore-dev/castore/issues/92 (checked: 2026-04-12)
>
> **Fact:** castore で同一 version 衝突に関する運用課題が報告されている（Issue #180、CLOSED）。
> Source: https://github.com/castore-dev/castore/issues/180 (checked: 2026-04-12)

#### 痛み B: ConcurrencyError 後の正しいリトライ

楽観的ロック失敗後に古い state のまま Command を再実行すると、ビジネスルール検証が最新でない状態に対して行われる。

```
Lambda-A: Load(v=10) → Decide(在庫=5) → Append(v=11) ✓
Lambda-B: Load(v=10) → Decide(在庫=5) → Append(v=11) → ConcurrencyError
Lambda-B: 古い state で再 Decide → 在庫=5 と判断 → 実際は v=11 で在庫=0
```

正しいリトライは Load からやり直し、最新の state で Decide を再実行すること。
この「Load からやり直す」配線を Command Handler ごとに正しく書くのは、一貫性の維持が難しい。

#### 痛み C: テスト時の InMemory と本番 DynamoDB の振る舞い差異

InMemory の Event Store を自前で書くこと自体は容易だが、本番の DynamoDB 実装と同じ制約（楽観的ロック、バージョン順序、ConcurrencyError の発火条件）を本当に守っているかを誰も保証しない。

> **Fact:** castore で `pushEventTransaction` が InMemory adapter では利用できず、テスト時のコードパスが本番と分岐する問題が報告されている（Issue #66、CLOSED。unified event groups API で対応済みだが、Contract Tests による明示的な振る舞い保証は行われていない）。
> Source: https://github.com/castore-dev/castore/issues/66 (checked: 2026-04-12)

### minamo はこれらの Write 側を安全に実装しやすくする

minamo は CQRS+ES の Aggregate ライフサイクル（Load → Decide → Append）を型安全に実装し、上記の痛み A/B/C を安全に実装しやすくする。

CQRS+ES のアーキテクチャ全体（Read Model の設計、DynamoDB Streams による伝播、EventBridge によるルーティング）は AWS のプリミティブに委ね、ドキュメントとパターンでガイドする。

---

## 2. Target User

Amazon DynamoDB 上で複数の読み取りパターンを扱うシステムを構築しているチーム。

### 前提条件

- Amazon DynamoDB を使っている、または使うことを決めている
- AWS Lambda + TypeScript を対応環境としている
- CQRS+ES の事前経験は不要。ただし DynamoDB + Lambda + 結果整合性の基本理解は前提とする

### こういう課題を持つチームに特に刺さる

- 同一データに対する並行更新が発生し、整合性の担保が必要
- Read Model が複数必要になり、GSI の設計に限界を感じている
- 状態変更の履歴や監査証跡がビジネス上重要
- 楽観的ロックやリトライの実装を共通化したい

---

## 3. Constraints

minamo の設計判断に直結する Amazon DynamoDB、AWS Lambda、CQRS+ES パターンの構造的制約。

### Amazon DynamoDB の制約

| 制約 | 値 | minamo への影響 |
|------|-----|----------------|
| TransactWriteItems 上限 | 100 操作 / 4MB | append で ConditionCheck 1 件 + Put N 件。1 コマンドあたり最大 99 イベント |
| Query 結果サイズ上限 | 1MB（FilterExpression 評価前） | load で `LastEvaluatedKey` によるページネーションが必須 |
| アイテムサイズ上限 | 400KB（属性名含む） | イベント 1 件のペイロード上限。大きなデータは S3 参照パターンを推奨 |
| ConsistentRead | テーブルと LSI のみ。GSI は不可 | Event Store の load は `ConsistentRead: true` が必須。古い state での Decide を防ぐ。コスト: strongly consistent read は eventually consistent read の 2 倍の RCU を消費する。on-demand テーブルでは透過的だが、provisioned テーブルではキャパシティ計画に考慮が必要 |
| トランザクション WCU | 通常の 2 倍 | TransactWrite によるアトミック性の対価。コスト試算時に考慮 |
| Streams 保持期間 | 24 時間 | Projection Lambda が 24 時間以上停止するとイベント消失。minamo のスコープ外だが運用上の警告 |
| Streams 順序保証 | 同一アイテムへの変更順序のみ | Event Store の設計上、同一 Aggregate 内の順序は保証される |
| Streams 同時読者 | shard あたり最大 2（Global Tables は 1 推奨） | 複数の Projection Lambda を同一 Stream に接続する場合の制約 |
| BatchWriteItem | ConditionExpression 非サポート | Event Store の書き込みには使えない。TransactWriteItems を使う |

> **Fact:** TransactWriteItems は 2024 年 11 月に 25 → 100 操作に引き上げられた。合計ペイロード上限は 4MB。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html (checked: 2026-04-12)
>
> **Fact:** ConsistentRead は Query でも使用可能（テーブルと LSI のみ。GSI は不可）。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html (checked: 2026-04-12)
>
> **Fact:** DynamoDB Streams の同一シャードに対する同時読者は最大 2。Global Tables では 1 が推奨。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html (checked: 2026-04-12)
>
> **Fact:** BatchWriteItem は条件式をサポートしない。楽観的ロックが必要な Event Store の書き込みには TransactWriteItems を使う。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html (checked: 2026-04-12)
>
> **Fact:** Query の結果セットは 1MB 上限。アイテムサイズは 400KB 上限（属性名含む）。トランザクション書き込みは通常の 2 倍の WCU を消費する。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html (checked: 2026-04-12)

### AWS Lambda の制約

| 制約 | 値 | minamo への影響 |
|------|-----|----------------|
| ステートレス実行 | invocation 間でインメモリ状態の共有は保証されない | Command Handler は毎回 Load からやり直す。キャッシュに依存しない設計 |
| 同時実行 | デフォルト 1,000 / リージョン | 同一 Aggregate への並列アクセスが構造的に発生。楽観的ロックの正しさが必須 |
| Event Source Mapping | at-least-once delivery | Projection Lambda で重複処理が発生しうる。冪等な Read Model 更新が必要 |
| ParallelizationFactor | 1–10（デフォルト 1） | 1 を超えると同一シャード内でもイベント順序が崩れる |
| 実行時間上限 | 15 分 | 大量イベントの Rehydration がタイムアウトするリスク。Snapshot の検討基準 |
| ペイロード上限 | 同期 6MB / 非同期 256KB | TransactWriteItems の 4MB より大きいが、大量イベント時に実効上限となりうる |

> **Fact:** Lambda の同期呼び出しペイロード上限は 6MB、非同期呼び出しは 256KB。
> Source: https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html (checked: 2026-04-12)

> **Fact:** Lambda Event Source Mapping は at-least-once であり、重複処理が発生しうることが公式に明記されている。
> Source: https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventsourcemapping.html (checked: 2026-04-12)
>
> **Fact:** Lambda のデフォルト同時実行数は 1,000/リージョン。実行時間上限は 15 分。ParallelizationFactor は 1–10（デフォルト 1）。
> Source: https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html (checked: 2026-04-12)
> Source: https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html (checked: 2026-04-12)

### CQRS+ES パターンの制約

| 制約 | 内容 | minamo への影響 |
|------|------|----------------|
| 結果整合性 | Command → Event → Projection は非同期。Read Model は即座に最新にならない | minamo のスコープ外。ドキュメントで注意喚起 |
| イベントスキーマ進化 | 過去のイベントとの互換性維持が必要（upcasting） | v1 スコープ外。Non-Goals に明記 |
| Aggregate イベント数増加 | Rehydration コストがイベント数に比例 | v1 は Snapshot なし。短いストリーム設計を推奨 |

> **Fact:** CQRS+ES パターンでは、Read Model は Event Store からのイベント伝播により結果整合的に更新される。即座に最新にはならない。
> Source: https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/cqrs-pattern.html (checked: 2026-04-12)
>
> **Fact:** Event Sourcing パターンでは、イベントスキーマの進化（upcasting）が必要になる。過去のイベントは不変であり、新しいスキーマとの互換性は利用者が管理する。
> Source: https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-data-persistence/service-per-team.html (checked: 2026-04-12)
>
> **Fact:** Event Sourcing では Aggregate の状態復元にイベントの再生が必要であり、イベント数に比例してコストが増加する。Snapshot はこのコストを軽減する手法だが、追加の複雑性を伴う。
> Source: https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing (checked: 2026-04-12)

> **Assumption:** 異なるアイテム間の Streams 順序は保証されない。AWS ドキュメントは同一アイテムの順序保証のみを明示しており、クロスアイテムの順序保証への言及はない。

---

## 4. Solution

minamo は CQRS+ES の Write 側を構成する以下の要素を提供する。

### セクション 1 の痛みに対する回答

| 痛み | minamo の回答 |
|------|-------------|
| A: 楽観的ロックの正しい実装 | `EventStore.append()` が TransactWriteItems + ConditionCheck でアトミックな書き込みとバージョン検証を行う。利用者は ConditionExpression を書かない |
| B: ConcurrencyError 後の正しいリトライ | `executeCommand()` が Load → Rehydrate → Decide → Append の全サイクルを管理し、`append` で `ConcurrencyError` が発生した場合のみ Load から全体をやり直す |
| C: InMemory と DynamoDB の振る舞い差異 | `InMemoryEventStore` が `append` / `load` の公開契約（バージョン検証、連番保証、ConcurrencyError 発火条件）を実装し、`rehydrate()` が `invalid_initial_version` を含む不正ストリームを `InvalidEventStreamError` として検出する。Contract Tests で一致を保証する |

### 提供するもの

- **EventStore interface** — イベントの永続化と読み込みの契約
- **DynamoEventStore** — EventStore の Amazon DynamoDB 実装
- **InMemoryEventStore** — EventStore のテスト用実装（`append` / `load` の公開契約を実装）
- **rehydrate** — イベントリプレイによる Aggregate 状態の復元と、不正ストリームの検出
- **executeCommand** — Aggregate ライフサイクルの実行と `ConcurrencyError` 時の全サイクル自動再試行
- **型安全な Aggregate 定義** — Events 型 → evolve ハンドラの型推論でイベントハンドラの漏れをコンパイル時に検出
- **ConcurrencyError** — 楽観的ロック失敗を表す明示的なエラー型
- **EventLimitError** — `append` の入力制約違反や実装固有の件数 / サイズ制約違反を表す明示的なエラー型
- **InvalidEventStreamError** — 壊れたイベントストリーム（`aggregateId` 不一致、`version_gap`、`invalid_initial_version`、`missing_evolve_handler` など）を表す明示的なエラー型

### Non-Goals

詳細はセクション 6 に記載。

- Read Model の永続化・管理（Projection の型安全な橋渡しは `parseStreamRecord` で提供）
- Saga / Process Manager
- CDK Construct
- EventBridge Publisher
- Snapshot
- イベントスキーマ進化（upcasting）
- 複数 DB 対応

### 設計の姿勢

- **DynamoDB API 呼び出し以外のオーバーヘッドを加えない**
- **AWS のプリミティブをラップしない** — DynamoDB Streams、EventBridge、Step Functions はそのまま使う
- **設計の邪魔をしない** — Aggregate 境界、イベント粒度、Read Model 設計は利用者が決める

### 最小コード例

以下は ESM (`"type": "module"`) 環境での実行を前提とする。実行可能な同等コードは [`examples/counter/`](../examples/counter/) に配置されており、InMemoryEventStore 版と DynamoEventStore 版 (DynamoDB Local 接続) の両方を `pnpm exec tsx` で走らせられる。

```typescript
import {
  type AggregateConfig,
  type CommandHandler,
  executeCommand,
  InMemoryEventStore,
} from "@seike460/minamo";

// イベント: 型名 → payload の対応
type CounterEvents = {
  Incremented: { amount: number };
};

// Aggregate: 初期状態とイベントごとの状態進化
const counter: AggregateConfig<number, CounterEvents> = {
  initialState: 0,
  evolve: {
    // data の型は CounterEvents["Incremented"] から推論される
    Incremented: (state, data) => state + data.amount,
  },
};

// Command Handler: 現在の state と input からイベントを決める
// 第1引数は Load 済みの Aggregate（state と version を持つ）
const increment: CommandHandler<number, CounterEvents, { amount: number }> = (
  aggregate,
  input,
) => {
  if (input.amount === 0) {
    return []; // no-op: append は呼ばれず version も進まない
  }

  if (aggregate.state + input.amount > 100) {
    throw new Error(
      `Counter cannot exceed 100 (current: ${aggregate.state}, adding: ${input.amount})`,
    );
  }
  return [{ type: "Incremented", data: { amount: input.amount } }];
};

// テスト / デモ用。本番では DynamoEventStore を使う
const store = new InMemoryEventStore<CounterEvents>();

// まだイベントがない aggregateId は initialState=0, version=0 の Aggregate として開始される
const result = await executeCommand({
  config: counter,
  store,
  handler: increment,
  aggregateId: "counter-1",
  input: { amount: 5 },
});

// result.aggregate: 実行後の Aggregate（state + version）
console.log(result.aggregate.state);    // 5
console.log(result.aggregate.version);  // 1
console.log(result.newEvents[0].type);  // "Incremented"
console.log(result.newEvents[0].data);  // { amount: 5 }

const noOp = await executeCommand({
  config: counter,
  store,
  handler: increment,
  aggregateId: "counter-1",
  input: { amount: 0 },
});

console.log(noOp.aggregate.state);      // 5
console.log(noOp.aggregate.version);    // 1
console.log(noOp.newEvents.length);     // 0
```

本番でも Aggregate 定義と Command Handler はそのまま使える。store 実装を `DynamoEventStore` に置き換える。`client` を渡した場合はそれが最優先され、`clientConfig` は無視される。

```typescript
import { DynamoEventStore } from "@seike460/minamo";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-northeast-1" }),
);

const prodStore = new DynamoEventStore<CounterEvents>({
  tableName: "minamo-event-store",
  client,
});
```

### executeCommand の再試行契約

- 再試行の発火条件は `append` で `ConcurrencyError` が発生したときだけ
- 再試行時は Load → Rehydrate → Decide → Append を最初からやり直す。`handler` は最新 state で再実行され、複数回呼ばれうる
- `maxRetries` は「追加の再試行回数」。デフォルト 3、`maxRetries=0` なら再試行なし、総試行回数上限は `1 + maxRetries`
- `ConcurrencyError` 以外のエラーは再試行せず、その場で throw する。再試行後に最新 state で再 Decide した結果 handler が例外を throw するケースは、技術的競合（ConcurrencyError）ではなくドメインのバリデーション失敗であり、リトライ対象外である
- handler の純粋性（DEC-005）により、同じ `aggregate` と `input` からは決定的にイベントが導出されるため、ConcurrencyError に対する技術的リトライは安全である
- `maxRetries` が非負整数でない場合は `RangeError` を Load 前に throw する
- `1 + maxRetries` 回の append 試行でも競合が解消しない場合は最後の `ConcurrencyError` をそのまま throw する
- `handler` が空配列を返した場合は no-op 成功として終了し、`append` も再試行も行わない
- `handler` は再試行で複数回実行されうるため、副作用を含めてはならない（DEC-005）。非決定的要素は `input` 経由で注入する（DEC-010）
- v1 は即時リトライ。backoff / jitter は提供しない（DEC-012）。即時リトライは低競合 Aggregate を前提としており、高競合時（hot aggregate）は Aggregate 境界の見直し、呼び出し側での backoff / 同時実行抑制が必要。`ConcurrencyError` 発生率と retry exhaustion は監視対象とすべき

---

## 5. API Design

minamo の公開 API の型シグネチャ定義（`.d.ts` 相当。実装は省略）。

### 5.1 Core Types

```typescript
/** ドメインイベント: 「何が起きたか」を表す不変のファクト */
export interface DomainEvent<
  TType extends string = string,
  TData = unknown,
> {
  readonly type: TType;
  readonly data: TData;
}

/**
 * 永続化されたイベント: Event Store が付与するメタデータを含む。
 * timestamp は ISO 8601 UTC 形式（例: "2026-04-12T04:00:00.000Z"）。
 */
export interface StoredEvent<
  TType extends string = string,
  TData = unknown,
> extends DomainEvent<TType, TData> {
  readonly aggregateId: string;
  readonly version: number;
  readonly timestamp: string;
  readonly correlationId?: string;
}

/** イベント型名 → payload 型の対応表 */
export type EventMap = Record<string, unknown>;

/** EventMap から DomainEvent のユニオン型を生成 */
export type EventsOf<TMap extends EventMap> = {
  [K in keyof TMap & string]: DomainEvent<K, TMap[K]>;
}[keyof TMap & string];

/** EventMap から StoredEvent のユニオン型を生成 */
export type StoredEventsOf<TMap extends EventMap> = {
  [K in keyof TMap & string]: StoredEvent<K, TMap[K]>;
}[keyof TMap & string];

/** object / array / tuple を再帰的に readonly 化する。tuple の length・位置別型・variadic 構造を保持する */
export type ReadonlyDeep<T> =
  T extends (...args: any[]) => unknown ? T :
  T extends readonly unknown[]
    ? IsTuple<T> extends true
      ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
      : ReadonlyArray<ReadonlyDeep<T[number]>>
    : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } :
  T;

// `IsTuple<T>` は tuple / plain array を判定する内部補助型であり export されない
// (@internal / intentionallyNotExported)。判定戦略 (length-literal 2 段階判定) と
// 実装は `src/types.ts` および U1 design §6 を参照。

/**
 * 状態進化関数のマップ: 各イベント型に対して state を進化させる純粋関数。
 *
 * - state と data は ReadonlyDeep で渡される。破壊的変更は型でも禁止する
 * - 戻り値で次の state を明示的に返す
 */
export type Evolver<TState, TMap extends EventMap> = {
  [K in keyof TMap & string]: (
    state: ReadonlyDeep<TState>,
    data: ReadonlyDeep<TMap[K]>,
  ) => TState;
};
```

### 5.2 Aggregate

```typescript
/**
 * Aggregate の定義: 初期状態とイベントごとの状態進化関数。
 *
 * TState は structured-cloneable な plain data に限定する。
 * rehydrate 時に structuredClone で initialState を複製するため、
 * 関数、Symbol、DOM ノード等を含む型は使用不可。
 * 公開 API では state は immutable view として扱う。
 */
export interface AggregateConfig<TState, TMap extends EventMap> {
  readonly initialState: ReadonlyDeep<TState>;
  readonly evolve: Evolver<TState, TMap>;
}

/** ハイドレーション済みの Aggregate: Load + Rehydrate の結果 */
export interface Aggregate<TState> {
  readonly id: string;
  readonly state: ReadonlyDeep<TState>;
  readonly version: number;
}
```

### 5.3 Command

```typescript
/** Command の実行結果: 0 個以上の DomainEvent */
export type CommandResult<TMap extends EventMap> = ReadonlyArray<EventsOf<TMap>>;

/**
 * Command Handler: 現在の Aggregate と input からイベントを決める同期の純粋関数。
 *
 * - executeCommand の再試行で複数回呼ばれうる
 * - 副作用（外部 API 呼び出し、I/O）を含めてはならない
 * - 非同期バリデーションが必要な場合は executeCommand の外で行い、結果を input に含める
 * - ビジネスルール違反時は例外を throw する
 * - 空配列を返すと「何もしない」を意味する（no-op command）
 */
export type CommandHandler<
  TState,
  TMap extends EventMap,
  TInput,
> = (
  aggregate: Aggregate<TState>,
  input: TInput,
) => CommandResult<TMap>;
```

### 5.4 EventStore

```typescript
/**
 * Event Store の抽象インターフェース。
 * 単一 Aggregate ストリームの append/load 契約だけを定義する。
 * TMap で型を貫通させ、入出力を型安全にする。
 * 件数上限・サイズ上限・fresh read の実現方法などの実装詳細は各実装の責務。
 *
 * Version Model:
 * - version は Aggregate ごとのローカル連番であり、グローバル連番ではない
 * - 空のストリームの Aggregate.version は 0
 * - 永続化済みイベントの version は 1 始まり
 * - expectedVersion は append 開始時点の Aggregate.version を表す
 * - append で N 件成功した後の Aggregate.version は expectedVersion + N
 * - append の返り値は expectedVersion + 1 から expectedVersion + N までの連番になる
 */
export interface EventStore<TMap extends EventMap> {
  /**
   * イベントを Aggregate ストリームにアトミックに追加する。
   *
   * Preconditions:
   * - expectedVersion >= 0
   * - events.length >= 1（空配列は EventLimitError）
   *
   * Postconditions:
   * - 返り値の長さ === events.length
   * - 返り値は入力 events と同じ順序で永続化される
   * - 返り値は version 昇順・連番の StoredEvent 配列
   * - 返り値[0].version === expectedVersion + 1
   * - 返り値[events.length - 1].version === expectedVersion + events.length
   * - 返り値の各 StoredEvent.aggregateId === 引数の aggregateId
   * - 返り値の各 StoredEvent.correlationId === options?.correlationId
   * - 返り値の各 StoredEvent.timestamp は ISO 8601 UTC
   *
   * Error conditions:
   * - expectedVersion と実際の最大バージョンが一致しない → ConcurrencyError
   * - events.length === 0 → EventLimitError
   * - 実装固有の制約超過（件数・サイズ等）→ 実装が定義するエラー
   */
  append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;

  /**
   * Aggregate の全イベントをバージョン順で読み込む。
   *
   * - 存在しない aggregateId に対しては空配列を返す（エラーではない）
   * - 直前に成功した append の結果を観測できることを保証する（fresh read）
   * - 返り値の各 StoredEvent.aggregateId === 引数の aggregateId
   * - 返り値は version 昇順・連番
   * - 返り値が空でない場合、最初の version は 1
   * - fresh read の実現方法は実装が責任を持つ
   */
  load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
}

/** append のオプション */
export interface AppendOptions {
  readonly correlationId?: string;
}
```

### 5.5 Errors

```typescript
/** 楽観的ロック失敗: 同一バージョンへの同時書き込みを検出 */
export declare class ConcurrencyError extends Error {
  readonly name: "ConcurrencyError";
  readonly aggregateId: string;
  readonly expectedVersion: number;

  constructor(aggregateId: string, expectedVersion: number);
}

/** EventStore.append の入力制約違反 */
export declare class EventLimitError extends Error {
  readonly name: "EventLimitError";
  readonly aggregateId: string;

  constructor(aggregateId: string, message: string);
}

/**
 * rehydrate の入力イベント列が不正。
 *
 * - aggregateId_mismatch: events[i].aggregateId !== rehydrate(id, ...) の id
 * - non_monotonic_version: version が増加していない
 * - version_gap: version が 1 ずつ増えていない
 * - invalid_initial_version: 最初のイベントの version が 1 でない
 * - missing_evolve_handler: event.type に対応する evolve がない
 */
export type InvalidEventStreamReason =
  | "aggregateId_mismatch"
  | "non_monotonic_version"
  | "version_gap"
  | "invalid_initial_version"
  | "missing_evolve_handler";

/** InvalidEventStreamError の追加診断情報 */
export interface InvalidEventStreamDetails {
  readonly eventIndex?: number;
  readonly expectedAggregateId?: string;
  readonly actualAggregateId?: string;
  readonly expectedVersion?: number;
  readonly actualVersion?: number;
  readonly eventType?: string;
}

export declare class InvalidEventStreamError extends Error {
  readonly name: "InvalidEventStreamError";
  readonly aggregateId: string;
  readonly reason: InvalidEventStreamReason;
  readonly details?: InvalidEventStreamDetails;

  constructor(
    aggregateId: string,
    reason: InvalidEventStreamReason,
    message: string,
    details?: InvalidEventStreamDetails,
  );
}
```

その他の DynamoDB / AWS SDK 起因のエラーはラップせず、そのまま伝播する。

### 5.6 Functions

```typescript
/**
 * イベントリプレイで Aggregate の状態を再構築する。
 *
 * Preconditions:
 * - events が空でない場合、events[0].version === 1 であること
 * - events は version 昇順・連番であること
 * - 全 events の aggregateId === id であること
 * - 全 events.type に対応する evolve ハンドラが config.evolve に存在すること
 * - 上記を満たさない場合は InvalidEventStreamError を throw する
 *
 * Behavior:
 * - initialState は structuredClone で複製される（TState は structured-cloneable であること）
 * - 空のイベント配列に対しては initialState + version=0 を返す
 * - InvalidEventStreamError.details には不正箇所の index / expected / actual を格納できる
 */
export declare function rehydrate<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
  id: string,
  events: ReadonlyArray<StoredEventsOf<TMap>>,
): Aggregate<TState>;

/**
 * Aggregate ライフサイクルの完全な実行:
 * Load → Rehydrate → Decide → Append。
 * ConcurrencyError 時は Load から全体をやり直す。
 *
 * No-op behavior:
 * - handler が空配列を返した場合、append は呼ばれない
 * - 返り値の aggregate は現在の状態そのまま、newEvents は空配列
 * - no-op は成功として扱い、version は進まない
 *
 * Retry Model:
 * - 初回実行は必ず 1 回行う
 * - maxRetries は「追加の再試行回数」。maxRetries = 0 は再試行なし
 * - append 試行回数の上限は 1 + maxRetries
 *
 * @param params.config - Aggregate の定義
 * @param params.store - EventStore 実装
 * @param params.handler - Command Handler（同期の純粋関数）
 * @param params.aggregateId - 対象の Aggregate ID
 * @param params.input - Command の入力
 * @param params.maxRetries - 追加の最大再試行回数（デフォルト: 3。非負整数）
 * @param params.correlationId - オプション: 相関 ID
 *
 * @throws RangeError - maxRetries が非負整数でない場合（負数、小数、NaN、Infinity を含む）。Load 前に throw
 * @throws ConcurrencyError - 1 + maxRetries 回の append 試行でも競合が解消しない場合（最後の ConcurrencyError をそのまま throw）
 * @throws InvalidEventStreamError - store.load が返したイベント列が version / aggregateId / evolve 契約を満たさない場合
 * @throws handler が throw したエラーはそのまま伝播（再試行しない）
 */
export declare function executeCommand<
  TState,
  TMap extends EventMap,
  TInput,
>(params: {
  config: AggregateConfig<TState, TMap>;
  store: EventStore<TMap>;
  handler: CommandHandler<TState, TMap, TInput>;
  aggregateId: string;
  input: TInput;
  maxRetries?: number;
  correlationId?: string;
}): Promise<{
  aggregate: Aggregate<TState>;
  newEvents: ReadonlyArray<StoredEventsOf<TMap>>;
}>;
```

### 5.7 Projection Bridge

Write 側（Event Store）と Read 側（Projection）を繋ぐ最小ヘルパー。
DynamoDB Stream Record を StoredEvent 構造に復元する。
責務は「Projection が読むべきレコードを正規化し、受理する type だけ runtime で絞る」までであり、
payload の schema 検証や Read Model 永続化までは踏み込まない。

```typescript
/**
 * DynamoDB Streams の Record から StoredEvent を抽出する。
 *
 * - eventName === "INSERT" のレコードのみ対象。MODIFY / REMOVE は null を返す
 * - StreamViewType は NEW_IMAGE を前提とする。NewImage が無い場合は InvalidStreamRecordError(reason="missing_field")
 * - type は eventNames に含まれるか runtime で検証する
 *   - デフォルトは strict。未知の type は InvalidStreamRecordError を throw（イベント消失を防ぐ）
 *   - ignoreUnknownTypes: true の場合は null を返す（複数 Aggregate 共有テーブル用）
 * - data は unknown として返す（runtime の型検証はライブラリのスコープ外）
 * - DynamoDB のマーシャリングを解除する
 *
 * @param record - DynamoDB Stream Record（@types/aws-lambda への依存を避けるため unknown）
 * @param eventNames - 受け入れるイベント型名の配列。runtime で type を検証する
 * @param options - オプション設定
 * @returns INSERT かつ既知の type の場合は StoredEvent。MODIFY/REMOVE は null。ignoreUnknownTypes 時の未知 type も null
 * @throws InvalidStreamRecordError - INSERT だが形式不正、または未知の type（strict モード時）
 */
export declare function parseStreamRecord<
  TMap extends EventMap,
  TEventName extends keyof TMap & string = keyof TMap & string,
>(
  record: unknown,
  eventNames: ReadonlyArray<TEventName>,
  options?: ParseStreamRecordOptions,
): StoredEvent<TEventName, unknown> | null;

/** parseStreamRecord のオプション */
export interface ParseStreamRecordOptions {
  /** true の場合、eventNames に含まれない type は null を返す。デフォルト false（throw） */
  readonly ignoreUnknownTypes?: boolean;
}

/** `InvalidStreamRecordError.reason` の違反種別 */
export type InvalidStreamRecordReason = "missing_field" | "unmarshal_failed" | "unknown_type";

/** INSERT レコードだが StoredEvent として不正、または未知の type */
export declare class InvalidStreamRecordError extends Error {
  readonly name: "InvalidStreamRecordError";
  readonly reason: InvalidStreamRecordReason;
  /** 問題のあったフィールド名や未知の type 値など、デバッグ用の診断情報 */
  readonly detail?: string;
  constructor(
    reason: InvalidStreamRecordReason,
    message: string,
    detail?: string,
  );
}

/**
 * AggregateConfig から event 名の配列を型安全に取得する。
 * Object.keys(config.evolve) の型安全なラッパー。キャスト不要。
 */
export declare function eventNamesOf<TState, TMap extends EventMap>(
  config: AggregateConfig<TState, TMap>,
): ReadonlyArray<keyof TMap & string>;
```

概念上の返り値は `StoredEvent<keyof TMap, unknown> | null` だが、TypeScript 上は
`StoredEvent` の `type` が string であることを明示するため `keyof TMap & string` を使う。

利用者の Projection Lambda での推奨パターン:

```typescript
import { parseStreamRecord, eventNamesOf } from "@seike460/minamo";
import type { DynamoDBStreamEvent } from "aws-lambda";
import type { OrderEvents } from "./domain/order.js";
import { orderConfig } from "./domain/order.js";

// Write 側の config から event 名を取得（DRY、キャスト不要）
const orderEventNames = eventNamesOf(orderConfig);

function isOrderPlaced(data: unknown): data is OrderEvents["OrderPlaced"] {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate.orderId === "string" &&
    typeof candidate.customerId === "string"
  );
}

export const handler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    const storedEvent = parseStreamRecord<OrderEvents>(record, orderEventNames);
    if (!storedEvent) continue;

    // storedEvent.type は "OrderPlaced" | "OrderShipped"（runtime 検証済み）
    // この projector が処理したい event だけを明示的に拾う
    if (storedEvent.type !== "OrderPlaced") continue;

    // storedEvent.data は unknown のまま返るので、Projection 側で narrow する
    if (!isOrderPlaced(storedEvent.data)) {
      throw new Error("Invalid OrderPlaced payload");
    }
    await updateCustomerOrders(
      storedEvent.data.customerId,
      storedEvent.data.orderId,
    );
  }
};
```

> **デフォルト strict:** 未知の type は `InvalidStreamRecordError` を throw する。Write 側が新イベントを追加した場合に Projector の未対応を即座に検出できる。`{ ignoreUnknownTypes: true }` は複数 Aggregate が同一テーブルを共有する場合の opt-in であり、通常の単一 Aggregate projector のバージョンずれを握りつぶす用途には使わない。
>
> **poison pill への対処:** strict モードでは、壊れたレコードや未知 type が1件でもあると Lambda がエラーを返し、DynamoDB Streams のリトライが発生する。これにより後続の正常なレコードもブロックされる（poison pill）。運用上は Lambda の Event Source Mapping で `BisectBatchOnFunctionError: true` と `MaximumRetryAttempts` を設定し、問題のあるレコードを OnFailure destination（SQS / SNS）に送る構成を推奨する。`ReportBatchItemFailures` を併用すると、バッチ内の正常レコードは処理済みとして報告でき、poison pill の影響範囲を最小化できる。
>
> **shared table の前提:** 複数 Aggregate が同一 DynamoDB テーブル（= 同一 Stream）を共有する場合、`parseStreamRecord` は `eventNames` に基づく type フィルタリングのみで振り分ける。aggregateId による routing は行わない。型名の衝突を避けるために Aggregate 名のプレフィックス付与（例: `"Order.Placed"`）を推奨するが、強制はしない。高度な routing が必要な場合は利用者が独自のフィルタロジックを実装する。
>
> **data は unknown:** `data` の shape は runtime では検証しない。同一アプリが自分で書いたイベントを読む前提では、evolve が正しく処理できるなら data も正しい。schema 進化、外部 producer、長期保存データが関わる場合は、Projection 境界で type guard や validator を入れて narrow する。
>
> **DRY な eventNames 取得:** `eventNamesOf(config)` で Write 側の config から型安全に event 名を取得する。手書き配列やキャストは不要。
>
> **責務境界:** `parseStreamRecord` は 1 レコードの正規化だけを担う。バッチ反復、順序前提の扱い、重複排除、`ReportBatchItemFailures` を使った partial batch failure 応答は利用者の Lambda ハンドラ側で実装する。
>
> **冪等性の推奨:** Projection の冪等キーとして `aggregateId + version` を使う。DynamoDB Streams の at-least-once delivery で重複配信された場合に検出できる。

### 5.8 Implementations

```typescript
/**
 * Amazon DynamoDB Event Store の設定。
 *
 * Client resolution priority:
 * 1. config.client
 * 2. config.clientConfig から生成した client
 * 3. AWS SDK のデフォルト設定から生成した client
 */
export interface DynamoEventStoreConfig {
  /** DynamoDB テーブル名 */
  readonly tableName: string;
  /** DynamoDB client config（カスタムエンドポイント等）。client 未指定時に使用 */
  readonly clientConfig?: DynamoDBClientConfig;
  /** DynamoDB Document Client（テスト用 DI）。指定時は clientConfig より優先 */
  readonly client?: DynamoDBDocumentClient;
}

/**
 * Amazon DynamoDB を使った EventStore 実装。
 *
 * - append: TransactWriteCommand でアトミック書き込み + ConditionCheck でギャップ検出
 * - load: ConsistentRead: true + LastEvaluatedKey ページネーション（fresh read 保証）
 *
 * DynamoDB 固有の制約:
 * - 1 回の append で最大 99 件（TransactWriteItems 100 操作上限 - ConditionCheck 1 件）
 * - 各イベントのシリアライズ後サイズが 400KB 以下（DynamoDB アイテムサイズ上限）
 * - 全イベントの合計サイズが 4MB 以下（DynamoDB トランザクション上限）
 * - 上記を超過した場合は EventLimitError を throw
 * - その他の DynamoDB エラー（ThrottlingException 等）は AWS SDK のエラーがそのまま伝播
 *
 * テーブルスキーマ:
 *   PK (string): aggregateId
 *   SK (number): version
 */
export declare class DynamoEventStore<TMap extends EventMap> implements EventStore<TMap> {
  constructor(config: DynamoEventStoreConfig);
  append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
  load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
}

/**
 * テスト用 EventStore 実装。
 *
 * DynamoEventStore と同じ汎用制約を実装する:
 * - バージョン検証、ギャップ検出、ConcurrencyError 発火条件
 * - 空配列チェック（EventLimitError）
 * - fresh read 保証（同期的にメモリから読むため、直前の append 結果を確実に観測できる）
 * - DynamoDB 固有のサイズ制約（400KB/4MB）はチェックしない
 *
 * Contract Tests で両実装の振る舞い一致を保証する。
 */
export declare class InMemoryEventStore<TMap extends EventMap> implements EventStore<TMap> {
  append(
    aggregateId: string,
    events: ReadonlyArray<EventsOf<TMap>>,
    expectedVersion: number,
    options?: AppendOptions,
  ): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
  load(aggregateId: string): Promise<ReadonlyArray<StoredEventsOf<TMap>>>;
  /** 全ストリームの全イベントを取得（テスト用） */
  allEvents(): ReadonlyArray<StoredEventsOf<TMap>>;
  /** 全ストリームをクリア（テスト用） */
  clear(): void;
}
```

### 5.9 Optional: Input Validation (Standard Schema v1)

CommandHandler (§5.3) は同期・決定的・副作用なしで、非決定的要素は `input` に注入する（DEC-005 / DEC-010）。この帰結として、runtime validation は `executeCommand` の外（境界）で行い、検証済みの値を handler に渡す設計になる。minamo は validator 実装（Zod / Valibot / ArkType 等）に依存せず、Standard Schema v1 interface のみを型として受け取る `validate` helper を提供する（DEC-015）。

> Standard Schema v1 は Zod v3.24+ / Valibot v1 / ArkType v2 等が実装する validator の共通仕様。spec: https://standardschema.dev

```typescript
/** Standard Schema v1 interface (vendor-neutral validator 契約) */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaProps<Input, Output>;
}

export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  readonly types?: StandardSchemaTypes<Input, Output>;
}

export type StandardSchemaResult<Output> =
  | StandardSchemaSuccess<Output>
  | StandardSchemaFailure;

export interface StandardSchemaSuccess<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

export interface StandardSchemaFailure {
  readonly issues: readonly StandardSchemaIssue[];
}

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | StandardSchemaPathSegment)[];
}

export interface StandardSchemaPathSegment {
  readonly key: PropertyKey;
}

export interface StandardSchemaTypes<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}

/** Schema から Input / Output 型を抽出するユーティリティ (spec 準拠: types accessor) */
export type InferSchemaInput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["input"];

export type InferSchemaOutput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["output"];

/**
 * Standard Schema で value を validate し、成功時は Output を返す。失敗時は ValidationError を throw する。
 * 同期 / 非同期のどちらの validate 実装にも対応する（Promise.resolve で正規化）。
 */
export declare function validate<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): Promise<InferSchemaOutput<Schema>>;

/** Standard Schema による validation 失敗時のエラー */
export declare class ValidationError extends Error {
  readonly name: "ValidationError";
  readonly issues: readonly StandardSchemaIssue[];

  constructor(issues: readonly StandardSchemaIssue[]);
}
```

使い方（consumer 側が選択した validator で schema を定義し、境界で validate する）:

```typescript
import {
  type CommandHandler,
  type InferSchemaOutput,
  executeCommand,
  validate,
} from "@seike460/minamo";

// 例: Zod v3.24+ / Valibot v1 / ArkType v2 等、Standard Schema v1 対応 validator で定義
declare const incrementInputSchema: StandardSchemaV1<
  { amount: unknown },
  { amount: number }
>;

type IncrementInput = InferSchemaOutput<typeof incrementInputSchema>;

const handler: CommandHandler<number, CounterEvents, IncrementInput> = (
  agg,
  input,
) => {
  if (input.amount === 0) return [];
  return [{ type: "Incremented", data: { amount: input.amount } }];
};

// 境界で validate。成功すれば CommandHandler へ、失敗なら ValidationError
const input = await validate(incrementInputSchema, rawInput);
await executeCommand({ config, store, handler, aggregateId, input });
```

設計意図:

- **境界での検証に限定**: `validate` は `executeCommand` の外で呼ぶ。handler は再試行で複数回呼ばれうるが（§5.6）、input は既に型化・検証済みの plain data として注入される（DEC-010 と整合）
- **validator 実装非依存**: Standard Schema v1 interface のみを受け取る。minamo は Zod / Valibot / ArkType に依存せず、peerDependencies を増やさない
- **Non-Goals との整合**: projection payload の schema 検証を consumer 責務と定義した原理（§6 / DEC-013）を、CommandHandler 入力 validation にも適用する。minamo が提供するのは schema を "受け取る" 接点のみ

---

## 6. Non-Goals

### 永久スコープ外

以下は minamo が提供しない。理由を明記する。

| 項目 | 理由 |
|------|------|
| **Read Model の永続化・管理** | Read Model の設計はアクセスパターンに依存し、利用者のビジネスロジックそのもの。minamo は `parseStreamRecord` で Write → Read の橋渡しのみ提供し、Read Model の構築と永続化は利用者に委ねる |
| **Projection payload のスキーマ検証** | `parseStreamRecord` は `data` を `unknown` として返し、payload shape の runtime 検証は行わない。外部 producer、長期保存データ、schema 進化が関わる場合の validator 選定は利用者の責務 |
| **共有 Stream 内での event type 衝突回避** | `eventNames` によるフィルタリングは同一 Stream で type 名が衝突しないことを前提とする。ライブラリが registry や命名規約を強制すると設計自由度を損なうため、命名規約の採用は利用者に委ねる |
| **Saga / Process Manager** | AWS Step Functions がこの役割を直接担う。minamo がラッパーを提供する価値は低い。DEC-003 参照 |
| **CDK Construct** | AWS CDK をそのまま使う。テーブル定義の CDK サンプルはドキュメントで提供する |
| **EventBridge Publisher** | 「AWS のプリミティブをラップしない」原則に基づく。EventBridge への publish は DynamoDB Streams → Lambda → EventBridge で利用者が構成する |
| **Event Source Mapping / OnFailure destination / retry 設定の抽象化** | poison pill 対策、`BisectBatchOnFunctionError`、`MaximumRetryAttempts`、`ReportBatchItemFailures`、OnFailure destination の設計はインフラと運用ポリシーの責務。minamo は Lambda イベントソース設定をラップしない |
| **高度な event routing** | `parseStreamRecord` は type 名によるフィルタリングのみ提供する。aggregateId による振り分け、複数 Aggregate の合流、discriminator ベースの routing は利用者の責務。minamo は stream record の正規化までを担い、どの projector が処理すべきかの判定ロジックは提供しない |
| **複数 DB 対応** | minamo の本番 EventStore 実装は DynamoEventStore のみ。他の DB への移植性は目標としない。EventStore interface は汎用だが、これはテスト用 InMemoryEventStore との契約一致が目的であり、DB ポータビリティのためではない |

### 将来検討（v1 スコープ外）

以下は v1 には含めないが、将来のバージョンで検討する可能性がある。

| 項目 | 検討条件 |
|------|---------|
| **Projection handler ヘルパー** | `parseStreamRecord` とバッチ反復、`ReportBatchItemFailures` 応答の定型化に需要が確認された場合。ただし Event Source Mapping 設定や DLQ 方針までは抽象化しない |
| **Snapshot** | Aggregate のイベント数が 1,000 を超えるユースケースが確認された場合。実測データに基づいて判断 |
| **イベントスキーマ進化（upcasting）** | minamo 自体の API が安定した後（v1.0.0 以降）に検討 |

### API Ergonomics（バックログ）

Non-Goals ではなく、API の利便性改善として将来追加を検討するもの。

- `defineAggregate` — EventMap を evolve から推論する型ヘルパー
- `createCommandExecutor` — config + store をバインドするファクトリー

---

## 11. Decisions

### DEC-001: Target User は人数ではなく課題構造で定義する

- **指摘元:** Copilot レビュー（セクション 2）
- **指摘:** 小規模チーム（1〜5人）等のチーム規模を明記すると採用判断がしやすくなる
- **判断:** 記載しない。Target User は人数ではなく課題構造と前提環境で定義する
- **理由:** minamo の適合性を決める一次判定軸は、書き込み競合、監査証跡の必要性、複数の Read Model の要否といった問題構造である。DynamoDB + Lambda は適用前提であり、人数の代替指標ではない。Target User には人数レンジではなく、解決したい問題、要求される運用特性、前提スタックを書く。因果が弱い属性は Target User に置かない。2 人のチームでも高競合・監査要件があれば適合しうる一方、10 人チームでも単純 CRUD なら不要であり、人数レンジは誤った自己除外・自己包含を招く
- **棄却した代替案:** 「1〜5 人に特に適する」と参考情報として併記する案も検討したが、読者は参考情報を実質的な対象条件として読むため、誤ったセグメンテーションを強化する。人数とフィット度の因果が弱い以上、Target User には置かない

### DEC-002: CQRS+ES の事前経験は不要。DynamoDB + Lambda + 結果整合性の基本理解は前提とする

- **指摘元:** Copilot レビュー（セクション 2）、Codex レビュー（セクション 2）
- **指摘:** CQRS+ES の事前知識レベルを定義すべき
- **判断:** CQRS+ES の事前経験は不要とするが、DynamoDB + Lambda + 結果整合性の基本理解は前提とする
- **理由:** minamo は CQRS+ES の概念を教えるツールではなく、正しく実装するツール。DynamoDB の基本概念（PK/SK、GSI、ConditionExpression）、Lambda の実行モデル（ステートレス、同時実行）、結果整合性の理解（Read Model が即座に最新とは限らないこと、Streams による非同期伝播）がないと、セクション 1 の痛み（楽観的ロック、リトライ、テスト乖離）自体がピンとこない。CQRS+ES の知識は minamo の型定義とドキュメントから習得できる設計を目指すが、AWS の基本は外部の前提知識として求める
- **棄却した代替案:** (a)「CQRS+ES の事前経験も前提とする」→ 採用障壁が上がりすぎ、ターゲットを不要に狭める (b)「前提知識なしで使えることを目指す」→ CQRS+ES の教育コンテンツまで担うとドキュメント負担が爆発し、1 人メンテに非現実的

### DEC-003: Cross-Aggregate 整合性は minamo のスコープ外

- **指摘元:** Codex レビュー（セクション 3）
- **指摘:** 「Cross-Aggregate トランザクションは不可」が技術制約として断定しすぎ。DynamoDB の TransactWriteItems は複数アイテムを跨げる
- **判断:** Constraints セクションから削除し、Decision として記録。minamo のスコープ外とする。ただしスコープ外は「Cross-Aggregate の抽象化を提供しない」であり、「Cross-Aggregate 整合性そのものを否定する」ではない
- **理由:** 技術的に不可能だからではなく、API の責務境界として外す。DynamoDB の TransactWriteItems で複数 Aggregate を跨ぐアトミック操作は可能であり、利用者が minamo の外で生の TransactWriteItems を使うことは妨げない。ただし minamo は単一 Aggregate のライフサイクル（Load → Decide → Append）に責務を限定する。Cross-Aggregate の結果整合性が必要な場合は Saga パターン（AWS Step Functions 等）で補償する設計が一般的だが、具体的な補償パターンの選定は利用者の責務であり minamo のドキュメントスコープ外とする
- **棄却した代替案:** minamo 内で TransactWriteItems を使い複数 Aggregate をアトミックに操作する API を提供する案を検討したが、API の複雑化、単一テーブル設計の強制、1 人メンテの保守コストを考慮し採用しない

### DEC-004: AggregateConfig.name を削除

- **指摘元:** API 設計レビュー（セクション 5.2）
- **指摘:** Aggregate 定義に `name` を持たせて PK プレフィックスや型識別に使うべきではないか
- **判断:** `AggregateConfig` から `name` プロパティを削除した。aggregateId の構成は利用者が決める
- **理由:** `name` がないことで PK 設計の自由度が保たれ、不要な抽象化を排除する。Aggregate 名と aggregateId のマッピングはアプリケーション固有の関心事であり、ライブラリが強制するものではない。利用者は `executeCommand` の `aggregateId` 引数に任意の文字列を渡せる。なお、同一テーブルで複数 Aggregate を運用する場合、aggregateId の全体一意性が必須である。衝突すると別 Aggregate のイベントが混入し、誤った状態復元や runtime failure が発生する。衝突回避は利用者の aggregateId 命名規約で担う
- **棄却した代替案:** `name` を残して PK プレフィックス（`{name}#{aggregateId}`）を自動生成する案を検討したが、PK の命名規約はテーブル設計全体の関心事であり、minamo が一部だけを制御すると利用者の設計自由度を損なう

### DEC-005: CommandHandler は決定的・副作用なし・再試行安全

- **指摘元:** API 設計レビュー（セクション 5.3）
- **判断:** `CommandHandler` の戻り値を `CommandResult<TMap>`（同期）とし、`Promise` を型レベルで排除する。handler は決定的（deterministic）・副作用なし（side-effect-free）・再試行安全（retry-safe）であること
- **理由:** `executeCommand` の再試行で handler は複数回呼ばれうる。`Promise` を型で排除することで、戻り値が非同期でないことを型レベルで保証する。ただし型で保証できるのは non-Promise return まで。fire-and-forget の非同期呼び出し、同期 I/O（`fs.readFileSync`）、グローバル状態の参照・変更、環境変数への依存は型では検出できず、純粋性・決定性・retry-safe は規約・コードレビュー・テストで担保する。`Date.now()` や `Math.random()` も決定性を壊すため、時刻・UUID・外部データは `input` 経由で注入する（DEC-010 参照）。retry-safe の定義: 同じ `aggregate` と `input` に対して同じイベント列または同じ例外を返すこと。非同期バリデーションが必要な場合は `executeCommand` の外で行い、結果を `input` に含める
- **棄却した代替案:** (a) `AsyncCommandHandler`（`Promise<CommandResult>`）を別途提供する案 → 非同期を許可すると handler 内で外部 API を呼ぶ誘惑が生まれ、再試行時の冪等性担保が利用者責任になる。API を分けるとどちらを使うべきかの判断コストが増える (b) `Promise<CommandResult>` を許可して副作用回避は利用者責任とする案 → 型による安全性が minamo の価値なのに、最も重要な handler の純粋性を型で支えないのは矛盾する

### DEC-006: EventStore interface を汎用に保つ

- **指摘元:** Copilot レビュー（セクション 5 ラウンド 3）
- **指摘:** EventStore interface に DynamoDB 固有制約（99件/400KB/4MB）が混在している
- **判断:** EventStore interface からサイズ制約を除去し、DynamoEventStore の JSDoc に移動
- **理由:** EventStore interface の汎用性は、InMemoryEventStore との Contract Tests で振る舞い一致を保証するためにある。複数 DB ポータビリティのためではない（複数 DB 対応は永久スコープ外）。InMemoryEventStore が DynamoDB 固有のサイズ制約を無視しても、Contract Tests で検証する公開契約（バージョン検証、ギャップ検出、ConcurrencyError 発火条件）は一致する。DynamoDB 固有制約は DynamoEventStore 実装の責務

### DEC-007: Version Model と maxRetries の数え方を明示する

- **指摘元:** API Review（セクション 5 ラウンド 4）
- **指摘:** `version=0/1` の意味と `maxRetries` の off-by-one が曖昧
- **判断:** 空ストリームの `Aggregate.version` は 0、永続化済みイベントの `StoredEvent.version` は 1 始まり、`maxRetries` は「追加の再試行回数」と定義する
- **理由:** version の意味が曖昧だと append / rehydrate / テスト実装がずれる。`version=0` はイベント未発行の初期状態であり、最初の append 成功後に `version=1` になる。retry の数え方が曖昧だと利用者が再試行回数を誤設定する。`maxRetries=3` のとき試行は `[初回, retry1, retry2, retry3]` の計 4 回。再試行対象は `ConcurrencyError` **のみ**。DynamoDB の `ProvisionedThroughputExceededException` 等のインフラエラーや handler が throw した例外は再試行せず呼び出し元に伝播する。v1 は即時リトライ（backoff/jitter なし。詳細は DEC-012）
- **棄却した代替案:** (a) version の初期値を `undefined`（未ロード状態と空ストリームを区別）とする案 → 全ての version 参照箇所で null check が必要になり、API の複雑性が増す。`version=0` は「0 件のイベントが存在する」を自然に表現する (b) パラメータ名を `maxAttempts`（総試行回数）にする案 → AWS SDK の慣例（`maxAttempts`）に近いが、「初回試行 + 追加のリトライ」という ES の retry セマンティクスでは `maxRetries` の方が意図を正確に表現する (c) branded type（`Version`, `NonNegativeInt`, `RetryCount`）で非負整数制約を型レベルで表現する案 → branded type はパース関数と組み合わせて使う必要があり、利用者が `expectedVersion` や `maxRetries` を渡すたびにファクトリ関数を経由する API になる。学習コストと利便性のバランスが悪く、境界で runtime 検証する方がシンプル

### DEC-008: 公開 API は immutable view（compile-time）と構造化エラー情報を持つ

- **指摘元:** API Review（セクション 5 ラウンド 4）
- **指摘:** `Evolver` の immutability が規約だけで弱く、`InvalidEventStreamError` の診断情報が不足している
- **判断:** `Evolver` に渡す `state` / `data`、`Aggregate.state` を `ReadonlyDeep` で公開し、`InvalidEventStreamError.details` で expected / actual / eventIndex を返せるようにする。`StoredEvent.data` と `executeCommand` の `newEvents` は `readonly` だが `ReadonlyDeep` は適用しない（利用者が Projection 側で data を自由に narrow / 加工する用途を妨げないため）
- **理由:** `ReadonlyDeep` は minamo が自前で定義する再帰型エイリアスであり（外部依存なし）、compile-time の型制約として機能する。runtime の `Object.freeze` ではない。利用者が故意に型キャストすれば mutation は可能だが、通常の開発フローではコンパイラが破壊的変更を検出する。`InvalidEventStreamError` は構造化された診断情報（`details`: `InvalidEventStreamDetails` 型。セクション 5.5 で定義）を持ち、壊れたイベントストリームの原因を利用者が即座に特定できるようにする
- **棄却した代替案:** runtime で `Object.freeze` / `Object.deepFreeze` を適用する案を検討したが、deep freeze の再帰コスト（特にイベント数が多い Aggregate の rehydrate 時）がパフォーマンスに影響する。`ReadonlyDeep` と TypeScript の strict mode で compile-time に検出する方が、minamo のユースケースでは十分と判断した

### DEC-009: イベント命名ポリシー — Aggregate 名プレフィックス推奨

- **判断:** 複数 Aggregate が同一 DynamoDB テーブル（= 同一 Stream）を共有する構成では、イベント type 名に Aggregate 名のプレフィックスを付与することを推奨する（例: `"Order.Placed"`、`"Inventory.Reserved"`）。ライブラリは命名規約を強制しない。単一 Aggregate per テーブルではプレフィックスは不要だが、付与しても害はない
- **理由:** `parseStreamRecord` は `eventNames` による type フィルタリングで振り分ける。同一 Stream で type 名が衝突すると、意図しない Projector がイベントを受理する誤 routing が発生する。ライブラリが registry や namespace を持つと設計自由度を損なうため、命名規約の採用は利用者に委ねる。「設計の邪魔をしない」原則（セクション 4）に基づく
- **棄却した代替案:** (a) ライブラリが namespace registry を提供して type 名の一意性を保証する案 → グローバル状態を持つことになり、テスト・並行起動で問題が生じる (b) 区切り文字（`.` vs `:` vs `/`）を規約化する案 → 利用者のドメイン命名規約と衝突するリスクがあり、強制する根拠が弱い

### DEC-010: 決定性境界 — 非決定的要素は input に注入する

- **判断:** `CommandHandler` は `aggregate` と `input` から決定的にイベントを生成する。時刻（`new Date()`）、UUID（`crypto.randomUUID()`）等の非決定的要素は `executeCommand` の呼び出し元で生成し、`input` 経由で注入する
- **理由:** `executeCommand` の再試行で handler は複数回呼ばれうる。非決定的要素が handler 内にあると、再試行ごとに異なるイベント（異なるタイムスタンプ、異なる ID）が生成され、テストも非決定的になる。input 注入により handler のテストは `aggregate` + `input` のペアだけで完結し、再試行時にも同じ入力から同じイベントが生成される。DEC-005 が「Promise を型で排除」する型制約であるのに対し、DEC-010 は「非決定的要素を input に追い出す」設計規約であり、相互に補完する
- **棄却した代替案:** (a) `executeCommand` に `context: { now: Date; id: string }` パラメータを追加し、ライブラリ側で非決定的要素を管理する案 → どの非決定的要素が必要かは handler ごとに異なり、汎用的な context 型は過剰な抽象化になる (b) handler に clock / random を DI する案 → handler のシグネチャが複雑化し、大半のケースで不要な引数を強制する。input に注入する方がシンプルで TypeScript の型推論とも自然に統合する

### DEC-011: シリアライゼーション契約 — structured-cloneable かつ DynamoDB marshallable

- **指摘元:** API Review（セクション 5、DEC-008 の immutability 議論から派生）
- **指摘:** イベント payload と Aggregate state のシリアライゼーション制約が未定義。DynamoDB marshalling と structuredClone の両立条件を明示すべき
- **判断:** `TState`（Aggregate の状態）と `TData`（イベントの payload）は structured-cloneable かつ DynamoDB marshallable な plain data に限定する
- **理由:** `rehydrate` は `structuredClone(initialState)` で初期状態を複製する。`DynamoEventStore` はイベントを DynamoDB に永続化する。技術的には DynamoDB Document Client は Set / Binary 等も扱えるが、minamo は JSON-like な plain data に意図的に制限する。理由は (1) structured clone と DynamoDB marshalling の両方で round-trip が保証される安全な交点であること、(2) イベントの可搬性・可読性・デバッグ容易性を重視すること
  - **許可:** object, array, string, number（有限値のみ）, boolean, null
  - **禁止（技術的制約）:** Function, Symbol, DOM Node（structured clone 不可）、`NaN` / `Infinity` / `-Infinity`（DynamoDB が格納不可）
  - **禁止（設計方針）:** Date（ISO 8601 文字列で表現）, Map（plain object で表現）, Set（配列で表現）, BigInt, Buffer, class instance — DynamoDB Document Client は一部を扱えるが、plain data に統一することで round-trip の安全性と可搬性を保つ
  - **禁止（追加）:** 値としての `undefined`（オブジェクトプロパティ値・配列要素ともに禁止）。`structuredClone` では `undefined` が保持されるが、DynamoDB Document Client の marshall ではデフォルトで marshal error になるか、`removeUndefinedValues: true` 設定時はプロパティごとスキップされる。いずれの場合も round-trip が成立せず data loss を起こす
  - DEC-010 で `input` に注入した値（時刻、UUID 等）も、イベントの `data` や Aggregate の `state` に含まれる時点でこの plain data 制約に従う
  - TypeScript の型レベルではこの制約を完全には強制できないが、`ReadonlyDeep<TState>` で immutability を示唆し、ドキュメントで plain data の制約を明示する
- **棄却した代替案:** (a) `PlainData<T>` conditional type で Function / Symbol / Date 等を型レベルで排除する案 → 再帰型のコンパイル性能コストが高く、深いネストでの TypeScript の型推論が不安定になる (b) runtime validation（`assertPlainData` 関数）を `append` の境界で実行する案 → runtime オーバーヘッドが発生し、「DynamoDB API 呼び出し以外のオーバーヘッドを加えない」原則（セクション 4）に反する

> **Fact:** structured clone algorithm の仕様。
> Source: https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal (checked: 2026-04-12)

### DEC-012: v1 リトライポリシー — 即時リトライ、backoff/jitter なし

- **判断:** `executeCommand` の `ConcurrencyError` リトライは即時リトライとする。exponential backoff / jitter は v1 では提供しない
- **理由:** DynamoDB の楽観的ロック失敗は「同一 Aggregate への並行書き込み」である。即時リトライは競合を再同期させ増幅するリスクがあるが、v1 では `ConcurrencyError` 限定・少回数（デフォルト `maxRetries=3`）に絞っているため、増幅が問題になる前に試行上限に達する。**Assumption:** 典型的な ES ワークロードでは 2-3 回の即時リトライで競合は解消する（未検証。v1 リリース後の実運用データで検証予定）。高競合が持続する場合は backoff で隠すのではなく、Aggregate 境界の見直しやコマンドの粒度調整を推奨する。将来のバージョンで backoff strategy を `executeCommand` のオプションとして追加する余地は残す（`retryStrategy?: (attempt: number) => Promise<void>` 等）が、v1 はシンプルに保つ。なお `retryStrategy` は handler ではなく `executeCommand` のインフラ層オプションであり、DEC-005 の「handler は同期」原則とは直交する（sleep のために async が自然なのはインフラ層の関心事）
- **棄却した代替案:** (a) v1 から exponential backoff + jitter を提供する案 → YAGNI。典型的な ES ワークロードでは即時リトライで十分であり、backoff の設計（初期間隔、最大間隔、jitter アルゴリズム）が API 表面積を増やす (b) AWS SDK の retry 設定に委ねる案 → SDK の retry は throttling（`ProvisionedThroughputExceededException`）向けであり、minamo の楽観的ロック（`ConcurrencyError`）とは直交する。混同を避けるため minamo は自前の retry を持つ

### DEC-013: Projection Bridge の原則 — strict-by-default、type-only routing

- **判断:** `parseStreamRecord` のデフォルトは strict（未知 type で `InvalidStreamRecordError` を throw）。routing は type 名のみで行い、aggregateId による振り分けはしない。poison pill は Lambda Event Source Mapping の `BisectBatchOnFunctionError` + `MaximumRetryAttempts` + OnFailure destination で対処し、`ReportBatchItemFailures` による partial batch failure 応答と組み合わせる。`data` は `unknown` として返し、payload の runtime 検証はライブラリのスコープ外とする
- **理由:** strict-by-default は Write 側で新イベントを追加した際に Projector の未対応を即座に検出するための安全策。silent drop（`ignoreUnknownTypes: true`）は複数 Aggregate 共有テーブル用の opt-in であり、単一 Aggregate projector のバージョンずれを握りつぶす用途には使わない。type-only routing はシンプルで理解しやすく、minamo の責務境界（stream record の正規化まで）に合致する。poison pill 対策は Event Source Mapping のインフラ設定の責務であり、minamo がラップする価値はない。`data` を `unknown` で返すのは、payload の schema 検証は validator / type guard の選定を含めて利用者の責務だからであり、minamo が特定の検証ライブラリに依存することを避ける
- **棄却した代替案:** (a) aggregateId ベースの routing を提供する案 → aggregateId の命名規約はアプリケーション固有であり（DEC-004）、ライブラリが parsing ロジックを持つと利用者の PK 設計を制約する (b) `data` に型検証を含める案 → schema 検証ライブラリ（zod, valibot 等）への依存が発生し、「依存は AWS SDK のみ」原則に反する (c) デフォルトを lenient（未知 type は `null`）にする案 → Write 側の新イベント追加時に Projector が silent に無視する事故が起きやすくなり、strict-by-default の安全性を損なう

### DEC-014: AWS プリミティブ非ラップ原則

- **判断:** minamo は周辺 AWS プリミティブ（DynamoDB Streams、EventBridge、Step Functions、Lambda Event Source Mapping）をラップしない。AWS リソース構成（CDK Construct）、クロスサービス実行（EventBridge Publisher）、ESM / DLQ / retry 設定の抽象化は提供しない。ドキュメントと example で「繋ぎ方」を示すが、コードでは抽象化しない。Write 側の DynamoDB 操作（`DynamoEventStore`）と 1 レコード正規化（`parseStreamRecord`）は minamo の中核価値であり、この原則の対象外。将来検討の Projection handler ヘルパー（バッチ反復 + `ReportBatchItemFailures` 定型化）もこの境界内に限定し、ESM 設定や DLQ 方針の抽象化には踏み込まない
- **理由:** AWS のプリミティブは十分に文書化され、CDK / Terraform でインフラ定義が完結する。ラッパーを提供すると AWS の設定更新（新しい ESM オプション、EventBridge の新機能等）への追従が保守負債になり、1 人メンテの minamo には持続不可能。Non-Goals の「CDK Construct」「EventBridge Publisher」「Event Source Mapping / DLQ / retry 設定の抽象化」はこの原則の帰結である。minamo の価値は Write 側の型安全な Aggregate ライフサイクルと Projection Bridge の正規化にあり、インフラ層に手を広げることはスコープの膨張を招く
- **棄却した代替案:** (a) CDK Construct で Event Store テーブル + Stream + Lambda を一発で構成する案 → CDK の L3 Construct は便利だが、利用者のインフラ構成（VPC、権限、タグ付け等）と衝突するケースが多く、「設定の 80% は使えるが残り 20% でカスタマイズできない」問題を起こす (b) EventBridge Publisher を `parseStreamRecord` と対にして提供する案 → EventBridge への publish は `PutEvents` API 1 行で済み、ラッパーの付加価値が低い。publish 先の EventBus 名やルールの設計はインフラ層の関心事

### DEC-015: Input Validation は Standard Schema v1 interface で受ける

- **指摘元:** v0.1.0 release prep レビュー（2026-04-17）
- **指摘:** `src/` に `validate` / `StandardSchemaV1` / `ValidationError` が export されているが concept.md §5 に仕様記述がなく、「concept.md §5 と `src/` の型シグネチャが逐字一致」という v0.1.0 exit criteria に drift が発生している
- **判断:** `validate` helper と Standard Schema v1 interface / `ValidationError` を §5.9 Optional: Input Validation として仕様化する。特定の validator 実装（Zod / Valibot / ArkType 等）には依存せず、Standard Schema v1 interface のみを型として受け取る
- **理由:** CommandHandler は同期・決定的・副作用なし（DEC-005）で、非決定的要素は `input` に注入する（DEC-010）。この結果、runtime validation は `executeCommand` の外（境界）で行い、検証済みの `input` を handler に渡す設計になる。Standard Schema v1 は Zod v3.24+ / Valibot v1 / ArkType v2 等が実装する validator の共通仕様（spec: https://standardschema.dev）であり、interface のみを受け取る形をとることで consumer の validator 選択を制約せず、型抽出（`InferSchemaOutput`）で CommandHandler の `TInput` に型安全に接続できる。§6 Non-Goals で projection payload の schema 検証を consumer 責務と定義した原理（DEC-013）を、CommandHandler 入力 validation にも適用する。minamo 側で実装する runtime コードは `validate` helper 1 本と `ValidationError` class のみで、「runtime 依存は AWS SDK のみ」原則（§4）も崩れない
- **棄却した代替案:** (a) Zod / Valibot への直接依存 → 「runtime 依存は AWS SDK のみ」原則に反し、consumer の validator 選択を制約する（DEC-013 の data 型検証棄却と同じ論理） (b) minamo 独自の validator interface を新規定義 → エコシステム分断を招き、既存の Standard Schema 対応 validator の資産を活かせない (c) validation 機能を提供せず consumer が自前で wrap → 型抽出の接続点がなく、CommandHandler の `TInput` と schema の出力型を手で合わせる負担が残る。型安全性が minamo の価値の中核である以上、境界 helper を 1 本提供する価値は高い (d) CommandHandler 内部に async validate を内蔵 → sync handler 制約（DEC-005）に違反し、再試行時に毎回 validate が走るため冪等性と性能の両方を悪化させる

---

## 7. Alternatives

### 競合ライブラリ比較

CQRS+ES を TypeScript で実現する既存の選択肢と minamo を比較する。
比較対象は DynamoDB 対応の有無にかかわらず、TypeScript CQRS+ES エコシステムで利用者が検討しうるものを選んだ。

> **スコープ:** 本セクションは DynamoDB + TypeScript で CQRS+ES を実現する選択肢に限定する。EventStoreDB、Marten 等の専用データベースは DynamoDB を前提としない別カテゴリであり、比較対象外とした。CQRS+ES を採用しない選択肢（単純 CRUD + 監査ログ、DynamoDB + Lambda + EventBridge の直接実装）は §1 Problem と §2 Target User で前提条件として除外済みであり、ここでは扱わない。CQRS+ES の採否判断自体は minamo の責務ではなく、§2 の前提条件を満たすチームに向けた比較を行う。
>
> **鮮度注記:** 本セクションの npm バージョン、最終コミット日、メンテ状態は checked date 時点の情報である。§7 は concept.md 内で最も鮮度落ちしやすいセクションであり、次のレビュー時に優先的に再検証すべきである。

| 項目 | castore | @ocoda/event-sourcing | 自前実装 | minamo |
|------|---------|----------------------|---------|--------|
| DynamoDB 対応 | ○ adapter あり | ○ adapter あり | 利用者が実装 | ○ DynamoEventStore |
| 型安全性 | ○ generics 活用 | ○ NestJS デコレータ + generics | 利用者次第 | ○ EventMap → evolve 型推論 |
| 楽観的ロック | ○ ConditionExpression | ○ | 利用者が実装 | ○ TransactWriteItems + ConditionCheck |
| ConcurrencyError リトライ | △ Command 利用時に retry 設定あり | ✕ 利用者責任 | 利用者が実装 | ○ executeCommand で full-cycle retry を中核 API として提供 |
| InMemory テスト互換 | △ 過去に差異報告あり（Issue #66） | — 未調査 | 利用者次第 | ○ Contract Tests で公開契約一致を保証 |
| Snapshot | ✕ | ○ v2 系で提供 | 利用者が実装 | ✕（v1 非対応。将来検討） |
| Event Upcasting | ✕ | ○ v2 系で提供 | 利用者が実装 | ✕（v1 非対応。将来検討） |
| Read 側（Projection 管理） | △ 部分的 | ○ 包括的 | 利用者が実装 | ✕（Write 側のみ。parseStreamRecord で橋渡し） |
| フレームワーク依存 | なし | NestJS 必須 | なし | なし |
| runtime 依存数 | 2（@babel/runtime, ts-toolbelt） | 2+（class-transformer, ulidx） | 0 | AWS SDK v3 のみ |
| メンテ状態（2026-04 時点） | 最終コミット 2025-10、DynamoDB adapter 未更新 | 最終 push 2026-04、アクティブ | — | 新規（v0.x） |

#### castore（`@castore/core`）

> **Fact:** castore の最新 `@castore/core` は v2.4.2（2025-04-18 公開）。DynamoDB adapter（`@castore/event-storage-adapter-dynamodb`）は v1.25.3（2023-09-29）で更新が止まっており、v2 系は未公開。
> Source: https://www.npmjs.com/package/@castore/core (checked: 2026-04-12)
> Source: https://www.npmjs.com/package/@castore/event-storage-adapter-dynamodb (checked: 2026-04-12)

> **Fact:** GitHub リポジトリの最新コミットは 2025-10-12。Issue #203 "State of this library?" が OPEN のまま。リポジトリはアーカイブされていないが、利用者からメンテ状態への懸念が表明されている。
> Source: https://github.com/castore-dev/castore/issues/203 (checked: 2026-04-12)

> **Fact:** castore の DynamoDB adapter で EventAlreadyExists 検知の不具合が報告されている（Issue #92、CLOSED）。同一 version 衝突に関する運用課題も報告されている（Issue #180、CLOSED）。いずれも過去のバージョンでの報告であり、現行版での影響有無は未確認。
> Source: https://github.com/castore-dev/castore/issues/92 (checked: 2026-04-12)
> Source: https://github.com/castore-dev/castore/issues/180 (checked: 2026-04-12)

> **Fact:** castore で `pushEventTransaction` が InMemory adapter では利用できず、テスト時のコードパスが本番と分岐する問題が報告されている（Issue #66、CLOSED）。クローズ時点で unified event groups API が両 adapter で動作すると案内されており、当該 Issue 自体は解消されている。
> Source: https://github.com/castore-dev/castore/issues/66 (checked: 2026-04-12)

castore は TypeScript CQRS+ES ライブラリとして最も近い位置にある。generics を活用した型安全性、DynamoDB adapter、楽観的ロックを備える。castore の Command 利用時には retry 設定があり、楽観的ロック失敗時のリトライ機構も備えている。ただし以下の差異がある:

1. **DynamoDB adapter のメンテナンス遅延** — core が v2 に進んだ一方、DynamoDB adapter は v1 系で止まっている。DynamoDB を主戦場とする minamo とはメンテナンスの優先度が異なる
2. **InMemory テスト互換性のアプローチ差** — castore では過去に adapter 間で使える API が異なる問題が報告されていた（Issue #66）。当該 Issue は unified event groups API で対応済みだが、minamo は Contract Tests で `append` / `load` の公開契約一致を明示的に保証する異なるアプローチを取る
3. **full-cycle retry の API 上の位置づけ** — castore も Command 利用時に retry 設定を提供する。minamo の差別化は retry を `executeCommand` の中核機能として前面に出し、Load → Rehydrate → Decide → Append の全サイクルをライブラリが管理する点にある
4. **runtime 依存** — `@babel/runtime` と `ts-toolbelt` に依存する。minamo は AWS SDK v3 以外の runtime 依存を持たない

> **minamo が castore より劣る点:** castore は adapter パターンで DynamoDB 以外（PostgreSQL、MongoDB 等）にも対応可能。minamo は DynamoDB 専用であり、他の DB を使う場合は選択肢にならない。また castore はコミュニティが存在し（GitHub Stars 271、2026-04-12 時点。npm weekly downloads は minamo より多い）、実運用実績がある。minamo は新規プロジェクトであり、v0.x フェーズで実運用実績はまだない。

#### @ocoda/event-sourcing

> **Fact:** `@ocoda/event-sourcing` の最新バージョンは v2.1.4（2025-06-22 公開）。GitHub リポジトリの最新 push は 2026-04-01。
> Source: https://www.npmjs.com/package/@ocoda/event-sourcing (checked: 2026-04-12)

@ocoda/event-sourcing は NestJS フレームワーク上で CQRS+ES を実現するライブラリ。DynamoDB adapter を含み、アクティブにメンテナンスされている（最終 push 2026-04-01）。ただし NestJS への依存が前提条件であり、フレームワーク非依存の minamo とはターゲットが異なる。

NestJS を使うチームにとっては DI・デコレータ・モジュールシステムとの統合が魅力。

> **Assumption:** @ocoda/event-sourcing の v2 系ドキュメントおよびソースコードに、楽観的ロック失敗時の自動リトライ機構への言及は確認できなかった（checked: 2026-04-12）。未調査の可能性があるため Assumption として扱う。
>
> **Assumption:** Lambda の軽量なハンドラで CQRS+ES を使いたい場合、NestJS の起動コストとバンドルサイズが障壁になりうる。ただし NestJS on Lambda のバンドルサイズ・Cold Start への影響の定量データは未検証。

> **minamo が @ocoda より劣る点:** @ocoda は Snapshot、Saga、Event Upcasting を v2 系で提供しており、CQRS+ES の Read 側を含めた包括的なフレームワーク。minamo は Write 側のみを担い、Read 側は利用者に委ねる。NestJS エコシステムとの統合が必要な場合、minamo は選択肢にならない。

#### 自前実装

DynamoDB の `TransactWriteItems` + `ConditionExpression` を直接使い、Aggregate ライフサイクルを自前で実装する選択肢。外部依存なしで完全な制御が可能。

しかしセクション 1 で述べた痛み A（楽観的ロックの正しい実装）、痛み B（ConcurrencyError 後の正しいリトライ）、痛み C（InMemory とのテスト互換性）を各プロジェクトで繰り返し解くことになる。これらは一度正しく実装すればプロジェクト間で共有できるものであり、minamo はその共有部分を担う。

> **自前実装が minamo より適切な場合:** Aggregate ライフサイクルが minamo の想定（Load → Decide → Append の同期的な決定）と合わない場合。たとえば、Command Handler 内で外部 API の結果に依存する非同期的な判断が必要な場合は、`executeCommand` の同期 handler 制約（DEC-005）が合わない可能性がある。

### 棄却した設計案

concept.md の構築過程で検討し、採用しなかった大きな設計方針。

| 設計案 | 棄却理由 | 関連 DEC |
|--------|---------|---------|
| **全 DB 対応（adapter パターン）** | minamo の本番実装は DynamoDB 専用。EventStore interface の汎用性は Contract Tests のためであり、DB ポータビリティのためではない。複数 DB への adapter 追従は 1 人メンテに持続不可能 | DEC-006 |
| **Saga / Process Manager 内蔵** | Saga / Process Manager の実装先は AWS Step Functions、EventBridge + SQS による choreography 等が選択肢として存在する。いずれもアプリケーション固有の補償ロジックを含み、汎用ラッパーの付加価値が低い。スコープの膨張を招く | DEC-003, DEC-014 |
| **CDK Construct 同梱** | CDK の L3 Construct は利用者のインフラ構成と衝突するケースが多い。テーブル定義の CDK サンプルをドキュメントで提供する方が柔軟 | DEC-014 |
| **Projection 管理の内蔵** | Read Model の設計はアクセスパターンに依存し、利用者のビジネスロジックそのもの。minamo は `parseStreamRecord` で橋渡しのみ提供 | DEC-013, DEC-014 |
| **EventBridge Publisher 内蔵** | EventBridge への publish は権限設計、再送ポリシー、観測性設定、イベントスキーマ設計がアプリケーション固有であり、汎用ラッパーの境界が不安定になる。インフラ層の関心事 | DEC-014 |
| **AsyncCommandHandler の提供** | 非同期を許可すると handler 内で外部 API を呼ぶ誘惑が生まれ、再試行時の冪等性担保が利用者責任になる。型による安全性が minamo の価値 | DEC-005 |
| **AggregateConfig.name による PK プレフィックス自動生成** | PK の命名規約はテーブル設計全体の関心事。minamo が一部だけを制御すると設計自由度を損なう | DEC-004 |
| **backoff / jitter の v1 提供** | v1 では未提供。高競合（hot aggregate）では backoff / jitter が有効だが、そもそも Aggregate 境界の見直しや呼び出し側での同時実行抑制が根本対策。将来オプション（`retryStrategy`）として追加の余地は残す。v1 は API 表���積を最小に保つ | DEC-012 |

### minamo の位置づけ

minamo は「DynamoDB + Lambda + TypeScript で CQRS+ES の Write 側を型安全に実装する」ことに特化する。

**差別化の軸:**

1. **DynamoDB ファースト** — DynamoDB を「対応 DB の一つ」ではなく、唯一の本番ストレージとして最適化する。TransactWriteItems の制約（100 操作 / 4MB）、ConsistentRead による fresh read、ConditionCheck によるギャップ検出が設計に組み込まれている
2. **Contract Tests による InMemory 互換保証** — テスト用の `InMemoryEventStore` と本番の `DynamoEventStore` が同じ公開契約を実装することを Contract Tests で保証する。castore の Issue #66 に見られる adapter 間差異の問題を構造的に解消する
3. **executeCommand による全サイクル自動リトライ** — Load → Rehydrate → Decide → Append を一貫して管理し、ConcurrencyError 時に Load から全体をやり直す。この配線ミスがセクション 1 の痛み B の本質であり、minamo の中核価値
4. **最小依存** — runtime 依存は AWS SDK v3 のみ。Lambda の Cold Start への影響を最小化し、依存の保守負債を抑える

**採用判断チェックリスト:**

| 条件 | Yes → minamo が候補 | No → 別の選択肢 |
|------|---------------------|-----------------|
| DynamoDB を使うか | ○ | castore（multi-DB adapter）、自前実装、または CQRS+ES 以外のアーキテクチャを検討 |
| Lambda + TypeScript か | ○ | 他言語 / 他ランタイム向けのライブラリを検討 |
| CQRS+ES の Write 側の型安全性が必要か | ○ | 自前実装で十分な可能性。§1 の痛み A/B/C が該当しなければ minamo は過剰 |
| NestJS を使っているか | No → minamo が適合 | Yes → @ocoda/event-sourcing が統合面で有利 |
| Snapshot / Upcasting が v1 で必要か | No → minamo v1 で対応可能 | Yes → @ocoda（v2 系で提供）、または自前実装 |
| Read 側まで含めたフレームワークが必要か | No → minamo + AWS プリミティブ | Yes → @ocoda、または自前のフレームワーク構築 |
| 実運用実績を重視するか | リスク受容可能 → minamo（v0.x） | 実績必須 → castore（Stars 271、既存利用者あり） |
| SLA が必要か | No → minamo で対応可能 | Yes → 1 人メンテの OSS に SLA はない。§8 参照 |

---

## 8. Risks

### 技術リスク

| リスク | 影響 | 発生条件 | 緩和策 | 関連 |
|--------|------|---------|--------|------|
| **Rehydration コスト増大** | Lambda 実行時間・メモリ消費が増加し、タイムアウト（15 分上限）に達するリスク | Aggregate のイベント数 × ペイロードサイズが増大した場合。安全運用レンジは未確定（v1 リリース後に実測で検証予定） | v1 は Snapshot なし。短いライフサイクルの Aggregate 設計を推奨する。ユースケースに応じた閾値の特定は §10 Open Questions | §3 Lambda 15分上限, §3 Query 1MB上限 |
| **DynamoDB Streams 24h 保持期間超過** | Projection Lambda が 24 時間以上停止すると、未処理イベントが Stream から消失し、Read Model が不整合になる | Lambda のデプロイエラー、ESM の無効化、権限不備、throttling、長時間のインシデント | minamo のスコープ外だが、運用上の警告としてドキュメントに記載する。`IteratorAge` CloudWatch メトリクスによるアラーム設定で早期検知する。`MaximumRecordAgeInSeconds` と `MaximumRetryAttempts` は 24h 消失を直接防ぐものではないが、再試行を早く打ち切って OnFailure destination（SQS / SNS）に逃がすことで blast radius を縮小する補助策として推奨。全イベントは Event Store に残るため、Stream 消失時は Event Store から Read Model を再構築できるが、再構築機構（Runbook / バッチジョブ）は minamo が提供しない。利用者が実装する必要がある | §3 Streams 24h保持 |
| **Hot aggregate による ConcurrencyError 増大と派生影響** | 同一 Aggregate への高頻度書き込みで即時リトライが競合を再同期させ、`maxRetries` を超過する確率が上がる。同一 PK への書き込み集中は DynamoDB の hot partition を引き起こし、`ProvisionedThroughputExceededException`（on-demand でも per-partition 上限）、Streams の iterator lag 増大、Lambda の reserved concurrency 競合にも波及する | 同一 Aggregate（= 同一 PK）への書き込みがパーティション容量（1,000 WCU / 3,000 RCU per partition）に対して高負荷になった場合 | Aggregate 境界の見直し（粒度を細かくして競合を分散）、上流での command serialization / rate limiting が根本対策。v1 は即時リトライに留め、backoff で隠さない設計判断（DEC-012）。`ConcurrencyError` 発生率と `IteratorAge` の監視を推奨。Projection Lambda の `Duration` / `Errors` / `Throttles` も監視対象に含めると派生影響の早期検知に有効 | §3 Lambda 同時実行, §3 トランザクション WCU, DEC-012 |
| **TransactWriteItems のサイズ制約超過** | 1 コマンドで 99 件超のイベント、または合計 4MB / 単一 400KB を超えるイベントを append しようとすると `EventLimitError` | 大量のイベントを 1 コマンドで生成する設計、または大きな payload を持つイベント | `DynamoEventStore` が制約超過を `EventLimitError` として検出する。大きなデータは S3 参照パターン（S3 に格納し、イベントには S3 キーのみ含める）を推奨 | §3 TransactWriteItems上限, §3 アイテムサイズ上限 |
| **DynamoDB Document Client の marshall 設定差による data loss** | `removeUndefinedValues: true` や `convertClassInstanceToMap: true` 等の設定差で、利用者側の marshall 設定と minamo の前提がずれると round-trip でデータが欠落する | 利用者が独自の marshall 設定で DynamoDB Document Client を構成した場合 | minamo は `DynamoEventStore` で使用する Document Client の marshall 設定をドキュメントで明示する。DEC-011 の plain data 制約に従えば、デフォルトの marshall 設定で round-trip が成立する | DEC-011 |
| **ParallelizationFactor > 1 での Projection 順序前提の破綻** | 同一シャード内で Lambda invocation が並列化され、クロス Aggregate の全体順序に依存する Projection が期待通りに動作しない。同一 Aggregate 内の順序は DynamoDB Streams の同一アイテム順序保証により維持されるが、異なる Aggregate 間のイベント到達順序は保証されなくなる | Event Source Mapping の `ParallelizationFactor` を 1 より大きく設定した場合 | 全体順序に依存する Projection では `ParallelizationFactor=1`（デフォルト）を必須とする。同一 Aggregate 内の順序のみに依存する Projection であれば `ParallelizationFactor > 1` でも動作するが、運用前の検証が必要。冪等キー（`aggregateId + version`）は重複対策であり、順序崩れの対策ではない点に注意。minamo のスコープ外（ESM 設定は利用者の責務、DEC-014） | §3 ParallelizationFactor, DEC-014 |
| **Streams 同時読者の制約** | 同一シャードの同時読者が 2（Global Tables では 1 推奨）を超えると throttling | 3 つ以上の Projection Lambda を同一 Stream に接続した場合 | EventBridge Pipes や Lambda の fan-out パターンで Projection を分岐させる。minamo はこの構成をラップしない（DEC-014） | §3 Streams同時読者 |
| **at-least-once delivery による重複処理** | DynamoDB Streams の Event Source Mapping は at-least-once であり、Projection Lambda に同一イベントが複数回配信される可能性がある。冪等でない Projection は Read Model の不整合を起こす | DynamoDB Streams + Lambda ESM の通常動作。特にバッチ失敗後のリトライで顕在化する | Projection の冪等キーとして `aggregateId + version` を使い、重複配信を検出する。`ReportBatchItemFailures` で部分バッチ失敗を報告し、成功済みレコードの再処理を回避する。minamo は `parseStreamRecord` で正規化のみ担い、冪等性は利用者の責務 | §3 Lambda ESM at-least-once, §5.7 |
| **結果整合性による Read Model の遅延** | Command 成功後に Read Model が即座に最新にならない。利用者やエンドユーザーが「書き込んだのに反映されない」と混乱するリスク | CQRS+ES の構造的特性。Event Store → Streams → Projection Lambda → Read Model の非同期パイプライン | minamo のスコープ外だがドキュメントで注意喚起する。UI 層での楽観的更新（Optimistic UI）、Command 成功後のポーリング、EventBridge による通知等のパターンは利用者が設計する | §3 結果整合性 |
| **Poison pill による Streams 処理の停滞** | 壊れた Stream Record や未知の event type が 1 件でも存在すると、strict モードの `parseStreamRecord` が例外を throw し、Lambda がエラーを返す。ESM がリトライを繰り返し、シャード内の後続レコードが全てブロックされる。最終的に 24h 保持期間を超過し、後続イベントも消失する連鎖事故 | Write 側で新しい event type を追加したが Projection Lambda が未デプロイ、またはイベントの marshall が壊れた場合 | Lambda ESM の `BisectBatchOnFunctionError: true`、`MaximumRetryAttempts`（有限値）、OnFailure destination（SQS / SNS）を設定する。`ReportBatchItemFailures` で正常レコードの再処理を回避する。minamo はドキュメントでこの構成を推奨するが、ESM 設定自体はラップしない（DEC-014） | §5.7, DEC-013, DEC-014 |
| **トランザクション WCU 2x によるコスト・スロットリング** | TransactWriteItems は通常の 2 倍の WCU を消費する。on-demand でもバーストクレジットの消費が速くなり、per-partition limit に達するリスクがある | 高頻度の Command 実行。特に Aggregate あたりのイベント数が多い場合 | コスト試算時に WCU 2x を考慮する。on-demand テーブルでも per-partition 上限（1,000 WCU）は存在する。高スループットが必要な場合は Aggregate 粒度の調整で書き込みを分散する | §3 トランザクション WCU |
| **イベントの不変性とデータ削除要求の衝突** | Event Sourcing ではイベントは不変（immutable）であり、後から削除・修正できない。PII（個人識別情報）をイベントに含めた場合、GDPR の「忘れられる権利」等の削除要求に対応が困難になる | PII をイベントの payload に直接格納した場合 | PII はイベントに直接含めず、外部ストア（暗号化された別テーブル等）への参照のみをイベントに格納する（crypto-shredding パターン）。minamo はこのパターンを強制しないが、ドキュメントで注意喚起する。暗号化・テナント分離・KMS 境界の設計は利用者の責務であり minamo のスコープ外 | — |
| **Write 側の重複コマンド** | クライアントのタイムアウト再送や Lambda の再試行により、同一コマンドが複数回実行される可能性がある。`executeCommand` 内の ConcurrencyError リトライとは別の問題 | クライアント → API Gateway → Lambda の経路でタイムアウト後に再送が発生した場合 | `executeCommand` の呼び出し元で idempotency key（リクエスト ID 等）を管理する。Powertools for AWS Lambda の Idempotency ユーティリティが選択肢。minamo は Write 側の Command 冪等性を提供しない（Aggregate ライフサイクル内の ConcurrencyError リトライのみ）| — |
| **Event schema evolution（イベントスキーマ進化）** | イベントにフィールドを追加・削除・型変更すると、Event Store に永続化済みの古いイベントを新しい `evolve` 関数が処理できず、Rehydration が失敗する。Event Store のイベントは不変であり、後から修正できない | Aggregate の `evolve` 定義を変更し、過去のイベント形態との互換性を維持しなかった場合 | v1 は upcaster 機構を提供しない（§6 将来検討）。**v1 ではイベントスキーマの変更は additive only に限定する（フィールド追加のみ OK。削除・リネーム・型変更は不可）。** 破壊的変更が必要な場合は新しい event type を追加し、古い type の evolve ハンドラも維持する。`evolve` 関数内での defensive coding（optional field、default value）が現実的な対策。将来の upcaster サポートは §10 Open Questions | §3 制約表（イベントスキーマ進化行）, §6 将来検討 |

> **Assumption:** Rehydration コストが問題になる閾値は未確定。DynamoDB の Query レイテンシーは結果セットのサイズに依存し、Lambda の `timeout` と `memorySize` 設定によっても変動する。1,000 件のイベントが 1MB 以内に収まる場合は単一 Query で取得可能だが、固定の件数閾値ではなく、ユースケースごとの実測が必要。実測データに基づく閾値の特定は v1 リリース後の課題（§10 Open Questions）。

### 市場リスク

| リスク | 影響 | 発生条件 | 緩和策 |
|--------|------|---------|--------|
| **CQRS+ES パターンの採用率の低さ** | 潜在利用者数が限定される | CQRS+ES は大多数のアプリケーションには過剰設計であり、必要とするユースケースが限定的 | minamo は CQRS+ES の普及自体を目標にしない。§2 Target User で「複数の Read Model、並行更新の整合性、監査証跡」を必要とするチームに限定している。市場サイズは小さいことを受容する |
| **DynamoDB + Lambda + TypeScript の AND 条件** | 3 つの前提条件を全て満たすチームのみが対象。対象が狭い | — | 受容する。この AND 条件は minamo の設計前提であり、緩和するとスコープの膨張を招く（複数 DB 対応は永久スコープ外）。DynamoDB + Lambda + TypeScript は AWS Serverless の主要構成であり、一定のユーザーベースは存在する |
| **castore 等の競合が活発化した場合** | 利用者が castore を選択し、minamo の存在意義が薄れる | castore の DynamoDB adapter が v2 に追随し、ConcurrencyError リトライ、Contract Tests が追加された場合 | minamo の差別化は DynamoDB ファースト設計と Contract Tests にある。競合が同等の機能を提供した場合は、利用者にとって選択肢が増えるポジティブな状況であり、minamo の継続判断は dog-fooding の実用性で判断する |

### メンテナンスリスク

| リスク | 影響 | 発生条件 | 緩和策 |
|--------|------|---------|--------|
| **1 人メンテの持続可能性** | バグ修正・セキュリティ修正の遅延、最悪の場合はプロジェクト停止。SLA（応答時間・修正期限）は存在しない。メンテナ停止時は fork が現実的な選択肢になる | メンテナ（seike460）の時間的余裕がなくなった場合、興味の移行、本業との優先度競合 | §6 Non-Goals でスコープを厳しく制限し、保守対象を最小化している。MIT ライセンスのため fork は自由。dog-fooding を継続し、自分が使わなくなったら正直にそのことを認める（行動指針）。利用者はこのリスクを前提に、minamo への依存度（Lock-in 度）を評価すべき |
| **AWS SDK v3 の breaking change** | `DynamoEventStore` がコンパイルエラーや runtime エラーを起こす | AWS SDK v3 の major version up（v4 等） | 依存は AWS SDK v3 のみであり、影響範囲が限定的。AWS SDK のメジャーアップデートは頻繁には起きないが、メンテナが活動中であれば発生時に追従する。メンテナ停止時は fork で対応（1 人メンテリスク参照）。0.x の間は SDK バージョンの柔軟な更新が可能 |
| **TypeScript の型システム進化への追従** | `ReadonlyDeep`、conditional types 等の型定義が新バージョンで壊れるリスク | TypeScript の major version up で型の挙動が変わった場合 | TypeScript の型システムは後方互換を重視する傾向がある。`ReadonlyDeep` は標準的な再帰型であり、壊れるリスクは低い。ただし TypeScript のバージョン上限を `peerDependencies` で明示し、テスト CI で複数バージョンを検証する |
| **DynamoDB API の仕様変更** | `TransactWriteItems` の挙動変更、`ConditionExpression` の仕様変更で `DynamoEventStore` の整合性が壊れる | AWS が DynamoDB API に破壊的変更を加えた場合 | AWS は既存 API の破壊的変更を避ける傾向が強い。DynamoDB の `TransactWriteItems` は広く使われており、非互換変更のリスクは低い。ただし AWS の Deprecation Notice を監視し、影響がある場合は速やかに対応する |

> **Fact:** AWS SDK for JavaScript v3 は 2020 年に GA。v2 → v3 の移行期間は数年にわたり、v2 の EOL は 2025-09-08 に到達した。
> Source: https://aws.amazon.com/blogs/developer/announcing-end-of-support-for-aws-sdk-for-javascript-v2/ (checked: 2026-04-12)

> **Assumption:** AWS が DynamoDB の `TransactWriteItems` API に破壊的変更を加えるリスクは低い。AWS は既存 API の後方互換を維持する傾向があり、新機能は新しい API として追加される。ただし保証はない。

### v1 採用非推奨条件

以下の条件に該当する場合、minamo v1 の採用は推奨しない。

| 条件 | 理由 |
|------|------|
| 長寿命 Aggregate（イベント数が継続的に増加し上限が予測できない） | v1 は Snapshot なし。Rehydration コストが Lambda のタイムアウト / メモリ上限に達するリスクが高い |
| read-your-write 即時整合性が必須 | CQRS+ES は構造的に結果整合。Command 成功直後に最新の Read Model が必要なユースケースには不向き |
| 独立した Projection Lambda が 3 つ以上必要 | DynamoDB Streams の同時読者制約（shard あたり 2）に抵触する。EventBridge Pipes 等の fan-out が必要になり、minamo のスコープ外の構成が前提になる |
| Read Model の再構築基盤を自前で持てない | Streams 消失時の Read Model 再構築は minamo が提供しない。利用者が Runbook / バッチジョブを実装・運用する必要がある |
| SLA が必要な本番ワークロード（ライブラリのバグ修正期限が contractual） | 1 人メンテの OSS に SLA は存在しない。fork の覚悟がない場合はリスクが高い |
| 頻繁なイベントスキーマ変更が予見される | v1 は upcaster なし。`evolve` での defensive coding が前提であり、スキーマ変更頻度が高い場合は互換性維持の負荷が大きい |

---

## 9. Adoption Path

DynamoDB + Lambda + 結果整合性の基本理解がある開発者が、concept.md を読んだ後 30 分以内に minamo を試行開始できる導線。

### 前提条件チェックリスト

- [ ] Node.js 24+ および pnpm がインストール済み
- [ ] AWS アカウントと DynamoDB テーブル作成権限（Step 2 以降で必要。Step 1 はローカルのみ）
- [ ] TypeScript 5.0+ の開発環境（ESM: `"type": "module"` が前提。`tsconfig.json` は `"module": "NodeNext"`, `"moduleResolution": "NodeNext"` を推奨）

### Step 1: InMemory でのローカル試行（5 分）

```bash
mkdir minamo-trial && cd minamo-trial
pnpm init && pnpm add @seike460/minamo typescript tsx
```

§4 の最小コード例を `main.ts` として保存し、以下で実行する:

```bash
npx tsx main.ts
```

`InMemoryEventStore` を使うため、AWS アカウントやネットワーク接続は不要。`executeCommand` の動作、`ConcurrencyError` 時の自動リトライ、no-op command の挙動を確認できる。

**成功確認:** `console.log` の出力が §4 の期待値と一致すること。

### Step 2: DynamoDB テーブル作成（10 分）

> Step 2 は AWS アカウントを使う場合の手順。DynamoDB Local でローカル試行する場合は Step 2 をスキップし、後述の「DynamoDB Local」セクションを参照。

Event Store 用のテーブルを作成する。スキーマは以下の通り:

- **Partition Key:** `aggregateId` (String)
- **Sort Key:** `version` (Number)
- **DynamoDB Streams:** 有効（`StreamViewType: NEW_IMAGE`）

> **Fact:** minamo の `parseStreamRecord` は `NewImage` フィールドを前提とするため、`StreamViewType: NEW_IMAGE` を使用する。これは AWS の汎用推奨ではなく、minamo の製品要件である。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html (checked: 2026-04-12)

#### AWS CLI

```bash
aws dynamodb create-table \
  --table-name minamo-event-store \
  --attribute-definitions \
    AttributeName=aggregateId,AttributeType=S \
    AttributeName=version,AttributeType=N \
  --key-schema \
    AttributeName=aggregateId,KeyType=HASH \
    AttributeName=version,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_IMAGE \
  --region ap-northeast-1
```

#### AWS CDK（TypeScript）

以下は利用者が自身のインフラコードとして書く CDK コード例。minamo は CDK Construct を提供しない（§6 Non-Goals、DEC-014）。

```typescript
import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";

const eventStoreTable = new Table(this, "EventStore", {
  tableName: "minamo-event-store",
  partitionKey: { name: "aggregateId", type: AttributeType.STRING },
  sortKey: { name: "version", type: AttributeType.NUMBER },
  billingMode: BillingMode.PAY_PER_REQUEST,
  stream: StreamViewType.NEW_IMAGE,
  removalPolicy: RemovalPolicy.RETAIN,
});
```

> **マルチ Aggregate 運用時の注意:** 複数 Aggregate を同一テーブルで運用する場合は `aggregateId` の全体一意性を確保すること（例: `Order#123`, `Inventory#456`）。衝突すると別 Aggregate のイベントが混入する。DEC-004 参照。
>
> **Billing mode の選択:** Event Store テーブルは on-demand（`PAY_PER_REQUEST`）を推奨する。Command の発生パターンはバースト的であり、on-demand が適する。Read Model テーブルはアクセスパターンに依存し、定常トラフィックなら provisioned も選択肢。容量モードの切替は数分かかるがダウンタイムなし（以前のスループットで処理される）。ただし 24 時間の切替回数制限がある。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/switching.capacitymode.html (checked: 2026-04-12)

#### DynamoDB Local（ローカル試行）

AWS アカウントなしで DynamoEventStore を試す場合は DynamoDB Local を使用できる。

```bash
docker run -p 8000:8000 amazon/dynamodb-local

# ローカルテーブル作成
aws dynamodb create-table \
  --table-name minamo-event-store \
  --attribute-definitions \
    AttributeName=aggregateId,AttributeType=S \
    AttributeName=version,AttributeType=N \
  --key-schema \
    AttributeName=aggregateId,KeyType=HASH \
    AttributeName=version,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000
```

```typescript
const prodStore = new DynamoEventStore<CounterEvents>({
  tableName: "minamo-event-store",
  clientConfig: { endpoint: "http://localhost:8000", region: "local" },
});
```

> **注意:** DynamoDB Local は Step 2〜3（テーブル作成と DynamoEventStore 動作確認）で利用できる。Step 4（Projection Lambda + Event Source Mapping）は DynamoDB Streams の Lambda ESM 統合が必要であり、AWS アカウントが必須になる。
>
> **Fact:** DynamoDB Local は Docker イメージとして提供されている。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html (checked: 2026-04-12)

**成功確認:** `aws dynamodb describe-table --table-name minamo-event-store` でテーブルが `ACTIVE` であること。

### Step 3: DynamoEventStore への切り替え（5 分）

§4 の本番コード例を参照し、`InMemoryEventStore` を `DynamoEventStore` に置き換える。

IAM 最小権限ポリシー例（Command Handler 用 Lambda）:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems"
      ],
      "Resource": "arn:aws:dynamodb:ap-northeast-1:ACCOUNT_ID:table/minamo-event-store"
    }
  ]
}
```

> **Fact:** 上記は minamo の `DynamoEventStore` が使用する IAM アクションの推定。実装確定後に正確な IAM ポリシー例を更新する。
> Source: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html (checked: 2026-04-12)

**成功確認:** `executeCommand` が成功し、DynamoDB テーブルにイベントが永続化されること（`aws dynamodb query --table-name minamo-event-store --consistent-read --key-condition-expression "aggregateId = :id" --expression-attribute-values '{":id":{"S":"counter-1"}}'`）。

### Step 4: Projection Lambda の接続（15〜20 分）

> 既存の CDK / SAM デプロイ基盤がある場合は 10 分程度。初回は Lambda 関数の作成、IAM ロール、ESM 設定を含むため余裕を持つこと。

§5.7 の Projection Bridge コード例を参照し、Projection Lambda を作成する。

Event Source Mapping の推奨設定:

| 設定 | 推奨値 | 理由 |
|------|--------|------|
| `BatchSize` | 100（デフォルト） | DynamoDB Streams のデフォルト |
| `ParallelizationFactor` | 1（デフォルト） | 全体順序依存の Projection では必須（§8 Risks） |
| `BisectBatchOnFunctionError` | `true` | poison pill の影響範囲を最小化 |
| `MaximumRetryAttempts` | 3〜10 | 無制限リトライによる 24h 消失リスクを軽減 |
| `MaximumRecordAgeInSeconds` | 86400（24h）以下 | blast radius 縮小の補助策 |
| `OnFailure destination` | SQS / SNS | 処理不能レコードの隔離 |
| `FunctionResponseTypes` | `ReportBatchItemFailures` | 部分バッチ失敗の報告 |

> **Fact:** `BisectBatchOnFunctionError` は、バッチ処理失敗時にバッチを二分割して問題レコードを特定する機能。
> Source: https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html (checked: 2026-04-12)

### 次のステップ

試行後に以下を一読することを推奨する:

- **§8 Risks** — 技術リスクと v1 採用非推奨条件を確認し、自身のユースケースで許容可能か判断する
- **§6 Non-Goals** — minamo が提供しないもの（Read Model 管理、Saga、Snapshot 等）を理解する
- **§11 Decisions** — 設計判断の背景を理解し、minamo の設計思想と自身のプロジェクトの方針が合致するか確認する

---

## 10. Open Questions

concept.md 構築過程で浮上した未解決の論点。全件を「v1 リリースまでに解決」または「v1 スコープ外」として分類し、未分類の論点が 0 件になることを目指す。

| # | 質問 | 起源 | 現在の仮説 | 解決条件 | v1 スコープ |
|---|------|------|-----------|---------|------------|
| OQ-1 | Snapshot の導入閾値はイベント何件からか | §3 Query 1MB 上限、§6 将来検討、§8 Rehydration リスク | イベント数 × ペイロードサイズが Lambda の timeout / memorySize に対して問題になる閾値は未確定 | v1 リリース後の実運用データで Rehydration レイテンシーを実測し、閾値を特定する | v1 スコープ外。v1 は Snapshot なし。閾値特定は実測データが前提 |
| OQ-2 | イベントスキーマ進化（upcasting）の最小実装はどうあるべきか | §3 CQRS+ES 制約、§6 将来検討、§8 Event schema evolution リスク | `evolve` 関数内での defensive coding（optional field / default value）が v1 の現実的な対策。ライブラリとしての upcaster は API 安定後に検討 | minamo の公開 API が安定し（v1.0.0 以降）、upcasting の需要が確認された場合 | v1 スコープ外。API 安定が前提条件 |
| OQ-3 | DynamoDB Streams の伝播レイテンシーの定量値 | §3 Streams 保持期間、§8 結果整合性リスク | 通常は数百ミリ秒〜数秒だが、AWS は公式 SLA を提供していない | AWS が公式に伝播レイテンシーの SLA を公開するか、実測データで十分な統計が得られた場合 | v1 スコープ外。minamo のコードに影響しない。ドキュメントで「公式 SLA なし」を注記 |
| ~~OQ-4~~ | ~~複数 Aggregate 共有テーブルでの event type 衝突のベストプラクティス~~ | §5.7 shared table、DEC-009 | — | — | **解決済み。** DEC-009 で命名ポリシーを決定。ドキュメント作成は実装フェーズのタスク |
| OQ-5 | executeCommand の backoff strategy の将来設計 | DEC-012 即時リトライ、§7 backoff 棄却 | `retryStrategy?: (attempt: number) => Promise<void>` をオプションとして追加する余地を残す。v1 は即時リトライ | 実運用で即時リトライの限界が確認された場合 | v1 スコープ外。v1 は即時リトライのまま |
| OQ-6 | DynamoDB Document Client の推奨 marshall 設定 | DEC-011 シリアライゼーション契約、§8 marshall 設定差リスク | DEC-011 の plain data 制約に従えばデフォルト設定で round-trip が成立する | v1 実装時に `DynamoEventStore` のテストで検証 | v1 実装フェーズで解決。concept phase では DEC-011 の plain data 制約で設計判断は完了 |
| OQ-7 | Global Tables 環境での minamo の動作可否 | §3 Streams 同時読者（Global Tables では 1 推奨） | Global Tables はリージョン間でイベントの整合性管理が複雑になる。v1 では単一リージョンを前提とする | Global Tables + minamo の組み合わせで検証を実施した場合 | v1 スコープ外。単一リージョン前提 |
| ~~OQ-8~~ | ~~Node.js サポートバージョンポリシー~~ | §9 前提条件、§12 サポート範囲 | — | — | **解決済み。** §12 に「AWS Lambda の LTS、`engines` で明示、EOL は次 minor で切り捨て」と方針記載 |

> **Decision:** §11 Decisions で決着済みの論点（DEC-001〜014）はこのセクションには含めない。

---

## 12. OSS Expectations

### メンテ体制

minamo は **1 人メンテ**（seike460）のプロジェクトである。

- **SLA は存在しない。** バグ修正・セキュリティ修正ともにベストエフォートで対応する。応答時間の約束はしない
- Issue / PR への対応はベストエフォート。対応の保証はない
- メンテナが活動を停止した場合は **fork が現実的な選択肢**になる。MIT ライセンスのため fork は自由
- コントリビューションは歓迎するが、§6 Non-Goals のスコープ遵守が前提。スコープ外の機能追加 PR は受け入れない
- メンテナ自身が minamo を使わなくなった場合はそのことを正直に告知する（行動指針: dog-fooding）

§8 Risks のメンテナンスリスクも参照。

### API 安定性

**SemVer 準拠。**

- **0.x:** API を磨くフェーズ。breaking change は許容される。ただし 0.x でも breaking change の前に **1 リリース deprecation 警告** を出す（行動指針: Compatibility is a Feature）
- **1.0.0 の条件:** 以下を全て満たした場合
  - §10 Open Questions の v1 スコープ内項目が全て解決済み
  - 実プロジェクトでの dog-fooding 実績がある
  - 公開 API が 3 マイナーリリース以上安定している（breaking change なし）
- **1.x:** deprecation → 次の minor release で警告 → その次の minor release で削除。migration guide を必ず添付する
- **2.x:** 現時点では計画しない

### サポート範囲

| カテゴリ | 方針 |
|---------|------|
| バグ修正 | 公開 API の契約違反（§5 API Design で定義された振る舞いと異なる挙動）は修正対象 |
| セキュリティ修正 | ベストエフォートで対応。severity が高い場合は優先的に対応するが、SLA はない |
| 機能追加 | §6 Non-Goals に反しない範囲で検討。Issue で提案し、合意の上で PR を送る |
| DynamoDB / Lambda の仕様変更 | メンテナが活動中であれば追従する。追従対象は AWS SDK v3 系のみ |
| TypeScript バージョン | `peerDependencies` でサポート範囲を明示。CI で複数バージョンを検証 |
| Node.js バージョン | AWS Lambda がサポートする Node.js LTS バージョンを対象。`engines` フィールドで明示。EOL バージョンは次の minor release で切り捨て |

### Breaking change 方針

API 安定性セクションの方針をフェーズ別にまとめる:

| フェーズ | 方針 |
|---------|------|
| **0.x** | breaking change OK。事前に 1 リリース deprecation 警告 + CHANGELOG に記載 + migration guide |
| **1.x** | deprecation → 1 minor release 後に削除。migration guide 必須 |
| **2.x** | 現時点では計画しない |

**例外:** critical bug / security vulnerability の修正では deprecation 期間を短縮または省略する場合がある。

**Supported versions:** 最新の minor release のみがサポート対象（`current`）。1 つ前の minor release はセキュリティ修正のみ（`security-fixes-only`）。それ以前は `unsupported`。

### セキュリティ脆弱性の報告

npm 公開前に `SECURITY.md` をリポジトリに用意する。報告方法は GitHub Security Advisories を使用する。対象バージョンは上記の Supported versions に従う。報告を受けた場合はベストエフォートで対応するが、SLA はない（メンテ体制参照）。

### ライセンス

MIT。

> **Fact:** minamo の runtime 依存は AWS SDK v3（Apache-2.0）のみ。MIT と Apache-2.0 は互換性がある。
> Source: https://www.apache.org/licenses/LICENSE-2.0 (checked: 2026-04-12)
