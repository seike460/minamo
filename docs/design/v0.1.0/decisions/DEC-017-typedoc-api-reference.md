# DEC-017: Public API Reference は typedoc で自動生成し GitHub Pages で配信する

**Status**: Proposed (concept.md §11 への移送は別プロセス)
**Date**: 2026-04-17
**Related**: typedoc.json (Spike 済), .github/workflows/ (Pages deploy), concept.md §5 API Design

---

## Trigger

minamo の公開 API は concept.md §5 で型シグネチャが canonical 定義されているが、以下の課題がある:

1. **Double source of truth 問題** — concept.md の型シグネチャと src/ の実装が drift する可能性
2. **consumer の IDE 体験** — `minamo.DynamoEventStore` を import した際の hover / go-to-definition の質が TSDoc コメントの網羅性に依存
3. **public API reference の持続可能な配信** — 1 人メンテ (§12) で README に全 API を手書き維持するのは非現実的
4. **semver との整合** — 0.x → 1.0 に向けて公開 API を "固定" するには、何が公開で何が internal かを文書化された形で提示する必要がある

---

## Decision

**`typedoc` (v0.28+) で TSDoc コメントから API reference を自動生成し、GitHub Pages で配信する**。

具体運用:

1. **TSDoc comment をコード側に集約**: src/ の公開 symbol すべてに TSDoc コメントを付ける。concept.md §5 の仕様文を TSDoc 形式に展開
2. **`typedoc.json` 設定**: `entryPoints: ["src/index.ts"]`, `excludeInternal: true`, `intentionallyNotExported: ["IsTuple"]` など (Spike 期に設定済)
3. **出力先**: `docs/api/` に生成し、GitHub Pages (`gh-pages` branch or `main` + `/docs`) で配信
4. **CI 統合**: release pipeline (DEC-016 changesets flow) の一環として deploy job を追加。PR 時は typedoc build が成功することのみ検証
5. **source link**: typedoc の `sourceLinkTemplate` で GitHub の該当行にリンク (Spike 設定済)

範囲外:

- 日本語/英語 bilingual reference は **v0.1.0 では扱わない**。TSDoc comment は 1 言語で統一 (JP 優先、概念用語は英語)
- API Extractor による breaking change detection は v0.2.0 で導入 (v0.1.0.md §2 Non-Goals)

---

## Rationale

1. **source コメントから生成することで drift を排除**: concept.md § 5 と src/ 実装が canonical 一致する仕組み。TSDoc コメントは IDE でも見える = 開発者自身が "違和感があれば直す" loop に乗る
2. **consumer の DX**: `hover on DynamoEventStore` で TSDoc が見える。GitHub Pages は外部 docs サイトへの直接リンクとして README に貼れる
3. **`typedoc` は Spike 期に validate 済**: `typedoc@0.28.19` で entryPoint / intentionallyNotExported / sourceLinkTemplate が動作確認済
4. **semver 安定化への橋渡し**: 公開 API が URL 構造 (`docs/api/interfaces/EventStore.html` 等) で外部参照可能になる。0.x → 1.0 で breaking change があった箇所を diff する起点にできる
5. **GitHub Pages は 1 人メンテで維持可能**: 外部 hosting (Netlify / Vercel) への依存なし。GitHub Actions の deploy job だけで完結
6. **`excludeInternal`** により、internal と記述した型 (IsTuple 等) は自動的に reference から除外

---

## Rejected Alternatives

### (a) API Extractor (Microsoft rushstack)

- "公開 API のフラット化 + breaking change detection + multi-format docs" を単一ツールで実現
- 欠点: v0.1.0 の小さな API 表面では overkill。設定複雑度が高く、1 人メンテの保守負担
- v0.2.0 で breaking change detection が必要になったら導入検討 (v0.1.0.md §2 defer 済)

### (b) 手動 markdown で API reference を維持

- README.md に全 public symbol を手書き列挙
- drift のリスク: src/ との同期を人手で維持する負担
- 1 人メンテでは持続不可能 (§12)

### (c) concept.md §5 を API reference として配信する

- canonical だが、type-only section なので hover 体験がない
- consumer の実装コードで "DynamoEventStore を import" した時の TSDoc integration がない

### (d) TypeDoc の代わりに `tsdoc-ls` 等の LSP-based 生成

- 実現可能だが、typedoc の生成する HTML テンプレートが de-facto standard
- switch cost が高い割に利得が小さい

### (e) JSR (Deno のパッケージレジストリ) の自動 docs 配信を使う

- JSR は npm 並行公開時に auto docs を提供
- v0.1.0 は JSR dual publish は別 PR に defer (v0.1.0.md §2 Non-Goals)
- npm 単独公開時は GitHub Pages ルートが合理的

---

## Consequences

### 正

- 公開 API の drift が減る (TSDoc コメントが canonical な "hover source")
- consumer の IDE 体験向上 (hover tooltip に詳細が出る)
- GitHub Pages で永続的 URL 提供 (`https://seike460.github.io/minamo/...`)
- semver 1.0 に向けて API reference が stable URL を持つ
- CI に typedoc build を挟むことで、TSDoc 記述漏れを検出可能

### 負

- TSDoc comment を書く workload (concept.md § 5 を展開する作業が v0.1.0 実装 PR で発生)
- typedoc のテーマ (HTML / CSS) カスタマイズの手間 (デフォルトで妥協)
- GitHub Pages が down したら docs が見えない (ただし npm `.d.ts` と TSDoc は dist に含まれるため IDE 体験は維持される)
- typedoc の major version up で設定の breaking change が出る可能性 (0.28 → 1.0 等)

---

## Links

- Fact: typedoc docs — https://typedoc.org/ (checked: 2026-04-17)
- Fact: TSDoc spec — https://tsdoc.org/ (checked: 2026-04-17)
- Fact: GitHub Pages — https://docs.github.com/en/pages (checked: 2026-04-17)
- Fact: API Extractor — https://api-extractor.com/ (checked: 2026-04-17)
- Fact: Spike 期 typedoc.json 設定 (intentionallyNotExported, excludeInternal, sourceLinkTemplate)
- concept.md §5 API Design (canonical 型シグネチャ)
- v0.1.0.md §9 Exit Criteria ("typedoc の API reference が GitHub Pages に deploy")
- DEC-016 Changesets + provenance (release pipeline との統合点)
