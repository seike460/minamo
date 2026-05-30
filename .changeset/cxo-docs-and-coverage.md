---
"@seike460/minamo": patch
---

ドキュメントの鮮度更新と開発ツールの整備。本体 API は変更なし。

- README (英日) の Status 表記を版固定しない表現に更新し、CI status バッジを追加。`CLAUDE.md` の phase 記述を実態 (Released / v0.1.x maintenance) に合わせ、DynamoEventStore 実装済みの事実を反映。
- vitest の coverage 計測 (`@vitest/coverage-v8`) を導入し、CI の unit test を coverage 付きに。型のみファイルは計測対象から除外。
- `docs/concept.md` §7 Alternatives を再検証し最新化 (castore は core/adapter とも v2.4.2、@ocoda は v3.0.0)。事実が変わった差別化論点を「DynamoDB 専用設計 vs マルチ adapter」という構造的な軸に再構成。
- `biome.json` の `$schema` を導入済み biome バージョンに同期。`CONTRIBUTING.md` に dependabot 運用フローを明記。

npm tarball (`files: ["dist"]`) には影響しない docs + tooling の変更。
