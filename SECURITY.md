# Security Policy

minamo は 1 人メンテナンス (`@seike460`) の OSS ライブラリで、production SLA は提供しません。本ドキュメントは脆弱性の私的報告経路を定義するものです (GitHub community standards / OpenSSF baseline)。

## Supported Versions

v0.x は開発中であり、**最新 minor のみ** セキュリティ修正を受けます。`0.1.0` 以前は public release が存在しないため対象外です。

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

GitHub の **Private Vulnerability Reporting** を利用してください。公開 Issue / Pull Request で脆弱性を共有しないでください。

- 報告窓口: <https://github.com/seike460/minamo/security/advisories/new>
- 代替: `security@` ではなく上記 advisory 経路のみサポート
- PGP は未導入

報告に含めてほしい情報:

- 影響を受ける minamo の version / commit
- 再現手順 (最小 reproducer があると理想)
- 想定される影響範囲 (confidentiality / integrity / availability)
- 可能であれば提案する mitigation

## Response SLO

1 人メンテ体制のため best-effort です。

- **Acknowledge**: 7 days 以内に受領連絡
- **Triage & fix plan**: 30 days 以内
- **Coordinated disclosure**: 修正 release 後に GitHub Security Advisory を publish

Critical 相当の場合はより早く対応しますが、業務都合で遅延する可能性があります。緊急度が高い場合は report 本文にその旨を明記してください。

## Scope

- `src/` 配下の公開 API (`docs/concept.md` §5 に列挙)
- `release.yml` / npm provenance pipeline
- 依存 package の既知脆弱性 (peer dependency `@aws-sdk/*` を含む)

Scope 外:

- consumer 側で実装する Read Model / Projection Lambda のセキュリティ
- AWS アカウント側の IAM / DynamoDB 設定
- 本リポジトリの fork やミラー
