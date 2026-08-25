# WZ Operation

[English](#english) | [日本語](#日本語)

<a id="english"></a>

## English

**WZ Operation** recreates some of WZ Editor's efficient keyboard operations and provides a fast keyboard-driven workflow.

> **This is an unofficial extension.** It is not affiliated with the developers or distributors of WZ Editor.

It uses less frequently used function keys to reduce common operations to a single keystroke.

Tired of moving your little finger to Ctrl for Ctrl+C, Ctrl+V, Ctrl+X, and similar operations?

### Key bindings

| Key | Operation |
| --- | --- |
| `F5` | Capture a keyword and add the next match to the selection |
| `Shift+F5` | Paste the keyword captured with F5 |
| `F8` | Cut to the copy stack and OS clipboard; use the current line when there is no selection |
| `Shift+F8` | Copy to the copy stack and OS clipboard; use the current line when there is no selection |
| `F9` | Paste and remove the top stack item; when empty, paste and clear the OS clipboard |
| `Shift+F9` | Paste and retain the top stack item; use the OS clipboard when the stack is empty |

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
- `Shift+F8`: Push the selected range onto the copy stack and **copy** it. With no selection, copy the current line.

Text is stored in the extension's own stack and is also copied to the operating system clipboard.

### F8 with an active IME and EditContext

To make `F8` cutting work correctly while an IME is active, this extension contributes a recommended default value of `false` for VS Code's `editor.editContext` setting. This default is supplied through `configurationDefaults`; it does not modify user or workspace settings. It applies only while the extension is enabled and only when the user has not explicitly specified a value.

```json
"editor.editContext": false
```

If the user explicitly specifies `"editor.editContext": true` in a settings file, that value takes precedence. In this state, the IME processes `F8` while text is selected, so this extension's `F8` cut command might not run.

When the effective value of `editor.editContext` is `true`, the extension displays a notification with an **Open Settings** button so that the problem can be reviewed. The notification is displayed at most twice for each extension version.

To test the notification again, run `WZ Operation: Reset EditContext Notification State` from the Command Palette. This removes only this extension's EditContext notification state and checks whether to show the notification again the next time VS Code starts.

To use this extension's `F8` cut operation while an IME is active, remove the explicit `true` setting for `editor.editContext` or change it to `false`.

### F9 / Shift+F9 — Paste from the stack

- `F9`: Paste the top stack item and **remove it from the stack**.
- `Shift+F9`: Paste the top stack item and **keep it on the stack**.

For example, after copying `AAA`, `BBB`, and `CCC` in that order, `CCC` is at the top of the stack.

Pressing `Shift+F9` repeatedly continues to paste `CCC`. Pressing `F9` pastes and removes `CCC`, so the next `F9` pastes `BBB`.

When the copy stack is empty, both `F9` and `Shift+F9` paste from the operating system clipboard. After a successful paste, `F9` clears the operating system clipboard while `Shift+F9` retains it. Neither operation adds the clipboard content to the copy stack.

When `F9` consumes a stack item that the extension most recently mirrored to the operating system clipboard, that clipboard text is also cleared if it is still unchanged. Different clipboard content copied afterward is preserved.

Run `WZ Keymap: Show Copy Stack` from the Command Palette to display stack items in newest-first order. Selecting an item pastes it without removing it from the stack.

### Separate F5 buffer and copy stack

The `F5` / `Shift+F5` keyword buffer and the `F8` / `Shift+F8` / `F9` / `Shift+F9` copy stack are **completely independent**.

A keyword captured with F5 never enters the F8/F9 history, and F8/F9 copy contents never overwrite the F5 keyword.

The F5 buffer does not use the operating system clipboard. F8 and Shift+F8 mirror copied text to it for interoperability with other applications.

### Copy-stack capacity and lifetime

By default, the copy stack retains up to **64 MiB** of text in total, calculated as UTF-16. The default limit for one item is **16 MiB**.

These limits can be changed in VS Code Settings. The setting names are localized to the current VS Code display language:

- **Maximum Total Copy-Stack Size** (`wzOperation.copyStack.maxTotalSizeMiB`)
- **Maximum Copy-Stack Item Size** (`wzOperation.copyStack.maxItemSizeMiB`)

If the per-item limit is greater than the total limit, the total limit becomes the effective per-item limit.

When the total limit is exceeded, the oldest items are discarded automatically. If selected text exceeds the per-item limit, neither copying nor cutting is performed.

For multiple-cursor pastes, the extension checks the logical data size by multiplying the item size by the number of cursors. A paste is not performed if one operation would exceed the configured **maximum total copy-stack size**.

**The stack is currently volatile and kept only in memory.** Both the F5 buffer and copy stack are cleared when the VS Code Extension Host restarts.

After a successful F8, Shift+F8, F9, or Shift+F9 operation, the status bar briefly shows the current item count and used capacity, for example `WZ Keymap: Stack 5 items / 1.8 MiB`.

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
- `WZ Keymap: Show Copy Stack`
- `WZ Operation: Reset EditContext Notification State`

---

<a id="日本語"></a>

## 日本語

**WZ Keymap** は、WZ Editorの効率的なキーボード操作の一部を再現し、軽快なキー操作を実現します。

> **非公式拡張です。** 本拡張は WZ Editor の開発元・販売元とは関係ありません。

使用頻度の低いファンクションキーを活用し、頻繁に使用する操作をワンストロークで簡略化します。

CTRL+C, CTRL+V, CTRL+X etc.. 小指をCTRLに移動させる操作に嫌気が差していませんか？

### キー操作

| キー | 操作 |
| --- | --- |
| `F5` | キーワード取得 + 次の一致も選択 |
| `Shift+F5` | F5で取得したキーワードを貼り付け |
| `F8` | コピースタックとOSクリップボードへ切り取り（未選択時は現在行） |
| `Shift+F8` | コピースタックとOSクリップボードへコピー（未選択時は現在行） |
| `F9` | スタック先頭を貼り付けて消費。空ならOSクリップボードから貼り付けて消去 |
| `Shift+F9` | スタック先頭を貼り付けて保持。空ならOSクリップボードから貼り付け |

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
- `Shift+F8`: 選択範囲をコピースタックへ積んで **コピー**。未選択時は現在行を1行コピー

本拡張専用のテキストスタックへ保存すると同時に、OSクリップボードにもコピーします。

### IME使用中のF8とEditContext

本拡張は、`F8`による切り取りをIME使用中も正しく動作させるため、VS Codeの`editor.editContext`へ`false`の推奨デフォルトを提供します。このデフォルトは`configurationDefaults`によるもので、ユーザー設定やワークスペース設定を書き換えません。本拡張が有効な間だけ、利用者が値を明示していない場合に適用されます。

```json
"editor.editContext": false
```

利用者が設定ファイルなどで`"editor.editContext": true`を明示している場合は、その設定が優先されます。この状態ではIMEが選択中の`F8`を処理するため、本拡張の`F8`切り取りコマンドが実行されないことがあります。

`editor.editContext`の実効値が`true`の場合は、問題を確認できるよう「設定を開く」ボタン付きの通知を行います。拡張機能の各バージョンにつき最大2回通知します。

通知動作を再確認する場合は、コマンドパレットから`WZ Keymap: EditContext通知状態をリセット`を実行してください。本拡張のEditContext通知状態だけを削除し、次回のVS Code起動時に通知を再判定します。

IME使用中も本拡張の`F8`切り取りを利用する場合は、`editor.editContext`の明示的な`true`設定を削除するか、`false`へ変更してください。

### F9 / Shift+F9 — スタック貼り付け

- `F9`: スタック先頭を貼り付け、**その項目をスタックから消費**
- `Shift+F9`: スタック先頭を貼り付け、**その項目をスタックに残す**

たとえば `AAA` → `BBB` → `CCC` の順にコピーした場合、スタック先頭は `CCC` です。

`Shift+F9` を何度押しても `CCC` が貼り付けられます。`F9` を押すと `CCC` を貼り付けたあとスタックから消費されるため、次の `F9` では `BBB` が貼り付けられます。

コピースタックが空の場合、`F9` と `Shift+F9` はどちらもOSクリップボードから貼り付けます。貼り付け成功後、`F9` はOSクリップボードを消去し、`Shift+F9` は保持します。どちらもOSクリップボードの内容をコピースタックへ追加しません。

`F9`で消費するスタック項目が、本拡張から最後にOSクリップボードへ同期した項目であり、その内容が変わっていない場合は、OSクリップボード側の同じテキストも消去します。その後にコピーされた異なる内容は保持します。

コマンドパレットから`WZ Keymap: コピースタックを表示`を実行すると、スタック項目を新しい順に一覧表示します。項目を選択すると、スタックから消費せずに貼り付けます。

### F5バッファとコピースタックは別領域

`F5` / `Shift+F5` のキーワードバッファと、`F8` / `Shift+F8` / `F9` / `Shift+F9` のコピースタックは **完全に独立** しています。

F5で取得したキーワードがF8/F9の履歴へ混ざることはなく、F8/F9のコピー内容がF5キーワードを上書きすることもありません。

F5専用バッファはOSクリップボードを使用しません。F8とShift+F8は、他のアプリケーションと連携できるようコピー内容をOSクリップボードにも反映します。

### コピースタックの容量と保存期間

コピースタックはテキスト本体をUTF-16換算で、既定で合計最大 **64 MiB** まで保持します。1項目の既定の上限は **16 MiB** です。

上限はVS Codeの設定画面から変更できます。設定項目名はVS Codeの表示言語に合わせて切り替わります。

- **コピースタック全体の最大サイズ** (`wzOperation.copyStack.maxTotalSizeMiB`)
- **コピースタック1項目の最大サイズ** (`wzOperation.copyStack.maxItemSizeMiB`)

1項目の上限を合計上限より大きく設定した場合は、合計上限が実効上限になります。

合計上限を超えた場合は、最も古い項目から自動的に破棄します。1項目の上限を超える選択内容は、コピーも切り取りも行いません。

複数カーソルへの貼り付けでは、貼り付ける項目の容量とカーソル数を掛けた論理データ量を検査します。1回の貼り付けが設定された **コピースタック全体の最大サイズ** を超える場合は実行しません。

**現時点ではメモリ上に保持する揮発性スタックです。** F5専用バッファとコピースタックはいずれも、VS CodeのExtension Hostを再起動すると消去されます。

F8、Shift+F8、F9、Shift+F9の操作に成功すると、現在の項目数と使用容量をステータスバーへ一時表示します（例：`WZ Keymap: スタック 5項目 / 1.8 MiB`）。

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

- `WZ Keymap: キーワード取得 + 次の一致も選択`
- `WZ Keymap: 取得したキーワードを貼り付け`
- `WZ Keymap: 単行or選択範囲を切り取りしてコピースタックへ追加`
- `WZ Keymap: 単行or選択範囲をコピースタックへ追加`
- `WZ Keymap: コピースタックから貼り付けて消費`
- `WZ Keymap: コピースタックから貼り付け`
- `WZ Keymap: コピースタックを表示`
- `WZ Keymap: EditContext通知状態をリセット`
