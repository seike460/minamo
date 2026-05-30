# DEC-018: v1 スコープを「信頼性のため拡大」する

**Status**: Accepted（CxO ラウンドテーブル 2026-05-30 / plan 承認済み）
**Date**: 2026-05-30
**Related**: concept.md §6, §11 DEC-018〜024, docs/roadmap-v1.md, DEC-006, DEC-014

---

## Trigger

16 CxO ラウンドテーブル診断（平均健全度 ≈76）で、CPO / CRO / CDO / CSO が一致して次を指摘した:

- frozen scope は「正しく動く Write 側」として機能完成しているが、**イベントスキーマ進化（upcasting）と Snapshot を欠く**ため、§8 の「v1 採用非推奨条件」6 項目のうち 2 つ（長寿命 Aggregate / 頻繁なスキーマ変更）が実質的な利用障壁になっている
- ES 実務でスキーマ進化と長寿命 Aggregate は普遍的に発生するため、これらを欠いたまま v1 を凍結すると「実務で使えない v1」になる

一方 CTO / CFO は「Snapshot/upcasting エンジンを内蔵すると DEC-006/014 が崩れ、1 人メンテで保守不能」と反論した。

---

## Decision

**v1 のスコープを拡大し、upcasting と Snapshot を v1 in-scope に昇格する。** ただし拡大は次の制約下で行う:

1. **upcasting は consumer 所有の transform hook**（`AggregateConfig.upcast`）として提供し、minamo は upcaster エンジンを持たない（DEC-020）
2. **Snapshot は EventStore と独立した `SnapshotStore` interface**として提供し、閾値は consumer が指定、minamo は機構のみ提供する（DEC-019）
3. 永久スコープ外（Read Model 管理 / Saga / CDK / EventBridge / 複数 DB）と設計姿勢（thin / strict / framework-free / AWS 非ラップ）は不変

詳細な API は concept.md §5.10（Snapshot）/ §5.11（Upcasting）、シーケンスは docs/roadmap-v1.md。

---

## Rationale

1. **採用障壁の除去**: §8「採用非推奨条件」のうち機能起因の 2 項目を解消し、ES 実務での実用性を v1 水準に引き上げる
2. **thin 原則との両立**: 「実装エンジン」ではなく「hook / interface」に留めることで、保守対象を最小化し 1 人メンテでも持続可能（DEC-019/020 が具体策）
3. **DEC-006 との整合**: SnapshotStore を別 interface にすることで EventStore の最小契約（Contract Tests のための汎用性）を汚さない
4. **DEC-014 との整合**: upcasting transform は「ドメイン固有ロジック」であり、AWS プリミティブをラップしないのと同じ思想で consumer に委ねる
5. **CTO dissent への折衷**: Snapshot は閾値を強制せず policy を consumer が指定する機構のみ提供。実測前の YAGNI 懸念に対し「使いたい人だけが使う optional 機構」とする

---

## Rejected Alternatives

### (a) thin 死守（Snapshot/upcasting を post-v1 据え置き）
- ES 実務の壁が残り、CPO/CRO/CDO の「実務で v1 と呼べない」懸念が解消しない
- 「採用非推奨条件」が長いまま固定され、市場リスク（§8）が増大

### (b) @ocoda 型の包括フレームワーク化（Read 側 / Saga まで内蔵）
- DEC-013/014 と正面から矛盾。1 人メンテで保守不能
- minamo の差別化（DynamoDB-first / thin / framework-free）を失う

### (c) Snapshot/upcasting を DynamoEventStore 内部に隠蔽
- InMemory でテストできず、§1 痛み C（InMemory と本番の振る舞い差異）を再発させる
- DEC-006/019 違反

---

## Consequences

### 正
- ES 実務での実用性が v1 水準に到達（長寿命 Aggregate / スキーマ進化に対応）
- 拡大しても EventStore の最小契約は不変で、snapshot/upcast 不要な consumer は影響を受けない
- 全機能が InMemory/Dynamo Contract Tests でカバーされる

### 負
- 公開 surface が増え、保守対象が拡大する（API Extractor gate / DEC-024 で drift を機械検出して緩和）
- §6 Non-Goals と DEC-006/014 の前提を amend するため、過去の設計判断との関係を本 DEC で明示し続ける必要がある
- Snapshot 統合は executeCommand / rehydrate / 両 store / Contract Test に跨る最も複雑な追加（U16〜U18）

---

## Links

- concept.md §6（v1 in-scope 昇格表）, §11 DEC-019〜024
- docs/roadmap-v1.md（リリースシーケンスと 1.0.0 卒業条件）
- DEC-006（EventStore interface 汎用維持）— SnapshotStore を別 interface にする根拠
- DEC-014（AWS プリミティブ非ラップ）— upcasting を consumer hook にする類比
- Fact: Event Sourcing の upcasting 必要性 — https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing (checked: 2026-05-30)
