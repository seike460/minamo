# Release Playbook

minamo の release pipeline は Changesets + `changesets/action@v1` + npm Trusted Publishing (OIDC) で構成される (DEC-016)。運用ドキュメント。

## 通常 release の流れ

1. feature PR で `pnpm changeset` を実行し `.changeset/<name>.md` を含める (minor / patch を明示)
2. main に merge されると `release.yml` が走り、**Release PR** (`chore(release): version packages`) を自動生成
3. Release PR の差分を確認し merge → `release.yml` が再度走り、`pnpm run release` で npm publish (provenance 付き)
4. 公開後 `npm audit signatures` で attestation を検証 (workflow 末尾 step)

## 0.1.0-alpha.0 smoke (prod release 前に一度だけ)

`release.yml` と NPM_TOKEN / Trusted Publisher 設定が正しく繋がっているかを low-risk に検証する手順。

1. 一時 changeset を作成 (`minor` を `prerelease`、tag を `alpha` にする):
   ```bash
   pnpm changeset pre enter alpha
   pnpm changeset
   # → `.changeset/*.md` に alpha 向けの bullet を記入
   ```
2. main に merge → Release PR が `0.1.0-alpha.0` を提案
3. Release PR を merge → `pnpm publish --tag alpha --provenance` が走る
4. 以下を手動で確認:
   - `npm view @seike460/minamo@alpha` が 0.1.0-alpha.0 を返す
   - `npm view @seike460/minamo@alpha dist` に `.integrity` と `signatures` が含まれる
   - `npm audit signatures --registry https://registry.npmjs.org` が pass
   - GitHub Pages (D-06 public 化後) の URL が 200
5. `pnpm changeset pre exit` で prerelease mode を抜ける
6. 本番 `0.1.0` changeset に切替

## Human action required

- **npm Trusted Publishing の登録** (D-04): https://www.npmjs.com/settings/seike460/packages で `@seike460/minamo` パッケージに対して GitHub Actions OIDC publisher を登録する (repo = `seike460/minamo` / workflow = `release.yml` / environment 任意)
- **repo 公開 + GitHub Pages 有効化** (D-06): private → public へ変更した上で Settings → Pages → Source: GitHub Actions

## Rollback

- npm 側: `npm deprecate @seike460/minamo@<version> "broken release"` で installer に警告を表示
- v0.1.0 では unpublish しない方針 (2022 以降の npm policy に従う)

## 運用メモ — 事故防止チェックリスト

### baseline version は素の semver で維持する

`changeset version` は現在の `package.json` の `version` を起点に bump する。**baseline に prerelease suffix (例: `0.0.0-spike`, `1.0.0-alpha.0`) が残っていると、`minor` / `patch` changeset を当てても数値が bump しない**（prerelease 部分のみが消費される挙動）。

- 通常 release サイクルに戻す前に baseline を素の semver（`x.y.z`）に戻してから merge する
- `0.1.0` の bump は「baseline `0.0.0` + `minor` changeset」で実現した。spike や alpha を経由した後は `package.json` を `x.y.z` 形に戻す PR を先に merge する

### Release 前ローカル dry-run 手順

CI に任せる前に bump が意図通り走るかをローカルで確認したい場合:

```bash
# changelog 生成に GitHub token が必要
GITHUB_TOKEN=$(gh auth token) pnpm changeset version

# 期待: package.json の version が目標値に、CHANGELOG.md が生成される
git diff package.json
cat CHANGELOG.md | head -30

# 検証後、必ず元に戻す（実 release は CI に任せる）
git restore --staged --worktree package.json .changeset/
rm -f CHANGELOG.md
```

`GITHUB_TOKEN` は `@changesets/changelog-github` が PR author / commit hash を解決するために必要。CI では `changesets/action@v1` が自動注入するためこの手順は不要。
