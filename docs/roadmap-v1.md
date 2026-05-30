# Roadmap to v1.0.0

minamo を v1.0.0 に到達させるためのシーケンス計画。本書は 16 CxO ラウンドテーブル診断（2026-05-30）と、その結果採られた **「信頼性のためのスコープ拡大」** 方針に基づく。

> 軽量キューである [`docs/roadmap.md`](roadmap.md) が「個別の検討項目」を貯める場所であるのに対し、本書は **v1 到達という到達点に向けた版ごとのシーケンスと卒業条件**を定義する。確定した設計判断は `docs/concept.md` §11（DEC-018〜024）と `docs/design/v0.2.0*` に移送される。

---

## 1. 現在地（2026-05-30）

- npm `@seike460/minamo` v0.1.6 公開済み。公開 API は concept.md §5 に逐字従属し 0.1.x line で凍結。
- 品質指標: `src 1339 / test 4204 LOC`（3:1）、TODO/FIXME ゼロ、DEC-001〜015 全文書化。
- CI: biome / type-check / unit+v8 coverage / tsdown build / instanceof 不変条件 / attw+publint / typedoc(warnings-as-errors) / DynamoDB Local 統合 / CodeQL。
- リリース: changesets + npm provenance（Trusted Publishing / OIDC）。

**結論:** 宣言されたスコープ（CQRS+ES の Write 側）に対しては機能完成している。v1 を阻むのは「壊れた箇所」ではなく、①人・普及・継続性の未成熟、②ES 実務に対する機能不足（upcasting / Snapshot 欠落）の 2 点。

## 2. CxO 診断サマリ（平均健全度 ≈76 / 100）

| CxO | 健全度 | 最も鋭い指摘 |
|---|---|---|
| CEO 82 / CTO 92 / CTeO 90 / CIO 88 | 高 | 設計の芯・知識資産・テストは v1 級 |
| CISO 85 / CXO 84 / CFO 78 / COO 80 / CLO 80 | 中高 | supply chain・DX は良好。保守時間予算と運用並走が懸念 |
| CPO 76 / CRO 75 / CDO 72 / CSO 70 | 中 | frozen scope が ES 実務に機能不足（upcasting/Snapshot）。採用非推奨条件が長い |
| CMO 62 / CCO 60 / CHRO 55 | **低** | **人・普及・継続性**: bus factor=1、コミュニティ未形成、ポジショニングが埋もれている |

**横断テーマ:** コードは v1 級だが、プロジェクトとしての v1 はエコシステム面（採用実績・継続性・普及）が未成熟。

## 3. v1 の定義（拡大姿勢）

v1 は **DynamoDB + Lambda + TypeScript で CQRS+ES の Write 側を型安全かつ運用可能に実装する**ことに加え、**ES 実務で普遍的に必要となるスキーマ進化と長寿命 Aggregate を扱える**ことを含む。

**v1 in-scope に昇格（§6 Non-Goals「将来検討」から移動）:**
- **イベントスキーマ進化（upcasting）** — consumer 所有の transform hook として（DEC-020）
- **Snapshot** — EventStore とは独立した `SnapshotStore` interface として（DEC-019）

**永久スコープ外（据え置き）:** Read Model 永続化・管理 / Saga・Process Manager / CDK Construct / EventBridge Publisher / Lambda ESM 設定のラップ / 複数 DB 対応。設計姿勢（thin / strict / framework-free / AWS 非ラップ / 設計を邪魔しない）は v1 でも不変。

## 4. リリースシーケンス

すべて **additive（既存 surface への breaking change なし）** を原則とする。Phase 2 のみ retry 枯渇時の throw 型を変更するため deprecation 告知を伴う。

| 版 | テーマ | 主要項目 | exit criteria |
|---|---|---|---|
| **v0.2.0** | DX + 観測性の土台 | `createCommandRunner` / `createEventStoreTable` facade / `ExecuteObserver` hooks / `NoInfer<TInput>` / API Extractor gate / coverage 閾値 / README pitch | 既存 surface 非破壊・API gate 稼働・facade の TMap narrowing 型テスト pass |
| **v0.2.0**(同梱) | retry 観測性 | `RetryExhaustedError { cause, attempts }`（旧: 生 ConcurrencyError throw を deprecation） | instanceof 検証 / 既存 retry テスト更新 / R13 設計-実装乖離の解消 |
| **v0.3.0** | スキーマ進化 | `AggregateConfig.upcast` hook（`Upcaster<TMap>`） | rehydrate が upcast → 検証 → evolve 順で動作・upcast 未指定は非破壊 |
| **v0.4.0** | 長寿命 Aggregate | `SnapshotStore` / `InMemorySnapshotStore` / `DynamoSnapshotStore` / `EventStore.loadFrom?` / `executeCommand` snapshot 統合 | Snapshot Contract Test が InMemory/Dynamo 両方 green・rehydration コスト削減を assert |
| **v1.0.0** | 凍結 | （新規機能なし。API 凍結と保証の明文化） | §5 卒業条件を全充足 |

## 5. 1.0.0 卒業条件

§12 の「3 マイナーリリース以上安定」は **「既存 surface への breaking change なしで 3 マイナーを積む」** と解釈する（additive 追加は安定性と矛盾しない。DEC-024）。

- [ ] v1 in-scope の Open Questions が全解決（OQ-1 Snapshot / OQ-2 upcasting は v0.3/v0.4 で決着）
- [ ] **additive な 3 マイナー（v0.2 / v0.3 / v0.4）が breaking change なしで安定**
- [ ] API Extractor gate が CI で稼働し、surface 差分が常にレビューされる
- [ ] **外部本番採用 ≥1 件、または実質的な公開ケーススタディ 3 件**（dog-fooding 1 件のみでは不十分）
- [ ] **co-maintainer ≥1 名の獲得**（bus factor=1 の解消。CHRO 卒業条件）

> **コードと 1.0.0 タグの区別:** 本ロードマップの v0.2〜v0.4 で **v1 の全機能は実装される**。ただし 1.0.0 タグは上記の非コード条件（3 マイナー安定 / 外部採用 / co-maintainer）の充足後に押す。機能実装の完了 ≠ 1.0.0 リリース。

## 6. CxO 議論の裁定と少数意見

**裁定済みの対立軸:**

| 対立軸 | 裁定 |
|---|---|
| thin 死守 vs 信頼性のため拡大 | upcasting は consumer 所有の hook、Snapshot は別 interface とし、**実装エンジン化を避ける**ことで thin 原則と両立 |
| v1 基準の自己矛盾 | additive 解釈で明確化（DEC-024） |
| bus factor vs 機能速度 | 全項目に「1 人で永久保守できるか」ゲート。co-maintainer 獲得を卒業条件に格上げ |
| 採用実績 | 外部採用 / 公開ケーススタディを卒業条件に追加 |

**記録された少数意見（dissent）:**

- **CFO / CTO:** `createEventStoreTable` facade は per-Aggregate `TMap` narrowing を隠すリスク（roadmap.md 既出）。型テスト（`expectTypeOf`）で narrowing 保持を gate しない限り採用に反対。→ Phase 1 で型テストを必須化することで条件付き合意。
- **CTO:** Snapshot は実運用で rehydration コスト閾値超過が実測されるまで YAGNI。→ minamo は **機構（policy を consumer が指定）のみ**提供し、閾値を強制しない形で折衷。
- **CISO:** ロードマップが何であれ、1 人メンテのセキュリティ応答はエンタープライズ SLA を満たせない。これは「直す」ものではなく「声高に明示し続ける」もの。→ SECURITY.md / §12 の SLA なし明記を維持。

## 7. post-v1（据え置き）

- **Global Tables 対応**（OQ-7）— 単一リージョン前提を維持。需要が確認されたら検討。
- **backoff / jitter retryStrategy**（DEC-012 / OQ-5）— 即時リトライの限界が実運用で確認されたら `executeCommand` のオプションとして追加。
- **OpenTelemetry 統合**（実装ではなく hook のみ提供。`ExecuteObserver` を consumer が OTel に配線）。

---

Last reviewed: 2026-05-30（CxO ラウンドテーブル診断に基づき新規作成）。
