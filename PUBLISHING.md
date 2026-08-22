# WZ操作 0.2.0 — Marketplace公開手順

このソースは Visual Studio Code Marketplace 公開用に `publisher: kiyoc` で準備済みです。

GitHubアカウントは `kiyo-c` を使用します。

- Marketplace Publisher ID: `kiyoc`
- GitHub repository: `https://github.com/kiyo-c/wz-operation`

## 1. Publisher ID `kiyoc` を作成

Visual Studio Marketplace の publisher management で Publisher を作成します。

- Publisher ID: `kiyoc`
- Publisher Name: 任意（例: `kiyoc`）

**Publisher ID は作成後に変更できません。** また、Marketplace上で既に使用されているIDは取得できません。

## 2. GitHubリポジトリを用意

GitHubアカウント `kiyo-c` 側に `wz-operation` リポジトリを作成します。

```text
https://github.com/kiyo-c/wz-operation
```

`package.json` の repository / homepage / bugs はこのURLに設定済みです。

## 3. vsce を用意

```bash
npm install -g @vscode/vsce
```

## 4. パッケージ確認

リポジトリ直下で実行します。

```bash
vsce package
```

`wz-operation-0.2.0.vsix` が生成されます。

## 5. 公開

方法A: MarketplaceのPublisher管理画面からVSIXをアップロード。

方法B: `vsce login kiyoc` 後にCLIから公開。

```bash
vsce login kiyoc
vsce publish
```

## 公開前チェック

- MarketplaceでPublisher ID `kiyoc` を取得済みか
- GitHub `kiyo-c/wz-operation` を作成済みか
- `F5` / `Shift+F5` が実機で正常動作するか
- `F8` / `Shift+F8` / `F9` / `Shift+F9` が実機で正常動作するか
- F5バッファとF8/F9コピースタックが互いに干渉しないか
- READMEの「非公式拡張」表記を維持しているか
- バージョンが `0.2.0` であるか

## 拡張ID

公開後の拡張IDは次になります。

```text
kiyoc.wz-operation
```
