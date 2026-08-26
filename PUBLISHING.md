# WZ Keymap — リリース手順

この拡張は、Visual Studio Marketplace と GitHub Release は手動、Open VSX は GitHub Actions の手動実行で公開します。

- Marketplace Publisher ID: `kiyoc`
- GitHub repository: `https://github.com/kiyo-c/wz-operation`
- Extension ID: `kiyoc.wz-operation`

## 通常のリリース

1. `package.json` の `version` を更新する。
2. `CHANGELOG.md` を更新する。
3. READMEその他の公開内容を確認する。
4. リポジトリ直下で `npx --yes @vscode/vsce package` を実行する。
5. 生成された `wz-operation-X.Y.Z.vsix` を VS Code に「VSIXからインストール」して実機テストする。
6. Visual Studio Marketplace の Publisher 管理画面で既存拡張の `Update` から同じVSIXをアップロードする。
7. GitHub の `Actions` → `Publish to Open VSX` → `Run workflow` を実行する。
8. GitHub Releases で `vX.Y.Z` を作成し、同じVSIXをRelease assetとして添付する。

## Open VSX

`.github/workflows/publish-open-vsx.yml` は `workflow_dispatch` のみで起動します。

GitHub Secret `OVSX_PAT` を使用して、現在の `main` の `package.json` に記載されたバージョンを Open VSX へ公開します。

## Visual Studio Marketplace

Visual Studio Marketplace は Publisher 管理画面からVSIXを手動アップロードします。

Marketplace公開用のPAT、Azure DevOps、OIDC認証は現在使用しません。

## GitHub Release

GitHub Release は手動で作成します。

- Tag: `vX.Y.Z`
- Release title: `vX.Y.Z`
- Asset: `wz-operation-X.Y.Z.vsix`

VSIXはGit管理対象にしません。`.gitignore` の `*.vsix` で除外します。

## 公開前チェック

- `F5` / `Shift+F5` が実機で正常動作する
- 初回起動時またはDeveloper: Reload Window直後、F5で取得したキーワードが最初のF6/F7でも検索欄へ入る
- `F8` / `Shift+F8` / `F9` / `Shift+F9` が実機で正常動作する
- WindowsでIMEをONにしてShift+カーソルで複数行を選択したあと、`F8` が選択範囲全体を切り取る
- `wzOperation.keyboard.turnImeOffWhenSelectionStarts` の有効・無効が即時反映される
- VSIXに `native/ime-off-helper.c`、`native/ime-off-helper-x64.exe`、`native/ime-off-helper-x86.exe`、`native/ime-off-helper-arm64.exe`、`native/README.md` が収録されている
- F5バッファとF8/F9コピースタックが互いに干渉しない
- READMEの「非公式拡張」表記を維持している
- アイコンが正常に表示される
- `package.json` のversionが公開予定バージョンと一致する
- Git working treeに意図しない変更がない
