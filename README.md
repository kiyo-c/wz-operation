# WZ Operation

[English](#english) | [日本語](#日本語)

<a id="english"></a>

## English

**WZ Operation** is a VS Code extension that provides keyboard operations inspired by the feel of WZ Editor.

> **This is an unofficial extension.** It is not affiliated with the developers or distributors of WZ Editor.

It recreates a selection of the efficient keyboard operations long available in WZ Editor, providing a comfortable key-driven editing workflow in VS Code.

Frequently used operations are assigned to familiar function keys, reducing them to a small number of keystrokes.

### Key bindings

| Key | Operation |
| --- | --- |
| `F5` | Capture a keyword and add the next match to the selection |
| `Shift+F5` | Paste the keyword captured with F5 |
| `F8` | Cut the selection and push it onto the copy stack; use the current line when there is no selection |
| `Shift+F8` | Copy the selection and push it onto the copy stack |
| `F9` | Paste the top stack item and remove it from the stack |
| `Shift+F9` | Paste the top stack item without removing it from the stack |

The `F5` keyword buffer and the `F8` / `F9` copy stack are **completely separate storage areas**.

### F5 / Shift+F5 — Keyword operations

#### F5 — Capture a keyword and select the next match

Pressing `F5` runs VS Code's built-in `editor.action.addSelectionToNextFindMatch` command.

The keyword selected by that operation is also stored in the dedicated **F5 buffer**.

This preserves the convenience of VS Code's standard “Add Selection to Next Find Match” operation while allowing the captured keyword to be reused later.

#### Shift+F5 — Paste the captured keyword

Pressing `Shift+F5` inserts the keyword most recently captured with `F5` at the current position.

If the selection created by `F5` is still active, it is cleared and the keyword is inserted immediately after it. Otherwise, an existing selection is replaced. With multiple cursors, the same keyword is inserted at every cursor.

### F8 / Shift+F8 — Copy and cut

These bindings follow the WZ Editor key layout.

- `F8`: Push the selected range onto the copy stack and **cut** it. With no selection, cut the current line.
- `Shift+F8`: Push the selected range onto the copy stack and **copy** it.

Text is stored in the extension's own text stack, separately from the operating system clipboard.

### IME behavior on Windows

On Windows, the extension turns the IME off once when a keyboard or mouse text selection starts. This prevents an enabled IME from consuming function keys such as `F8` for reconversion before VS Code can invoke this extension.

The extension waits until Shift, Ctrl, Alt, and Windows keys are released, then sends the standard Windows **IME Off** key only while the same window remains in the foreground. It does not install a low-level keyboard hook or select a particular IME product.

For this Windows-only operation, the extension starts a bundled native helper while it is active. The helper receives only fixed control commands—never selected text—uses no network communication, telemetry, or elevation, and checks only whether modifier keys are currently held without recording keystrokes. Its source code and reproducible build command are included in [`native/`](native/README.md).

This behavior is enabled by default and can be changed in VS Code Settings:

- **Turn IME Off When a Selection Starts** (`wzOperation.keyboard.turnImeOffWhenSelectionStarts`)

If you want to replace selected text by typing Japanese immediately, turn the IME on again after selecting the text, or disable this setting. The setting has no effect outside Windows.

If the helper cannot start, the status bar reports that automatic IME-off is unavailable; the other extension commands remain available. Turn the setting off and on to retry.

### F9 / Shift+F9 — Paste from the stack

- `F9`: Paste the top stack item and **remove it from the stack**.
- `Shift+F9`: Paste the top stack item and **keep it on the stack**.

For example, after copying `AAA`, `BBB`, and `CCC` in that order, `CCC` is at the top of the stack.

Pressing `Shift+F9` repeatedly continues to paste `CCC`. Pressing `F9` pastes and removes `CCC`, so the next `F9` pastes `BBB`.

### Separate F5 buffer and copy stack

The `F5` / `Shift+F5` keyword buffer and the `F8` / `Shift+F8` / `F9` / `Shift+F9` copy stack are **completely independent**.

A keyword captured with F5 never enters the F8/F9 history, and F8/F9 copy contents never overwrite the F5 keyword.

Neither dedicated buffer uses the operating system clipboard.

### Copy-stack capacity and lifetime

By default, the copy stack retains up to **64 MiB** of text in total, calculated as UTF-16. The default limit for one item is **16 MiB**.

These limits can be changed in VS Code Settings. The setting names are localized to the current VS Code display language:

- **Maximum Total Copy-Stack Size** (`wzOperation.copyStack.maxTotalSizeMiB`)
- **Maximum Copy-Stack Item Size** (`wzOperation.copyStack.maxItemSizeMiB`)

If the per-item limit is greater than the total limit, the total limit becomes the effective per-item limit.

When the total limit is exceeded, the oldest items are discarded automatically. If selected text exceeds the per-item limit, neither copying nor cutting is performed.

For multiple-cursor pastes, the extension checks the logical data size by multiplying the item size by the number of cursors. A paste is not performed if one operation would exceed the configured **maximum total copy-stack size**.

**The stack is currently volatile and kept only in memory.** Both the F5 buffer and copy stack are cleared when the VS Code Extension Host restarts.

### Existing keybindings.json entries

If the same keys are already assigned in your user settings, those definitions may take precedence over this extension.

If you previously configured the `F5`, `F8`, or `F9` key families manually, comment out or remove those entries as needed.

Example:

```json
{
  "key": "f5",
  "command": "editor.action.addSelectionToNextFindMatch",
  "when": "editorTextFocus"
}
```

### Compatibility

- Visual Studio Code `1.90.0` or later
- Windows / macOS / Linux

### Display languages

Command names, setting names and descriptions, and status-bar messages follow the VS Code display language.

- English
- Japanese

Other display languages fall back to English.

### Command Palette

To change the keybindings, assign any keys to the following commands:

- `WZ Operation: Capture Keyword and Select Next Match`
- `WZ Operation: Paste Captured Keyword`
- `WZ Operation: Cut Selection to Copy Stack`
- `WZ Operation: Copy Selection to Copy Stack`
- `WZ Operation: Paste and Consume from Copy Stack`
- `WZ Operation: Paste from Copy Stack`

### Source code and issues

- GitHub: https://github.com/kiyo-c/wz-operation
- Issues: https://github.com/kiyo-c/wz-operation/issues

The Marketplace Publisher ID is `kiyoc`, and the GitHub account is `kiyo-c`.

### License

MIT License

---

<a id="日本語"></a>

## 日本語

**WZ操作** は、WZ Editorの操作感に着想を得たキーボード操作を実現する拡張機能です。

> **非公式拡張です。** 本拡張は WZ Editor の開発元・販売元とは関係ありません。

WZ Editorで長年使われてきた効率的なキーボード操作の一部をVS Code上で再現し、軽快なキー操作を実現することを目的としています。

使用頻度の高いファンクションキーを活用し、頻繁に使用する操作を少ないストロークで簡略化します。

### キー操作

| キー | 操作 |
| --- | --- |
| `F5` | キーワード取得 + 次の一致も選択 |
| `Shift+F5` | F5で取得したキーワードを貼り付け |
| `F8` | 選択範囲を切り取り、コピースタックへ追加（未選択時は現在行） |
| `Shift+F8` | 選択範囲をコピーし、コピースタックへ追加 |
| `F9` | スタック先頭を貼り付け、貼り付けた項目をスタックから消費 |
| `Shift+F9` | スタック先頭を貼り付け、項目はスタックに保持 |

`F5` 系のキーワードバッファと `F8` / `F9` 系のコピースタックは **完全に別領域** です。

### F5 / Shift+F5 — キーワード操作

#### F5 — キーワード取得 + 次の一致も選択

`F5` を押すと、VS Code標準の `editor.action.addSelectionToNextFindMatch` を実行します。

同時に、その結果として選択されたキーワードを **F5専用バッファ** へ保存します。

VS Code標準の便利な「次の一致も選択」操作をそのまま使いつつ、取得したキーワードを後から再利用できます。

#### Shift+F5 — 取得したキーワードを貼り付け

`Shift+F5` を押すと、直前の `F5` で取得したキーワードを現在位置へ挿入します。

`F5` による選択がそのまま残っている場合は、選択を解除してキーワードの直後へ挿入します。それ以外の選択範囲がある場合はその範囲を置換し、複数カーソルがある場合は各カーソルへ同じキーワードを挿入します。

### F8 / Shift+F8 — コピー・切り取り

WZ Editorのキー配置に合わせています。

- `F8`: 選択開始位置から選択終了位置までをコピースタックへ積んで **切り取り**。未選択時は現在行を1行切り取り
- `Shift+F8`: 選択範囲をコピースタックへ積んで **コピー**

OSのクリップボードとは別に、本拡張専用のテキストスタックへ保存します。

### WindowsでのIME動作

Windowsでは、キーボードまたはマウスで範囲選択を開始したとき、IMEを1回だけOFFにします。これにより、IMEがONの状態でも `F8` などのファンクションキーが再変換操作としてIMEに先取りされず、VS Codeから本拡張を呼び出せるようにします。

Shift、Ctrl、Alt、Windowsキーが離されるのを待ち、選択開始時と同じウィンドウが前面にある場合だけ、Windows標準の **IME OFF** キーを送信します。低レベルキーボードフックは使用せず、特定のIME製品も指定しません。

このWindows専用処理では、拡張機能の動作中だけ同梱のネイティブ補助プロセスを起動します。補助プロセスへ渡すのは固定の制御コマンドだけであり、選択テキストは渡しません。ネットワーク通信、テレメトリー、権限昇格は行わず、修飾キーが押されているかだけを確認してキー入力内容は記録しません。ソースコードと再現可能なビルド手順は [`native/`](native/README.md) に同梱しています。

この動作は既定で有効です。VS Codeの設定画面から変更できます。

- **範囲選択開始時にIMEをOFFにする** (`wzOperation.keyboard.turnImeOffWhenSelectionStarts`)

選択範囲をすぐ日本語入力で置き換えたい場合は、選択後にIMEを再度ONにするか、この設定を無効にしてください。Windows以外ではこの設定は動作に影響しません。

補助プロセスを起動できない場合は、IMEの自動OFFを利用できないことをステータスバーへ表示します。それ以外の拡張機能は引き続き利用できます。設定を一度OFFにしてからONにすると再試行します。

### F9 / Shift+F9 — スタック貼り付け

- `F9`: スタック先頭を貼り付け、**その項目をスタックから消費**
- `Shift+F9`: スタック先頭を貼り付け、**その項目をスタックに残す**

たとえば `AAA` → `BBB` → `CCC` の順にコピーした場合、スタック先頭は `CCC` です。

`Shift+F9` を何度押しても `CCC` が貼り付けられます。`F9` を押すと `CCC` を貼り付けたあとスタックから消費されるため、次の `F9` では `BBB` が貼り付けられます。

### F5バッファとコピースタックは別領域

`F5` / `Shift+F5` のキーワードバッファと、`F8` / `Shift+F8` / `F9` / `Shift+F9` のコピースタックは **完全に独立** しています。

F5で取得したキーワードがF8/F9の履歴へ混ざることはなく、F8/F9のコピー内容がF5キーワードを上書きすることもありません。

また、本拡張の専用バッファ／スタックはOSクリップボードを使用しません。

### コピースタックの容量と保存期間

コピースタックはテキスト本体をUTF-16換算で、既定で合計最大 **64 MiB** まで保持します。1項目の既定の上限は **16 MiB** です。

上限はVS Codeの設定画面から変更できます。設定項目名はVS Codeの表示言語に合わせて切り替わります。

- **コピースタック全体の最大サイズ** (`wzOperation.copyStack.maxTotalSizeMiB`)
- **コピースタック1項目の最大サイズ** (`wzOperation.copyStack.maxItemSizeMiB`)

1項目の上限を合計上限より大きく設定した場合は、合計上限が実効上限になります。

合計上限を超えた場合は、最も古い項目から自動的に破棄します。1項目の上限を超える選択内容は、コピーも切り取りも行いません。

複数カーソルへの貼り付けでは、貼り付ける項目の容量とカーソル数を掛けた論理データ量を検査します。1回の貼り付けが設定された **コピースタック全体の最大サイズ** を超える場合は実行しません。

**現時点ではメモリ上に保持する揮発性スタックです。** F5専用バッファとコピースタックはいずれも、VS CodeのExtension Hostを再起動すると消去されます。

### 既存の keybindings.json について

同じキーにユーザー定義がある場合は、その定義が本拡張より優先されることがあります。

以前 `F5` / `F8` / `F9` 系を手動設定していた場合は、必要に応じてコメントアウトまたは削除してください。

例:

```json
{
  "key": "f5",
  "command": "editor.action.addSelectionToNextFindMatch",
  "when": "editorTextFocus"
}
```

### 対応環境

- Visual Studio Code `1.90.0` 以降
- Windows / macOS / Linux

### 表示言語

コマンド名、設定項目名と説明、ステータスバーメッセージは、VS Codeの表示言語に合わせて切り替わります。

- 日本語
- 英語

上記以外の表示言語では英語を使用します。

### コマンドパレット

キーバインドを変更したい場合は、以下のコマンドを任意のキーへ割り当てます。

- `WZ操作: キーワード取得 + 次の一致も選択`
- `WZ操作: 取得したキーワードを貼り付け`
- `WZ操作: 選択範囲を切り取りしてコピースタックへ追加`
- `WZ操作: 選択範囲をコピースタックへ追加`
- `WZ操作: コピースタックから貼り付けて消費`
- `WZ操作: コピースタックから貼り付け`

### ソースコード・問題

- GitHub: https://github.com/kiyo-c/wz-operation
- Issues: https://github.com/kiyo-c/wz-operation/issues

Marketplace Publisher IDは `kiyoc`、GitHubアカウントは `kiyo-c` です。

### ライセンス

MIT License
