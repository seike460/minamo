# U7 — Errors

**Upstream**: concept.md §5.5 Errors
**Depends on**: U1 (型補助)
**Applied constraints**: C1
**Applied risks**: R9, R13

---

## 1. Unit 定義

minamo の明示的 error 型を定義する:

- `ConcurrencyError` (Spike 済、src/errors.ts:20-30)
- `EventLimitError`
- `InvalidEventStreamReason` (union type)
- `InvalidEventStreamDetails` (struct)
- `InvalidEventStreamError`
- `InvalidStreamRecordError` (U9 Projection Bridge が使用)

---

## 2. 公開 API (concept.md §5.5 / §5.7 逐字)

```ts
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

export type InvalidEventStreamReason =
  | "aggregateId_mismatch"
  | "non_monotonic_version"
  | "version_gap"
  | "invalid_initial_version"
  | "missing_evolve_handler";

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

/** INSERT レコードだが StoredEvent として不正、または未知の type (U9 が使用) */
export declare class InvalidStreamRecordError extends Error {
  readonly name: "InvalidStreamRecordError";
  readonly reason: "missing_field" | "unmarshal_failed" | "unknown_type";
  readonly detail?: string;
  constructor(
    reason: InvalidStreamRecordError["reason"],
    message: string,
    detail?: string,
  );
}
```

---

## 3. Module 配置

- `src/errors.ts` — 既存。`ConcurrencyError` / `ValidationError` 済。以下を追加:
  - `EventLimitError`
  - `InvalidEventStreamError` + `InvalidEventStreamReason` + `InvalidEventStreamDetails`
  - `InvalidStreamRecordError`
- `src/index.ts` — 追加 class / type を re-export

`ValidationError` は Standard Schema 用で concept.md §5 には直接出てこないが、既存 Spike の API として維持 (DEC-015 候補に関連、別文書)。

---

## 4. Internal Types

なし。ただし全 error class は以下の pattern を踏襲する:

```ts
export class XxxError extends Error {
  readonly name = "XxxError" as const;
  constructor(...) {
    super(message);
    Object.setPrototypeOf(this, XxxError.prototype);   // instanceof 安全性
    this.name = "XxxError";                            // CLAUDE.md の convention
  }
}
```

理由は TS の `extends Error` が transpile 後に prototype を失うため、`instanceof Error` / `instanceof XxxError` の両方が常に true になるよう `setPrototypeOf` を明示 (scripts/verify-instanceof.mjs が post-build 検証する)。

---

## 5. Runtime 依存

- internal: なし (error class のみ)
- AWS SDK: 不使用
- 標準組み込み: `Error`, `Object.setPrototypeOf`

---

## 6. Algorithm / 実装方針

### 6.1 ConcurrencyError (Spike 済)

```ts
export class ConcurrencyError extends Error {
  readonly name = "ConcurrencyError" as const;
  readonly aggregateId: string;
  readonly expectedVersion: number;

  constructor(aggregateId: string, expectedVersion: number) {
    super(
      `Concurrency conflict for aggregate "${aggregateId}" at expected version ${expectedVersion}`
    );
    Object.setPrototypeOf(this, ConcurrencyError.prototype);
    this.name = "ConcurrencyError";
    this.aggregateId = aggregateId;
    this.expectedVersion = expectedVersion;
  }
}
```

### 6.2 EventLimitError

```ts
export class EventLimitError extends Error {
  readonly name = "EventLimitError" as const;
  readonly aggregateId: string;

  constructor(aggregateId: string, message: string) {
    super(message);
    Object.setPrototypeOf(this, EventLimitError.prototype);
    this.name = "EventLimitError";
    this.aggregateId = aggregateId;
  }
}
```

使用箇所 (U5, U8):

- U5: `events.length === 0` → `new EventLimitError(aggregateId, "events must not be empty")`
- U8: `events.length > 99` → `new EventLimitError(aggregateId, "exceeds maximum 99 events per append")`
- U8: event size > 400KB → `new EventLimitError(aggregateId, "event at index N exceeds 400KB item size limit")`
- U8: total size > 4MB - slack → `new EventLimitError(aggregateId, "aggregated size exceeds 4MB transaction limit")`

### 6.3 InvalidEventStreamError

```ts
export class InvalidEventStreamError extends Error {
  readonly name = "InvalidEventStreamError" as const;
  readonly aggregateId: string;
  readonly reason: InvalidEventStreamReason;
  readonly details?: InvalidEventStreamDetails;

  constructor(
    aggregateId: string,
    reason: InvalidEventStreamReason,
    message: string,
    details?: InvalidEventStreamDetails,
  ) {
    super(message);
    Object.setPrototypeOf(this, InvalidEventStreamError.prototype);
    this.name = "InvalidEventStreamError";
    this.aggregateId = aggregateId;
    this.reason = reason;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
```

**details の undefined 回避**: JSON.stringify したときに `"details": undefined` が出ないよう、undefined 時は property 自体を付けない (DEC-011 の思想に沿う)。

### 6.4 InvalidStreamRecordError (U9 用)

```ts
export class InvalidStreamRecordError extends Error {
  readonly name = "InvalidStreamRecordError" as const;
  readonly reason: "missing_field" | "unmarshal_failed" | "unknown_type";
  readonly detail?: string;

  constructor(
    reason: InvalidStreamRecordError["reason"],
    message: string,
    detail?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, InvalidStreamRecordError.prototype);
    this.name = "InvalidStreamRecordError";
    this.reason = reason;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}
```

### 6.5 RetryExhaustedError の扱い

v0.1.0.md §3 の U7 欄に "RetryExhaustedError (§5.5 定義分)" と書かれているが、concept.md §5.5 には RetryExhaustedError の型定義は **存在しない**。executeCommand の retry 枯渇時は "最後の ConcurrencyError をそのまま throw" する (concept.md §4)。

したがって v0.1.0 では **RetryExhaustedError は追加しない**。concept.md 逐字準拠を優先する (Quality Gate §10)。

v0.1.0.md の記述修正は本 PR スコープ外 (design/v0.1.0.md は Spike 期の sketch で canonical ではない。concept.md が canonical)。

---

## 7. Edge Cases

| ケース | 期待挙動 |
|---|---|
| `new ConcurrencyError("a", 5)` | `.aggregateId === "a"`, `.expectedVersion === 5`, `.name === "ConcurrencyError"`, `instanceof Error` かつ `instanceof ConcurrencyError` |
| `JSON.stringify(err)` | TS Error の標準挙動では name/message が出ない。`.toString()` は `"ConcurrencyError: ..."` |
| build 後 `dist/` で instanceof | scripts/verify-instanceof.mjs が検証 (Spike 済) |
| `InvalidEventStreamError` with `details = undefined` | `.details` property が object に存在しない (hasOwnProperty false) |
| `InvalidStreamRecordError` with `detail = undefined` | `.detail` property が存在しない |
| ES module の minification | name は mangled 化されない (literal string) |

---

## 8. Test Plan

### 8.1 Unit tests (`test/unit.test.ts`)

既存 ConcurrencyError test を踏襲し、同等の network を各 error class に追加:

| case | assertion |
|---|---|
| CT-E-01 EventLimitError construct | `.aggregateId`, `.name`, `.message`, `instanceof` chain |
| CT-E-02 InvalidEventStreamError construct + details | `.reason`, `.details.eventIndex === 2`, etc. |
| CT-E-03 InvalidEventStreamError without details | `.details` property does not exist (Object.hasOwn false) |
| CT-E-04 InvalidStreamRecordError construct | `.reason === "unknown_type"`, `.detail === "Foo"` |
| CT-E-05 instanceof Error chain | `err instanceof Error && err instanceof SpecificError` for 全 4 class |
| CT-E-06 name property | 各 error の `.name` が expected literal |
| CT-E-07 post-build instanceof (scripts/verify-instanceof.mjs) | dist で同等動作 |

### 8.2 Type-level regression

| case | assertion |
|---|---|
| `ConcurrencyError`'s `name` | `"ConcurrencyError"` (literal) |
| `InvalidEventStreamReason` | exactly 5 literal union |
| `InvalidEventStreamDetails` | すべての field が optional string/number |
| `InvalidStreamRecordError.reason` | `"missing_field" \| "unmarshal_failed" \| "unknown_type"` |

### 8.3 post-build verification

`scripts/verify-instanceof.mjs` に以下の追加:

```js
// 追加チェック:
const { EventLimitError, InvalidEventStreamError, InvalidStreamRecordError } = mod;
const e1 = new EventLimitError("agg", "msg");
assert(e1 instanceof Error);
assert(e1 instanceof EventLimitError);
assert.equal(e1.name, "EventLimitError");

const e2 = new InvalidEventStreamError("agg", "version_gap", "msg", { eventIndex: 1 });
assert(e2 instanceof Error);
assert(e2 instanceof InvalidEventStreamError);
assert.equal(e2.reason, "version_gap");
assert.equal(e2.details.eventIndex, 1);

const e3 = new InvalidStreamRecordError("unknown_type", "msg", "Foo");
assert(e3 instanceof Error);
assert(e3 instanceof InvalidStreamRecordError);
```

---

## 9. Performance

- error 生成は catch path で数度/command。O(1) コスト
- stack trace capture は V8 default (V8 Error.captureStackTrace 等を追加しない)
- minification は effective。name は literal string で保持

---

## 10. Observability Hooks

v0.2.0 OTel 実装時に span.recordException / span.setStatus(ERROR) の call site を以下で想定:

- U6 executeCommand の catch (ConcurrencyError, InvalidEventStreamError, handler throw)
- U8 DynamoEventStore の catch (EventLimitError, SDK error)
- U9 parseStreamRecord の throw (InvalidStreamRecordError)

v0.1.0 では hook を入れず、error が素直に propagate することを契約化。

---

## 11. Error Paths

本 unit 自体は error を throw しない (class 定義と construct のみ)。consumer は以下を observe:

- `err instanceof ConcurrencyError` → retry 可能な衝突
- `err instanceof EventLimitError` → append 入力制約違反
- `err instanceof InvalidEventStreamError` → stream 不正 (stream 修復 or 再構築が必要)
- `err instanceof InvalidStreamRecordError` → Projection 側の record 不正

---

## 12. 2026 Trend Application

- **ES2022 Error cause**: v0.2.0 で `RetryExhaustedError { cause: ConcurrencyError }` を導入する場合に採用。v0.1.0 では cause なし (concept.md §5.5 逐字)
- **structured error types**: `InvalidEventStreamDetails` を構造化。consumer が logger / OTel に流しやすい
- **AbortError** (Node 24): v0.2.0 で `AbortSignal` 統合時に `throwIfAborted` の DOMException を素通りさせる想定 (wrap しない)
- **Object.setPrototypeOf pattern**: TS extends Error の typical pitfall 回避。post-build verify と組み合わせる (CLAUDE.md)

---

## § Accepted Trade-offs

- `RetryExhaustedError` を v0.1.0 で入れない。retry 情報 (attempts / last cause) を consumer が取れないが、concept.md 逐字準拠優先
- `EventLimitError` は `aggregateId` を持つが、`events.length` / `actualSize` 等の diagnostic は持たない (concept.md §5.5 逐字)。U8 で message string に詳細を詰める
- error class を ES class で定義。tsdown の ESM 出力では class は top-level で tree-shakeable ではない (constructor は parse される)。小さなコストで型安全の利点を優先
- `.details` の optional と undefined 除外を両立するため constructor で `if (details !== undefined)` を明示。property 存在検査 (`hasOwn`) で消費側が分岐できる
- `InvalidStreamRecordError` は concept.md §5.7 で定義されているため U9 ではなく U7 で管理。同じ "error 定義" というテーマで凝集

---

## § Unresolved

- `ValidationError` (既存 src/errors.ts) の扱いは本 unit のスコープ外。DEC-015 (Standard Schema) で再整理

---

## § Links

- concept.md §5.5 (canonical), §5.7 InvalidStreamRecordError
- DEC-008 構造化エラー情報
- Spike src/errors.ts (ConcurrencyError / ValidationError 実装済)
- scripts/verify-instanceof.mjs
- U6 rehydrate (InvalidEventStreamError 生成)
- U8 DynamoEventStore (EventLimitError / ConcurrencyError 生成)
- U9 Projection Bridge (InvalidStreamRecordError 生成)
- Fact: MDN Error.prototype — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error (checked: 2026-04-17)
- Fact: TS Handbook "Breaking Changes in TypeScript" (extends Error 経緯) — https://github.com/microsoft/TypeScript/wiki/FAQ#why-doesnt-extending-built-ins-like-error-array-and-map-work (checked: 2026-04-17)
