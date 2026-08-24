# IME OFF helper

Windowsでテキスト選択開始後にIMEをOFFへ切り替えるための小さな常駐ヘルパーです。低レベルキーボードフックは使用しません。

## 起動

Extension Host自身のプロセスIDを、唯一の起動引数として必ず渡します。

```text
ime-off-helper-x64.exe <extension-host-pid>
```

起動時にExtension Hostの実行ファイルパスを記録します。`off` 受付時の前面ウィンドウが同じ実行ファイルのプロセスに属していなければ、IME OFF入力を送りません。PIDの指定やプロセス照会に失敗した場合は `ready` を返さず終了します。

## 非同期プロトコル

起動すると標準出力へ `ready 2` を返し、標準入力から次の一行コマンドを待ちます。メインスレッドはIME処理を待たず、stdinを読み続けます。

- `ping`: 入力を送信せず `ok pong` を返します。
- `off`: 要求時の前面ウィンドウを直ちに記録し、検証後に最新要求として登録します。
- `cancel`: 待機中または未処理の要求を世代更新によって無効化します。
- `exit`: 要求を無効化し、ワーカー終了を待ってから `ok exit` を返して正常終了します。

EOFの場合も要求を無効化し、ワーカー終了を待ってから応答なしで正常終了します。

`off` を受け付けると `ok queued <generation>` を即時に返します。ワーカーはShift、Ctrl、Alt、左右Windowsキーが離れるまで待ち、次の条件を送信直前に再確認します。待機時間に上限はなく、新しい `off`、`cancel`、`exit` の状態変更イベントで直ちに中断できます。

- 要求が最新世代のままであること
- Extension Hostが動作中であること
- 要求時と同じ前面ウィンドウおよび所有プロセスであること
- 修飾キーが押されていないこと

条件を満たした場合だけ `VK_IME_OFF` のkeydownとkeyupを `SendInput` で送り、`ok off <generation>` を返します。新しい `off` や `cancel` で無効になった要求は `skip canceled <generation>` となります。ワーカーが未処理の要求は一件だけ保持し、新しい `off` で置き換えた場合は `skip coalesced <generation>` を返します。

安全条件を満たさない場合は `skip ...` を返し、入力は送りません。ワーカーの待機APIまたは `SendInput` が失敗した場合は `error ...` を返した後、stdin待機を解除してworkerをjoinし、それぞれ終了コード20または21で終了します。拡張機能側はこの非0終了を検知して、自動IME OFFが利用できないことを一度通知できます。

応答は常に一行ですが、ワーカー完了応答は非同期なので、コマンド受付応答より前後する場合があります。

## Build

同じソースを [llvm-mingw 20260616](https://github.com/mstorsjo/llvm-mingw/releases/tag/20260616) のWindows x86_64 host UCRT toolchainで、Windows x64版、x86版、Arm64版にビルドします。使用した `llvm-mingw-20260616-ucrt-x86_64.zip` のSHA-256は `b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35` です。

```powershell
x86_64-w64-mingw32-clang -std=c11 -Wall -Wextra -Wpedantic -Os -s -Wl,--no-insert-timestamp native/ime-off-helper.c -o native/ime-off-helper-x64.exe -luser32
i686-w64-mingw32-clang -std=c11 -Wall -Wextra -Wpedantic -Os -s -Wl,--no-insert-timestamp native/ime-off-helper.c -o native/ime-off-helper-x86.exe -luser32
aarch64-w64-mingw32-clang -std=c11 -Wall -Wextra -Wpedantic -Os -s -Wl,--no-insert-timestamp native/ime-off-helper.c -o native/ime-off-helper-arm64.exe -luser32
```

x64 Windowsではx64版、ia32 Windowsではx86版、Windows on ArmではArm64版を使用します。

コンソールサブシステムの実行ファイルなので、VS Code拡張機能から起動するときは `windowsHide: true` を指定します。
