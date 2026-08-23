# WZ操作 — リリース手順

この拡張は GitHub Actions の `.github/workflows/release.yml` からリリースします。

- Marketplace Publisher ID: `kiyoc`
- GitHub repository: `https://github.com/kiyo-c/wz-operation`
- Extension ID: `kiyoc.wz-operation`

## 通常のリリース

1. `package.json` の `version` を更新する。
2. `CHANGELOG.md` を更新する。
3. READMEその他の公開内容を確認する。
4. ローカルで `vsce package` し、生成したVSIXを実機テストする。
5. 変更を `main` へ commit / push する。
6. `package.json` と一致するタグを作成してpushする。

例: `package.json` が `0.2.2` の場合

```bash
git tag v0.2.2
git push origin v0.2.2
```

タグpushを契機にGitHub Actionsが次を自動実行します。

- `vX.Y.Z` 形式のタグか検証
- タグのバージョンと `package.json` のバージョンが一致するか検証
- VSIXを1回だけ生成
- Visual Studio Marketplaceへ同じVSIXを公開
- Open VSXへ同じVSIXを公開
- GitHub Releaseを作成
- 同じVSIXをGitHub Release assetへ添付

途中で失敗した場合にworkflowを再実行できるよう、Marketplace / Open VSXのpublishは重複バージョンを許容する設定にしています。

## GitHub Actions Secrets

### `OVSX_PAT`

Open VSXのpublish用トークンです。既存のSecretを使用します。

### `VSCE_PAT`

Visual Studio Marketplaceへのpublish用PATです。

Azure DevOpsで作成し、GitHub repositoryの
`Settings` → `Secrets and variables` → `Actions` → `New repository secret`
から、Secret名 `VSCE_PAT` として登録します。

PATは以下を満たすものを使用します。

- Organization: `All accessible organizations`
- Scope: `Marketplace` → `Manage`

> Note: Azure DevOpsのglobal PATは2026-12-01に廃止予定です。MicrosoftはMicrosoft Entra ID / workload identityによる公開へ移行中です。`@vscode/vsce` のGitHub Actions Trusted Publishing (OIDC) が安定版で利用可能になった時点で、`VSCE_PAT` をOIDCへ置き換える方針とします。

## 手動Dry Run

GitHubの `Actions` → `Release extension` → `Run workflow` を実行すると、公開せずにVSIXの生成と内容確認まで実行します。

手動Dry Runでは以下は実行しません。

- Visual Studio Marketplace publish
- Open VSX publish
- GitHub Release作成

## 公開前チェック

- `F5` / `Shift+F5` が実機で正常動作する
- `F8` / `Shift+F8` / `F9` / `Shift+F9` が実機で正常動作する
- F5バッファとF8/F9コピースタックが互いに干渉しない
- READMEの「非公式拡張」表記を維持している
- アイコンが正常に表示される
- `package.json` のversionとリリースタグが一致する
- Git working treeに意図しない変更がない
