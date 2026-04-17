# DEC-015: Standard Schema v1 を validator 境界として採用する

**Status**: Proposed (concept.md §11 への移送は別プロセス)
**Date**: 2026-04-17
**Related**: U3 Command, src/standard-schema.ts (Spike 済), src/validation.ts (Spike 済)

---

## Trigger

minamo の `CommandHandler` は決定的・副作用なし・再試行安全 (DEC-005) であり、非同期バリデーションを handler 内で行うことは禁じられている。一方、Command 実行前に input を検証する需要は普遍的に存在する (DTO validation、境界検証)。minamo が特定の validation library (Zod / Valibot / ArkType) に hard dependency を持つと:

1. consumer の既存 validation stack を強制置換することになる
2. library 自体の breaking change に minamo が引きずられる
3. C2 "runtime dep は AWS SDK v3 peer のみ" に反する

ライブラリ非依存で validation を受け入れる interface が必要になる。

---

## Decision

**Standard Schema v1 interface (`StandardSchemaV1<Input, Output>`) を validator 境界として採用する**。minamo は以下を提供する:

1. `StandardSchemaV1` interface 型 (types-only)
2. `validate<S extends StandardSchemaV1>(schema, value): Promise<InferSchemaOutput<S>>` helper
3. `ValidationError` class (validate 失敗時に throw)

Spike 期 (src/standard-schema.ts, src/validation.ts, src/errors.ts) で既に実装済。v0.1.0 ではこれを公開 API として継続する。

**範囲外**:

- minamo は特定の validation library に runtime 依存しない
- `@standard-schema/spec` npm パッケージへの dep も **追加しない** (interface を自前で定義)。consumer が `@standard-schema/spec` を使う実装 (Zod v3.24+, Valibot v1.0+, ArkType 等) を自由選択する
- executeCommand が自動で input を validate する機構は **提供しない**。consumer が executeCommand 呼び出し前に `await validate(schema, raw)` する

---

## Rationale

1. **"AWS のプリミティブをラップしない" と同じ思想** (concept.md §4, DEC-014): validation ライブラリも "利用者が選択する ecosystem primitive"。minamo は境界を提供し、実装を強制しない
2. **Standard Schema v1 は 2025 年に安定化** (Fact: Valibot v1.0, Zod 3.24+ が採用): 複数の主要 validator が既に conformant。ベンダーロックを作らず実質的な選択肢を失わない
3. **types-only 依存**: `@standard-schema/spec` への runtime 依存を持たず、`~standard` の shape だけを minamo 自前で定義。C2 (runtime dep AWS SDK only) を守る
4. **`validate()` helper の提供は consumer の DX 向上**: sync / async schema の分岐を一本化 (`Promise<Output>` を常に返す)
5. **`ValidationError` で structured 例外**: consumer は try/catch で `instanceof ValidationError` 判定できる。`issues: readonly StandardSchemaIssue[]` が diagnostic を提供

---

## Rejected Alternatives

### (a) Zod hard dependency

- concept.md §4 の「runtime 依存は AWS SDK v3 のみ」原則に反する
- Zod の major version up に追従する保守負債
- 利用者が Valibot / ArkType を選ぶ自由を奪う

### (b) 独自 validator DSL

- Standard Schema v1 以前であれば選択肢だったが、2025 安定化後に **車輪の再発明**
- minamo のスコープ (CQRS+ES の Write 側) から大きく外れる (DEC-014 同じ思想)

### (c) `@standard-schema/spec` npm を peer dep にする

- interface 型だけで十分。npm package を挟むと minor version drift で type 不整合が起きる
- minamo 側で interface を自前定義し、consumer の spec package と structural typing で一致させる方が堅牢
- Fact: TypeScript structural typing により同名 brand symbol (`~standard`) を持つ object は interchangeable

### (d) executeCommand 内に validation を組み込む

- handler は既に pure-sync (DEC-005)。validation 結果を handler に渡す必要がある場合、executeCommand の signature を肥大化させる
- `await validate(schema, raw)` を consumer 側 call chain で行うほうが責務分離が明確

### (e) ValidationError を Standard Schema issues 生のまま throw せず wrap する

- 既に Spike で採用済の pattern だが、ValidationError に custom class を設けることで `instanceof` 判定と logger/OTel 統合が簡単になる
- 生の issues array を throw すると consumer は TypeError vs Standard Schema failure を識別できない

---

## Consequences

### 正

- consumer は Zod / Valibot / ArkType のいずれでも minamo と統合できる
- validation stack の switching cost が minimal (schema を差し替えるだけ)
- minamo の runtime dependency footprint を AWS SDK v3 のみに維持できる (C2)
- `ValidationError.issues` が structured error path を提供 (DEC-008 同一思想)

### 負

- consumer が schema を提供しない場合、minamo 側で input 検証が行われない → runtime type mismatch は handler 内で明示的に防ぐ必要
- Standard Schema v1 spec が major version up した場合、minamo の interface も追従が必要 (ただし spec は後方互換を重視)
- `@standard-schema/spec` とは structural typing で一致させるが、spec の internal field (`~standard.vendor`, `~standard.version` 等) が変わると breaking

---

## Links

- Fact: Standard Schema v1 spec — https://standardschema.dev/ (checked: 2026-04-17)
- Fact: Zod v3.24+ `~standard` 対応 — https://zod.dev/ (checked: 2026-04-17)
- Fact: Valibot v1.0 `~standard` 対応 — https://valibot.dev/blog/valibot-v1-the-1-kb-schema-library/ (checked: 2026-04-17)
- Fact: TypeScript structural typing — https://www.typescriptlang.org/docs/handbook/type-compatibility.html (checked: 2026-04-17)
- DEC-005 handler の決定性・純粋性
- DEC-014 AWS プリミティブ非ラップ (validator library にも適用する類比)
- C2 runtime dependency constraint
- U3 Command (validation 呼び出し箇所の responsibility 明示)
- Spike 実装: src/standard-schema.ts, src/validation.ts, src/errors.ts (ValidationError)
