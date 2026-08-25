# Changelog

[English](#english) | [日本語](#日本語)

<a id="english"></a>

## English

### 0.3.1

- Mirrored F8 and Shift+F8 copy operations to the operating system clipboard while retaining the extension's copy stack.
- Made F9 and Shift+F9 paste from the operating system clipboard when the copy stack is empty; F9 clears it after a successful paste while Shift+F9 retains it.
- When F9 consumes the stack item most recently mirrored to the OS clipboard, it now clears the mirrored text only if the clipboard is still unchanged.
- Added a Command Palette action that shows the copy stack newest-first and pastes the selected item without consuming it.
- Added a brief status-bar summary of copy-stack item count and used capacity after F8/F9 operations.

### 0.3.0

- Made the total copy-stack capacity and per-item capacity configurable through VS Code settings.
- Applied the configured total copy-stack capacity to multiple-cursor paste checks and clarified capacity-limit messages.
- Added English and Japanese localization for command names, setting names and descriptions, and status-bar messages.

### 0.2.5

- Changed the recommended default of `editor.editContext` to `false` through `configurationDefaults`, without modifying user settings.
- Documented that an explicit `editor.editContext: true` setting takes precedence and can prevent the extension's `F8` cut command from running while the IME is active.
- Added an EditContext notification with an “Open Settings” action when the effective setting is `true`.
- Added a maintenance command that safely resets only the EditContext notification state.

### 0.2.4

- `Shift+F5`: Changed comparison of F5-recorded selections to direct comparison, reducing temporary array and string allocations.
- `F8`: Consolidated copy-item capacity checking and removed duplicate calculations.

### 0.2.3

- `F8`: Stopped expanding an existing selection to whole lines and now cuts precisely from the selection start to the selection end. With no selection, the current line is still cut as before.

### 0.2.2

- `Shift+F5`: When the selection created by `F5` remains active, it is now cleared before pasting immediately after the keyword.
- `F8`: Fixed cutting behavior. When multiple lines are selected, the cut is now performed by line from the beginning of the first line through the line break of the last line.

### 0.2.1

- `F8`: Selection text that exceeds the per-item capacity limit is no longer stored or deleted.
- Changed the copy stack from front-of-array operations to a head-index implementation, improving addition, paste, and capacity-eviction performance.
- Limited the copy stack to 64 MiB total and 16 MiB per item, with capacity checks before string creation and before multiple-cursor paste operations.
- `F5`: Prevented text selected in another editor from being captured as the keyword if the active editor changes while the standard command runs.
- Improved the extension icon.

### 0.2.0

- `F5`: Runs VS Code's standard “Add Selection to Next Find Match” command and saves the keyword to the dedicated F5 buffer.
- `Shift+F5`: Pastes the keyword from the dedicated F5 buffer.
- `F8`: Adds the selected range to the copy stack and cuts it.
- `Shift+F8`: Adds the selected range to the copy stack and copies it.
- `F9`: Pastes and consumes the top copy-stack item.
- `Shift+F9`: Pastes the top copy-stack item while retaining it.
- Completely separated the F5 keyword buffer from the F8/F9 copy stack.
- Implemented the copy stack as a volatile, text-only memory stack with a maximum capacity of 256 MiB.
- Standardized the GitHub repository notation as `kiyo-c/wz-operation`.

### 0.1.0

Initial public release.

- `F5`: Runs VS Code's standard “Add Selection to Next Find Match” command and stores the keyword in a dedicated buffer.
- `Shift+F5`: Inserts the keyword from the dedicated buffer at the current position.
- Designed without using the operating system clipboard.
- Added support for pasting at multiple cursors.

---

<a id="日本語"></a>

## 日本語

### 0.3.1

- F8とShift+F8で、専用コピースタックを維持しながらOSクリップボードにもコピーするようにしました。
- コピースタックが空の場合、F9とShift+F9でOSクリップボードから貼り付けるようにしました。貼り付け成功後、F9はOSクリップボードを消去し、Shift+F9は保持します。
- F9が最後にOSクリップボードへ同期したスタック項目を消費する際、クリップボード内容が変わっていない場合に限り、同期したテキストも消去するようにしました。
- コピースタックを新しい順に一覧表示し、選択項目を消費せず貼り付けるコマンドを追加しました。
- F8/F9系の操作後、コピースタックの項目数と使用容量をステータスバーへ一時表示するようにしました。

### 0.3.0

- コピースタックの合計容量上限と1項目の容量上限を設定から変更できるようにした。
- 複数カーソルの貼り付け検査に設定済みの合計容量上限を適用し、容量上限メッセージを明確化。
- コマンド名、設定項目名と説明、ステータスバーメッセージの日本語・英語表示に対応。

### 0.2.5

- `configurationDefaults`で`editor.editContext`の推奨デフォルトを`false`へ変更。ユーザー設定を書き換えず、IME使用中も`F8`のWZ風切り取りが動作する入力方式を使用。
- 利用者が`editor.editContext: true`を明示している場合はその設定を優先し、IMEが`F8`を処理するため本拡張の切り取りが実行されない可能性があることをREADMEへ追記。
- `editor.editContext`の実効値が`true`の場合、「設定を開く」ボタン付きの通知を行う。
- EditContextの通知状態だけを安全に削除するメンテナンス用コマンドを追加。

### 0.2.4

- `Shift+F5`: F5で記録した選択範囲の比較を直接比較へ変更し、一時的な配列と文字列の生成を削減。
- `F8`: コピー項目の容量チェックを一本化し、重複していた計算を削除。

### 0.2.3

- `F8`: 選択ありの場合に行全体へ拡張しないで、選択開始位置から選択終了位置までを正確に切り取るように修正。未選択時は従来どおり現在行を1行切り取り。

### 0.2.2

- `Shift+F5`: `F5` で作られた選択が残っている場合は選択を解除し、キーワードの直後へ貼り付けるように変更。
- `F8`: 切り取り処理の不具合を修正。複数行を選択した場合、先頭行の先頭から最終行の改行までを行単位で切り取る。

### 0.2.1

- `F8`: 1項目の容量上限を超える選択内容をスタックへ保存せず、元テキストからも削除しないように修正。
- コピースタックを配列の先頭操作から先頭インデックス方式へ変更し、追加・貼り付け・容量超過時の破棄を効率化。
- コピースタックを合計64 MiB・1項目16 MiBに制限し、文字列生成前と複数カーソルへの貼り付け前に容量を検査するよう改善。
- `F5`: 標準コマンドの実行中にアクティブエディターが切り替わった場合、別エディターの選択内容をキーワードとして取得しないよう修正。
- アイコンを改善。

### 0.2.0

- `F5`: VS Code標準の「次の一致も選択」を実行し、キーワードをF5専用バッファへ保存。
- `Shift+F5`: F5専用バッファのキーワードを貼り付け。
- `F8`: 選択範囲をコピースタックへ追加して切り取り。
- `Shift+F8`: 選択範囲をコピースタックへ追加してコピー。
- `F9`: コピースタック先頭を貼り付けて消費。
- `Shift+F9`: コピースタック先頭を貼り付けて保持。
- F5キーワードバッファとF8/F9コピースタックを完全に分離。
- コピースタックをテキスト専用・最大256 MiBの揮発性メモリスタックとして実装。
- GitHubリポジトリ表記を `kiyo-c/wz-operation` に統一。

### 0.1.0

Initial public release.

- `F5`: VS Code標準の「次の一致も選択」を実行し、そのキーワードを専用バッファへ保存。
- `Shift+F5`: 専用バッファのキーワードを現在位置へ挿入。
- OSクリップボードを使用しない設計。
- 複数カーソルでの貼り付けに対応。
