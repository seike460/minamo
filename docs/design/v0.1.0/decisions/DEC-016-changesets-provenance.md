# DEC-016: Release は Changesets + npm provenance で行う

**Status**: Proposed (concept.md §11 への移送は別プロセス)
**Date**: 2026-04-17
**Related**: §12 OSS Expectations, .changeset/ (Spike 済), .github/workflows/

---

## Trigger

minamo は OSS パブリック npm パッケージとして公開される予定である。1 人メンテ (§12) の持続可能な release 運用として、以下を同時に満たす必要がある:

1. **SemVer の誤りを防ぐ機構** — breaking change / minor / patch の誤判定が起きない運用
2. **Supply chain 信頼性** — 利用者が `minamo@0.1.0` を install した際に "公式 GitHub repo で build されたもの" を暗号学的に検証可能にする
3. **CHANGELOG の自動生成と PR トレース** — "何が変わったのか" を人手で書かずに正確に記録
4. **1 人メンテのトイル最小化** — release のたびに版管理や changelog 整備に時間を割く運用は持続不可能

従来の "手動 `npm version` + 手動 `npm publish`" や semantic-release (コミットメッセージ駆動) はそれぞれ以下の欠点がある:

- 手動: human error で semver を誤る。CHANGELOG が後回しになる
- semantic-release: コミットメッセージの厳密性に依存し、reviewable な "release intent" が PR に残らない

---

## Decision

**Changesets (`@changesets/cli` + `@changesets/changelog-github`) + GitHub Actions OIDC による npm provenance** を release ツールチェーンに採用する。

具体的に:

1. **Changesets 運用**: 機能変更 PR 内で `pnpm changeset` を実行し、`.changeset/*.md` に "変更種別 (major/minor/patch) + human description" を記録する
2. **Version bump PR**: main ブランチに merge された changesets を GitHub Actions が集約し、"version-packages" PR を自動生成 (version bump + CHANGELOG 更新)
3. **npm publish**: version-packages PR が merge されたら GitHub Actions が `pnpm publish --provenance` を実行
4. **Trusted Publishing (OIDC)**: npm registry 側で GitHub Actions workflow を trusted publisher として登録。npm access token を長期保持しない
5. **CHANGELOG**: `@changesets/changelog-github` で PR リンクを自動挿入

---

## Rationale

1. **PR に release intent が残る**: `.changeset/*.md` は PR レビュー対象になる。"なぜ minor なのか" が review コメントと一緒に残り、後から git blame できる
2. **CHANGELOG は自動生成 + human description の組合せ**: 機械的な "what" と、人が書く "why" が両立。semantic-release 単独では "what" しか生成できない
3. **npm provenance の supply-chain value**: SLSA v1.0 準拠の provenance attestation が npm registry 側に記録され、利用者が `npm audit signatures` で検証可能 (Fact: npm provenance)
4. **Trusted Publishing で secret 管理を排除**: npm automation token を GitHub Secrets に保持する従来 pattern を廃止。OIDC federation で workflow が直接 publish
5. **Spike 期に既に採用済**: `.changeset/config.json` が存在し、`pnpm changeset` コマンドが動作する baseline がある
6. **1 人メンテの持続可能性** (§12): changeset を PR で強制する運用は、レビュー時に自動で semver チェックが入る。メンテナが release 作業を忘れてもコードは `.changeset/*.md` から再生産できる

---

## Rejected Alternatives

### (a) semantic-release

- コミットメッセージ (`feat:`, `fix:` 等) から semver を推論
- 欠点: 同じ PR 内に複数種の変更があると semver が誤判定。"BREAKING CHANGE:" フッタを書き忘れると major が missed される
- CLI driven でない: release 手順が blackbox になり、1 人メンテでも手順把握が難しい
- CHANGELOG に PR リンクを自動挿入する仕組みが弱い

### (b) 手動 `npm version` + 手動 `npm publish`

- human error リスク: 1 回の誤 semver (e.g., breaking change を patch にする) で全 consumer に波及
- CHANGELOG を手書きで維持する負担
- provenance attestation を手動で付けるのは非現実的

### (c) release-please (Google)

- Conventional Commits + release PR 方式で Changesets に近い思想
- ただし機能は mono-repo 前提の色が強く、npm package 単体の minamo には Changesets の方が fit
- Changesets は TS エコシステムで de-facto standard に近い (pnpm / Turbo / Prisma ecosystem で採用実績)

### (d) `npm publish --provenance` を使わない (provenance opt-out)

- supply chain attack リスクを consumer に引き受けさせることになる
- 2024-2025 の npm ecosystem では provenance が de-facto 推奨 (Fact: GitHub Blog)
- opt-in のコストがほぼゼロ (`--provenance` flag と OIDC 設定のみ)

### (e) GitHub Secrets で npm token を保持 (legacy pattern)

- token 漏洩リスク
- 定期的な rotation 負担
- Trusted Publishing GA (2025-07) で alternative が実現

---

## Consequences

### 正

- PR レビュー時点で semver 判定が明示される
- CHANGELOG.md が自動生成され、PR ごとの変更が追跡可能
- npm registry 上で provenance attestation が publicly verifiable
- npm automation token を GitHub Secrets に保持不要
- supply chain attack への防御層 (malicious publish 検知)
- メンテナが release 作業を忘れても、`.changeset/*.md` が PR 時点で既に揃っているため、次回 release 時に一括処理可能

### 負

- `.changeset/*.md` を書く作業が PR ごとに発生 (強制するなら bot で fail する hook が必要)
- Trusted Publishing は GitHub Actions のみ対応 (self-hosted runner / GitLab CI では追加設定が必要)
- 初回設定で npm registry 側に trusted publisher を登録する手間 (1 回のみ)
- Changesets の mental model (changeset = 変更意図の宣言) を新規 contributor が学ぶ必要

---

## Links

- Fact: Changesets CLI — https://github.com/changesets/changesets (checked: 2026-04-17)
- Fact: npm provenance GA — https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/ (checked: 2026-04-17)
- Fact: npm Trusted Publishing GA 2025-07 — https://docs.npmjs.com/trusted-publishers (checked: 2026-04-17)
- Fact: SLSA v1.0 provenance spec — https://slsa.dev/spec/v1.0/distributing-provenance (checked: 2026-04-17)
- Fact: `pnpm publish --provenance` — https://pnpm.io/cli/publish (checked: 2026-04-17)
- concept.md §12 OSS Expectations (SemVer, API 安定性)
- v0.1.0.md §9 Exit Criteria ("npm provenance 付き publish")
- Spike: .changeset/config.json
- DEC-014 AWS プリミティブ非ラップ (同じ "利用者が ecosystem を選ぶ" 原則)
