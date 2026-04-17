# Contributing to minamo

Thanks for your interest! minamo は 1 人メンテ ([@seike460](https://github.com/seike460)) の設計中心 OSS で、PR / Issue を歓迎します。大きな変更は議論してから着手してください。

## Ground rules

- minamo の公開 API は [`docs/concept.md`](docs/concept.md) §5 に **逐字従属** する。API 変更は concept / DEC 更新を伴う
- 新 runtime 依存は追加しない (AWS SDK v3 のみ、optional peer)
- ESM only / Node ≥ 24 / TypeScript strict + `verbatimModuleSyntax`
- Conventional Commits (`feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:`)
- 日本語 / 英語どちらの PR 説明文も OK

## Local setup

```bash
pnpm install
pnpm run type-check
pnpm run lint
pnpm run test
pnpm run build
pnpm run check-exports      # attw + publint
```

DynamoDB Local を使う integration tests:

```bash
docker compose up -d dynamodb
pnpm run test:integration
```

## Change workflow

1. Issue または discussion で合意
2. feature branch を切り実装 (test-first を推奨、Contract Tests 対象の変更は InMemory/Dynamo 両方で green)
3. `pnpm changeset` で changeset を追加 (`minor` / `patch` を選択)
4. PR を開く。CI (lint / type-check / unit / build / attw + publint / typedoc / integration / CodeQL) が全て green であること
5. review → merge 後、`changesets/action` が Release PR を自動生成

## Releases

詳細は [`RELEASE.md`](RELEASE.md) を参照。

- `main` に merge された changeset が Release PR に集約される
- Release PR merge → npm provenance 付きで publish (Trusted Publishing / OIDC)
- `npm audit signatures` で post-publish smoke

## Security

脆弱性は GitHub Private Vulnerability Reporting で報告してください ([`SECURITY.md`](SECURITY.md))。

## License

Contribution を submit することで、あなたの貢献が [MIT License](LICENSE) でライセンスされることに同意したものとみなします。
