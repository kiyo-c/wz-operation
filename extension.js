'use strict';

const { spawn } = require('child_process');
const vscode = require('vscode');

// -----------------------------------------------------------------------------
// Windows IME対策: 選択開始時にIMEをOFFへ切り替える
// -----------------------------------------------------------------------------
// VS Codeの公開APIにはIMEを直接切り替える機能がないため、Windows専用の補助プロセスへ依頼する。
const IME_OFF_HELPER_X64_RELATIVE_PATH = 'native/ime-off-helper-x64.exe';
const IME_OFF_HELPER_X86_RELATIVE_PATH = 'native/ime-off-helper-x86.exe';
const IME_OFF_HELPER_ARM64_RELATIVE_PATH = 'native/ime-off-helper-arm64.exe';
const IME_OFF_REQUEST = 'off\n';
const IME_OFF_CANCEL_REQUEST = 'cancel\n';
const IME_OFF_EXIT_REQUEST = 'exit\n';
const IME_OFF_HELPER_FORCE_KILL_DELAY_MS = 250;
let cachedTurnImeOffWhenSelectionStarts = true;
let imeOffHelperPath = undefined;
let imeOffHelper = undefined;
let imeOffHelperUnavailable = false;
let imeOffHelperFailureShown = false;
const imeOffRequestedByEditor = new WeakMap();

/**
 * 選択開始時にIMEをOFFへ切り替える設定を再読み込みする。
 *
 * @returns {void}
 */
function refreshImeOffSetting() {
  // 設定がまだ定義されていない環境でも、合意した既定動作である有効として扱う。
  const configuration = vscode.workspace.getConfiguration('wzOperation.keyboard');
  cachedTurnImeOffWhenSelectionStarts = configuration.get(
    'turnImeOffWhenSelectionStarts',
    true
  ) === true;
}

/**
 * 実行中のWindowsアーキテクチャに対応するIME補助プロセスのパスを取得する。
 *
 * @param {vscode.ExtensionContext} context 拡張機能のコンテキスト。
 * @returns {string|undefined} 利用可能な補助プロセスの絶対パス。
 */
function resolveImeOffHelperPath(context) {
  // Windows以外ではIME補助プロセスを利用しない。
  if (process.platform !== 'win32') {
    return undefined;
  }

  // 64ビットNode.jsではネイティブのx64版を選択する。
  if (process.arch === 'x64') {
    return context.asAbsolutePath(IME_OFF_HELPER_X64_RELATIVE_PATH);
  }

  // ARM64版のVS Codeでは、同じアーキテクチャの補助プロセスを選択する。
  if (process.arch === 'arm64') {
    return context.asAbsolutePath(IME_OFF_HELPER_ARM64_RELATIVE_PATH);
  }

  // 32ビットNode.jsではWindows x86版の補助プロセスを選択する。
  if (process.arch === 'ia32') {
    return context.asAbsolutePath(IME_OFF_HELPER_X86_RELATIVE_PATH);
  }

  // 想定外のアーキテクチャでは、通常機能を保ったままIME連携だけを利用不可とする。
  return undefined;
}

/**
 * IME自動OFFの補助処理を利用できないことを、一度だけユーザーへ通知する。
 *
 * @returns {void}
 */
function showImeOffHelperUnavailableMessage() {
  // 同じ障害について選択操作のたびに通知を繰り返さない。
  if (imeOffHelperFailureShown) {
    return;
  }
  imeOffHelperFailureShown = true;

  // 設定のOFF・ONで再試行できることを、現在の表示言語で案内する。
  vscode.window.setStatusBarMessage(
    vscode.l10n.t(
      'WZ Operation: Automatic IME-off is unavailable. Turn the setting off and on to retry.'
    ),
    5000
  );
}

/**
 * IME補助処理を現在のセッションで利用不能として記録する。
 *
 * @returns {void}
 */
function markImeOffHelperUnavailable() {
  // 通常の編集コマンドは維持したまま、IME連携だけを停止して理由を通知する。
  imeOffHelperUnavailable = true;
  showImeOffHelperUnavailableMessage();
}

/**
 * IME補助プロセスを利用不能として停止する。
 *
 * @param {import('child_process').ChildProcess} helper 停止対象の補助プロセス。
 * @returns {void}
 */
function disableImeOffHelper(helper) {
  // 既に置き換えられたプロセスから遅れて届いたイベントは無視する。
  if (imeOffHelper !== helper) {
    return;
  }

  // 同じセッション中に起動失敗を繰り返さないよう、IME連携だけを無効化する。
  imeOffHelper = undefined;
  markImeOffHelperUnavailable();

  // まだ動作中なら停止を要求し、拡張機能本体から切り離す。
  try {
    if (helper.exitCode === null && !helper.killed) {
      helper.kill();
    }
  } catch {
    // 停止処理の失敗は拡張機能の通常操作へ影響させない。
  }
}

/**
 * IME補助プロセスの起動または実行に失敗したときのイベントを処理する。
 *
 * @param {import('child_process').ChildProcess} helper 対象の補助プロセス。
 * @returns {void}
 */
function handleImeOffHelperFailure(helper) {
  // 一度だけ利用不可を通知し、このセッションのIME連携だけを停止する。
  disableImeOffHelper(helper);
}

/**
 * IME補助プロセスへの要求の書き込み完了を処理する。
 *
 * @param {import('child_process').ChildProcess} helper 要求を送った補助プロセス。
 * @param {Error|null|undefined} error 書き込みに失敗した場合のエラー。
 * @returns {void}
 */
function handleImeOffHelperRequestWritten(helper, error) {
  // 正常に書き込めた場合は、次の選択開始まで追加処理を行わない。
  if (!error) {
    return;
  }

  // パイプが切断されている場合は補助プロセスを利用不能として扱う。
  disableImeOffHelper(helper);
}

/**
 * Windows専用のIME補助プロセスを起動する。
 *
 * @returns {void}
 */
function startImeOffHelper() {
  // Windows以外、設定無効時、起動済みまたは利用不能判定後は何もしない。
  if (
    process.platform !== 'win32' ||
    !cachedTurnImeOffWhenSelectionStarts ||
    imeOffHelper ||
    imeOffHelperUnavailable
  ) {
    return;
  }

  // 対応する実行ファイルがないアーキテクチャでは、IME連携を利用不可として記録する。
  if (!imeOffHelperPath) {
    markImeOffHelperUnavailable();
    return;
  }

  /** @type {import('child_process').ChildProcess} */
  let helper;
  try {
    // シェルを介さず非表示で起動し、標準入力だけを要求送信用に接続する。
    helper = spawn(imeOffHelperPath, [String(process.pid)], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore']
    });
  } catch {
    // 起動できない環境では、拡張機能本体を止めずIME連携だけを無効化する。
    markImeOffHelperUnavailable();
    return;
  }

  // イベントを登録する前に参照を保存し、非同期の起動失敗を正しく識別できるようにする。
  imeOffHelper = helper;
  helper.once('error', handleImeOffHelperFailure.bind(undefined, helper));
  helper.once('exit', handleImeOffHelperFailure.bind(undefined, helper));
  if (helper.stdin) {
    helper.stdin.on('error', handleImeOffHelperFailure.bind(undefined, helper));
  }
}

/**
 * 猶予時間後も動作しているIME補助プロセスを強制終了する。
 *
 * @param {import('child_process').ChildProcess} helper 終了確認対象の補助プロセス。
 * @returns {void}
 */
function forceKillImeOffHelper(helper) {
  // exit要求で既に終了していれば、追加の終了処理は行わない。
  if (helper.exitCode !== null || helper.killed) {
    return;
  }

  try {
    // 応答しない補助プロセスだけを強制終了し、常駐したまま残ることを防ぐ。
    helper.kill();
  } catch {
    // 終了確認中の競合による失敗は拡張機能の通常操作へ影響させない。
  }
}

/**
 * 動作中のIME補助プロセスを終了する。
 *
 * @returns {void}
 */
function stopImeOffHelper() {
  // 起動していなければ終了処理は不要である。
  const helper = imeOffHelper;
  if (!helper) {
    return;
  }

  // 終了に伴うexitイベントを障害と判定しないよう、先に現在の参照を解除する。
  imeOffHelper = undefined;

  // exit要求を送って標準入力を閉じ、補助プロセスへ正常終了の猶予を与える。
  try {
    if (helper.stdin && !helper.stdin.destroyed) {
      helper.stdin.end(IME_OFF_EXIT_REQUEST);
    }
  } catch {
    // 終了時の失敗は拡張機能の停止処理へ伝播させない。
  }

  // 正常終了しない場合に限り、短い猶予時間の後で強制終了する。
  const forceKillTimer = setTimeout(
    forceKillImeOffHelper,
    IME_OFF_HELPER_FORCE_KILL_DELAY_MS,
    helper
  );

  // 終了確認用タイマーだけでExtension Hostの終了を引き延ばさない。
  forceKillTimer.unref();
}

/**
 * 現在の設定に合わせてIME補助プロセスの起動状態を更新する。
 *
 * @returns {void}
 */
function synchronizeImeOffHelper() {
  // 設定が無効になった場合は、常駐中の補助プロセスを終了する。
  if (!cachedTurnImeOffWhenSelectionStarts) {
    cancelImeOffRequest();
    stopImeOffHelper();
    return;
  }

  // 設定が有効なら、必要に応じて補助プロセスを起動する。
  startImeOffHelper();
}

/**
 * 常駐中の補助プロセスへ1件の要求を送る。
 *
 * @param {string} request 改行で終わる要求文字列。
 * @returns {void}
 */
function writeImeOffHelperRequest(request) {
  // 起動失敗時や終了後は、通常の選択操作へ影響を与えず何もしない。
  const helper = imeOffHelper;
  if (
    !helper ||
    helper.exitCode !== null ||
    helper.killed ||
    !helper.stdin ||
    !helper.stdin.writable
  ) {
    return;
  }

  try {
    // 1要求を1行として送信し、完了時にパイプ切断の有無を確認する。
    helper.stdin.write(
      request,
      handleImeOffHelperRequestWritten.bind(undefined, helper)
    );
  } catch {
    // 同期的な書き込み失敗も、非同期エラーと同様にIME連携だけを停止する。
    disableImeOffHelper(helper);
  }
}

// editor.editContext警告
// -----------------------------------------------------------------------------
const EDIT_CONTEXT_WARNING_STATE_KEY = 'editContextWarningState';
const EDIT_CONTEXT_WARNING_LIMIT = 2;
const EDIT_CONTEXT_WARNING_MESSAGE = vscode.l10n.t(
  'The setting "editor.editContext": true is specified in settings.json, so F8 cut cannot be used while the IME is active.'
);
const OPEN_SETTINGS_ACTION = vscode.l10n.t('Open Settings');

/**
 * editor.editContextがtrueの場合、現在のバージョンで最大2回まで通知する。
 * バージョンが変わった場合は通知回数をリセットする。
 *
 * @param {vscode.ExtensionContext} context 拡張機能の実行コンテキスト。
 * @returns {Promise<void>} 通知状態の保存と通知処理の完了を表すPromise。
 */
async function warnIfEditContextEnabled(context) {
  const currentVersion = context.extension.packageJSON.version;
  const savedState = context.globalState.get(EDIT_CONTEXT_WARNING_STATE_KEY);

  // 更新またはダウングレードでバージョンが変わった場合は回数を引き継がない。
  const state =
    savedState && savedState.version === currentVersion
      ? savedState
      : { version: currentVersion, notificationCount: 0 };

  // 推奨デフォルトのfalseが有効な場合や、通知上限へ達した場合は何もしない。
  const editContextEnabled = vscode.workspace
    .getConfiguration('editor')
    .get('editContext', false);
  if (!editContextEnabled || state.notificationCount >= EDIT_CONTEXT_WARNING_LIMIT) {
    return;
  }

  // 通知を閉じる前に終了しても再表示されないよう、表示前に回数を保存する。
  await context.globalState.update(EDIT_CONTEXT_WARNING_STATE_KEY, {
    version: currentVersion,
    notificationCount: state.notificationCount + 1
  });

  // 設定画面を直接開けるアクション付きで警告する。
  const selectedAction = await vscode.window.showWarningMessage(
    EDIT_CONTEXT_WARNING_MESSAGE,
    OPEN_SETTINGS_ACTION
  );
  if (selectedAction === OPEN_SETTINGS_ACTION) {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      { query: '@id:editor.editContext' }
    );
  }
}

/**
 * 常駐中の補助プロセスへIME OFF要求を送る。
 *
 * @returns {void}
 */
function requestImeOff() {
  // 選択開始に対応するIME OFF要求を共通の書き込み処理へ渡す。
  writeImeOffHelperRequest(IME_OFF_REQUEST);
}

/**
 * 常駐中の補助プロセスへ保留中のIME OFF要求の取消を送る。
 *
 * @returns {void}
 */
function cancelImeOffRequest() {
  // フォーカス移動や選択解除後にIMEを切り替えないよう、保留中の要求を取り消す。
  writeImeOffHelperRequest(IME_OFF_CANCEL_REQUEST);
}

/**
 * エディターの選択範囲に空でないものが含まれるか判定する。
 *
 * @param {readonly vscode.Selection[]} selections 判定対象の選択範囲。
 * @returns {boolean} 1つ以上の選択範囲にテキストが含まれている場合はtrue。
 */
function containsNonEmptySelection(selections) {
  // 複数カーソルを順に確認し、最初の非空選択が見つかった時点で判定を終える。
  for (const selection of selections) {
    if (!selection.isEmpty) {
      return true;
    }
  }

  return false;
}

/**
 * エディターの現在の選択状態をIME OFF要求済み状態へ初期化する。
 *
 * @param {vscode.TextEditor} editor 初期化対象のエディター。
 * @returns {void}
 */
function initializeImeOffSelectionState(editor) {
  // 有効化前から存在する選択を、新しく開始された選択として誤検出しないよう記録する。
  imeOffRequestedByEditor.set(
    editor,
    containsNonEmptySelection(editor.selections)
  );
}

/**
 * 指定エディターの選択に対応するIME OFFを要求する。
 *
 * @param {vscode.TextEditor} editor 選択を持つエディター。
 * @returns {boolean} 要求対象として状態を更新した場合はtrue。
 */
function requestImeOffForEditor(editor) {
  // Windows、設定有効、ウィンドウのフォーカス、アクティブエディターをすべて確認する。
  if (
    process.platform !== 'win32' ||
    !cachedTurnImeOffWhenSelectionStarts ||
    !vscode.window.state.focused ||
    vscode.window.activeTextEditor !== editor
  ) {
    return false;
  }

  // 同じ選択状態から重複要求しないよう、送信前に要求済みとして記録する。
  imeOffRequestedByEditor.set(editor, true);
  requestImeOff();
  return true;
}

/**
 * フォーカス中のアクティブエディターに現在の選択状態を反映する。
 *
 * @returns {void}
 */
function refreshActiveEditorImeOffState() {
  // アクティブエディターがなければ、IME切り替えの対象は存在しない。
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // 選択が空なら次の範囲選択に備えて再武装する。
  if (!containsNonEmptySelection(editor.selections)) {
    imeOffRequestedByEditor.set(editor, false);
    return;
  }

  // 設定無効時は状態を保ち、OSへの要求を送らず早期に終了する。
  if (!cachedTurnImeOffWhenSelectionStarts) {
    return;
  }

  // 非空選択があるアクティブエディターについて、IME OFFを明示的に再要求する。
  requestImeOffForEditor(editor);
}

/**
 * VS Codeウィンドウのフォーカス変更に合わせて保留中のIME要求を更新する。
 *
 * @param {vscode.WindowState} state 変更後のウィンドウ状態。
 * @returns {void}
 */
function handleWindowStateChange(state) {
  // フォーカスを失った場合は、別アプリへIME OFFを送らないよう保留要求を取り消す。
  if (!state.focused) {
    cancelImeOffRequest();
    return;
  }

  // フォーカス復帰時は、現在のアクティブエディターの選択に対して再要求する。
  refreshActiveEditorImeOffState();
}

/**
 * エディターの選択変更を監視し、選択開始時に1回だけIME OFFを要求する。
 *
 * @param {vscode.TextEditorSelectionChangeEvent} event 選択変更イベント。
 * @returns {void}
 */
function handleTextEditorSelectionChange(event) {
  // 全カーソルが空へ戻ったら、次の範囲選択に備えて再武装する。
  if (!containsNonEmptySelection(event.selections)) {
    if (
      event.textEditor === vscode.window.activeTextEditor &&
      imeOffRequestedByEditor.get(event.textEditor) === true
    ) {
      cancelImeOffRequest();
    }
    imeOffRequestedByEditor.set(event.textEditor, false);
    return;
  }

  // 設定無効時は、非空選択についてそれ以上の判定や要求を行わない。
  if (!cachedTurnImeOffWhenSelectionStarts) {
    return;
  }

  // キーボードまたはマウスで行われた選択変更だけをIME切り替えの対象にする。
  const isKeyboard = event.kind === vscode.TextEditorSelectionChangeKind.Keyboard;
  const isMouse = event.kind === vscode.TextEditorSelectionChangeKind.Mouse;
  if (!isKeyboard && !isMouse) {
    return;
  }

  // 同じ非空選択を伸縮している間は、IME OFF要求を繰り返さない。
  if (imeOffRequestedByEditor.get(event.textEditor) === true) {
    return;
  }
  // フォーカス中のアクティブエディターなら、補助プロセスへIME OFFを依頼する。
  requestImeOffForEditor(event.textEditor);
}

/**
 * editor.editContext警告の通知済み状態だけを削除する。
 *
 * @param {vscode.ExtensionContext} context 拡張機能の実行コンテキスト。
 * @returns {Promise<void>} 通知状態の削除と完了通知を表すPromise。
 */
async function resetEditContextWarningState(context) {
  // globalState内の本機能専用キーだけを削除する。
  await context.globalState.update(EDIT_CONTEXT_WARNING_STATE_KEY, undefined);

  // 次回起動時に通知判定が再実行されることを利用者へ伝える。
  await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'The EditContext notification state was reset. It will be checked again the next time VS Code starts.'
    )
  );
}

// -----------------------------------------------------------------------------
// F5系: キーワード専用バッファ
// -----------------------------------------------------------------------------
// OSクリップボード、F8/F9コピースタックとは完全に独立。
let pickedKeyword = '';
let pickedKeywordSelection = undefined;

/**
 * F5で取得したキーワードに対応するエディターと選択範囲を記録する。
 *
 * @param {vscode.TextEditor} editor 記録対象のエディター。
 * @returns {void}
 */
function rememberPickedKeywordSelection(editor) {
  // 後続のShift+F5で同じ選択範囲か判定できるよう、文書と選択状態を保存する。
  pickedKeywordSelection = {
    document: editor.document,
    selections: editor.selections
  };
}

/**
 * 現在の選択範囲がF5でキーワードを取得した直後の状態か判定する。
 *
 * @param {vscode.TextEditor} editor 判定対象のエディター。
 * @returns {boolean} 文書と全選択範囲が記録時と一致する場合はtrue。
 */
function hasPickedKeywordSelection(editor) {
  // 比較対象となる現在の選択範囲を取得する。
  const currentSelections = editor.selections;

  // 文書または選択数が異なる場合は、記録時と同じ状態ではない。
  if (
    !pickedKeywordSelection ||
    pickedKeywordSelection.document !== editor.document ||
    pickedKeywordSelection.selections.length !== currentSelections.length
  ) {
    return false;
  }

  // 各選択範囲の開始位置と終了位置を記録時の状態と比較する。
  for (let index = 0; index < pickedKeywordSelection.selections.length; index++) {
    if (!pickedKeywordSelection.selections[index].isEqual(currentSelections[index])) {
      return false;
    }
  }

  return true;
}

/**
 * 選択範囲にテキストが含まれているか判定する。
 *
 * @param {vscode.Selection} selection 判定対象の選択範囲。
 * @returns {boolean} 空でない場合はtrue。
 */
function isNonEmptySelection(selection) {
  // VS CodeのisEmptyを反転し、filterで利用できる真偽値を返す。
  return !selection.isEmpty;
}

/**
 * 選択範囲を末尾位置の空選択へ変換する。
 *
 * @param {vscode.Selection} selection 変換対象の選択範囲。
 * @returns {vscode.Selection} 選択末尾に置かれたカーソル。
 */
function collapseSelectionToEnd(selection) {
  // アンカーとアクティブ位置を末尾へそろえて選択を解除する。
  return new vscode.Selection(selection.end, selection.end);
}

/**
 * 数値を昇順に並べるための比較結果を返す。
 *
 * @param {number} left 左辺の数値。
 * @param {number} right 右辺の数値。
 * @returns {number} Array.prototype.sort用の比較結果。
 */
function compareNumbers(left, right) {
  // 差を返すことで小さい数値が先に並ぶようにする。
  return left - right;
}

function clearPickedKeywordSelectionForDocument(document) {
  if (
    document.isClosed &&
    pickedKeywordSelection &&
    pickedKeywordSelection.document === document
  ) {
    pickedKeywordSelection = undefined;
  }
}

// -----------------------------------------------------------------------------
// F8/F9系: WZ風コピースタック
// -----------------------------------------------------------------------------
// Extension Hostのメモリ上だけに保持するテキスト専用LIFOスタック。
// WZ本体の永続TEMPスタックとは異なり、VS Code再起動時に破棄される。
const DEFAULT_MAX_CLIP_STACK_MIB = 64;
const DEFAULT_MAX_CLIP_ITEM_MIB = 16;
let clipStack = [];
let clipStackHead = 0;
let clipStackBytes = 0;
let cachedClipStackLimits = {
  totalBytes: DEFAULT_MAX_CLIP_STACK_MIB * 1024 * 1024,
  totalMiB: DEFAULT_MAX_CLIP_STACK_MIB,
  itemBytes: DEFAULT_MAX_CLIP_ITEM_MIB * 1024 * 1024,
  itemMiB: DEFAULT_MAX_CLIP_ITEM_MIB
};

/**
 * コピースタックのMiB単位の設定値を検証する。
 *
 * @param {unknown} value 検証する設定値。
 * @param {number} defaultValue 設定値が不正な場合に使用する既定値。
 * @returns {number} 1以上の有限な設定値。
 */
function validConfiguredMiB(value, defaultValue) {
  // 不正値が渡された場合は、拡張機能側の安全な既定値へ戻す。
  return Number.isFinite(value) && value >= 1 ? value : defaultValue;
}

/**
 * VS Codeの設定からコピースタックの実効容量上限を再読み込みする。
 *
 * @returns {void}
 */
function refreshClipStackLimits() {
  // 設定オブジェクトは1回だけ取得し、必要な値をまとめて読み込む。
  const configuration = vscode.workspace.getConfiguration('wzOperation.copyStack');
  const totalMiB = validConfiguredMiB(
    configuration.get('maxTotalSizeMiB'),
    DEFAULT_MAX_CLIP_STACK_MIB
  );
  const configuredItemMiB = validConfiguredMiB(
    configuration.get('maxItemSizeMiB'),
    DEFAULT_MAX_CLIP_ITEM_MIB
  );

  // 1項目だけで合計上限を超えないよう、小さい方を実効上限とする。
  const itemMiB = Math.min(configuredItemMiB, totalMiB);

  // 通常操作では設定APIを呼ばずに済むよう、計算済みの上限を保存する。
  cachedClipStackLimits = {
    totalBytes: totalMiB * 1024 * 1024,
    totalMiB,
    itemBytes: itemMiB * 1024 * 1024,
    itemMiB
  };
}

/**
 * 文字列の容量をUTF-16換算で算出する。
 *
 * @param {string} text 容量を調べる文字列。
 * @returns {number} UTF-16コード単位を2バイトとして計算した容量。
 */
function textBytes(text) {
  // JavaScript文字列の実メモリ量と完全一致はしないが、
  // UTF-16LE換算で安全側の容量管理を行う。
  return text.length * 2;
}

/**
 * 1項目の容量上限を超えたことをステータスバーへ表示する。
 *
 * @param {number} limitMiB 適用された上限値（MiB）。
 * @returns {void}
 */
function showConfiguredClipItemTooLargeMessage(limitMiB) {
  // ユーザーが原因を判断できるよう、現在の実効上限をメッセージに含める。
  vscode.window.setStatusBarMessage(
    vscode.l10n.t(
      'WZ Operation: The selection exceeds the per-item copy-stack capacity ({0} MiB) and cannot be saved.',
      limitMiB
    ),
    3000
  );
}

/**
 * 文字列を容量検査済みのコピースタック項目へ変換する。
 *
 * @param {string} text スタックへ保存する文字列。
 * @returns {{text: string, bytes: number}|null} 保存可能な項目。保存できない場合はnull。
 */
function prepareClipItem(text) {
  // 空文字列はスタックへ保存しない。
  if (!text) {
    return null;
  }

  // 文字列生成後の実容量を現在の1項目上限と比較する。
  const bytes = textBytes(text);
  const { itemBytes, itemMiB } = cachedClipStackLimits;
  if (bytes > itemBytes) {
    showConfiguredClipItemTooLargeMessage(itemMiB);
    return null;
  }

  // 後続処理で再計算しないよう、文字列と容量をまとめて返す。
  return { text, bytes };
}

/**
 * 容量検査済みの項目をコピースタックへ追加する。
 *
 * @param {{text: string, bytes: number}} item 追加する項目。
 * @returns {boolean} 追加処理が完了した場合はtrue。
 */
function pushPreparedClipItem(item) {
  // 最新項目として末尾へ追加し、合計容量を更新する。
  clipStack.push(item);
  clipStackBytes += item.bytes;

  // 設定された合計上限に収まるまで古い項目を整理する。
  trimClipStackToConfiguredLimit();

  return true;
}

/**
 * コピースタックを現在の合計容量上限以内に整理する。
 *
 * @returns {void}
 */
function trimClipStackToConfiguredLimit() {
  // 設定変更時に更新されたキャッシュから合計上限を取得する。
  const { totalBytes } = cachedClipStackLimits;

  // 容量上限を超えたら最古の項目から捨てる。
  while (clipStackBytes > totalBytes && clipStackHead < clipStack.length) {
    const oldest = clipStack[clipStackHead];
    clipStackBytes -= oldest.bytes;
    clipStack[clipStackHead] = undefined;
    clipStackHead++;
  }
  // 先頭側に破棄済み領域が十分たまった場合は配列を詰める。
  compactClipStackIfNeeded();
}

/**
 * 破棄済み項目が増えたコピースタック配列を必要に応じて圧縮する。
 *
 * @returns {void}
 */
function compactClipStackIfNeeded() {
  // 頻繁な配列コピーを避けつつ、十分な削減効果がある場合だけ圧縮する。
  if (clipStackHead >= 1024 && clipStackHead * 2 >= clipStack.length) {
    clipStack = clipStack.slice(clipStackHead);
    clipStackHead = 0;
  }
}

/**
 * コピースタックに利用可能な項目がないか判定する。
 *
 * @returns {boolean} スタックが空の場合はtrue。
 */
function isClipStackEmpty() {
  // 先頭インデックスが配列末尾へ達していれば全項目が消費済みである。
  return clipStackHead >= clipStack.length;
}

/**
 * コピースタックの最新項目を取得する。
 *
 * @returns {{text: string, bytes: number}|undefined} 最新項目。空の場合はundefined。
 */
function getLatestClipItem() {
  // 空スタックでは配列を参照せず、項目なしを返す。
  if (isClipStackEmpty()) {
    return undefined;
  }

  // LIFOの最新項目は配列末尾に保持されている。
  return clipStack[clipStack.length - 1];
}

/**
 * コピースタックの最新項目を取り出して削除する。
 *
 * @returns {{text: string, bytes: number}|undefined} 取り出した項目。空の場合はundefined。
 */
function popLatestClipItem() {
  // 削除前に最新項目の有無を確認する。
  const item = getLatestClipItem();
  if (!item) {
    return undefined;
  }

  // 最新項目を配列と合計容量の両方から取り除く。
  clipStack.pop();
  clipStackBytes -= item.bytes;

  // 全項目を消費した場合は内部配列と先頭位置を初期状態へ戻す。
  if (isClipStackEmpty()) {
    clipStack = [];
    clipStackHead = 0;
  }

  return item;
}

/**
 * 文字列を検査してコピースタックへ追加する。
 *
 * @param {string} text 追加する文字列。
 * @returns {boolean} 追加できた場合はtrue。
 */
function pushClipStack(text) {
  // 空文字列と1項目上限超過を追加前に検査する。
  const item = prepareClipItem(text);
  if (!item) {
    return false;
  }

  // 検査済み項目をスタックへ積む。
  return pushPreparedClipItem(item);
}

/**
 * 複数の選択範囲を結合した場合の容量を、文字列生成前に算出する。
 *
 * @param {vscode.TextEditor} editor 選択範囲を持つエディター。
 * @param {readonly vscode.Selection[]} selections 容量を調べる選択範囲。
 * @returns {number} UTF-16換算の合計容量。
 */
function selectionRangesBytes(editor, selections) {
  // 各選択範囲のUTF-16コード単位数をオフセットから集計する。
  let codeUnits = 0;
  for (const selection of selections) {
    const start = editor.document.offsetAt(selection.start);
    const end = editor.document.offsetAt(selection.end);
    codeUnits += end - start;
  }

  return codeUnits * 2;
}

/**
 * 複数の選択範囲を結合した場合の容量を、文字列生成前に算出する。
 *
 * @param {vscode.TextEditor} editor 選択範囲を持つエディター。
 * @param {readonly vscode.Selection[]} selections 容量を調べる選択範囲。
 * @returns {number} UTF-16換算の合計容量。
 */
function selectedTextBytes(editor, selections) {
  // 選択範囲間へ挿入する文書の改行コード分を加算する。
  const eolCodeUnits = editor.document.eol === vscode.EndOfLine.CRLF ? 2 : 1;
  return (
    selectionRangesBytes(editor, selections) +
    eolCodeUnits * Math.max(0, selections.length - 1) * 2
  );
}

/**
 * 複数の選択範囲からコピースタックへ保存する文字列を生成する。
 *
 * @param {vscode.TextEditor} editor 選択範囲を持つエディター。
 * @param {readonly vscode.Selection[]} selections 取得する選択範囲。
 * @returns {string} 文書の改行コードで結合した選択テキスト。
 */
function getSelectedText(editor, selections) {
  // 単一選択では配列作成と文字列結合を行わず、テキストを直接取得する。
  if (selections.length === 1) {
    return editor.document.getText(selections[0]);
  }

  // 文書と同じ改行コードで個々の選択テキストを連結する。
  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const texts = [];
  for (const selection of selections) {
    texts.push(editor.document.getText(selection));
  }
  return texts.join(eol);
}

/**
 * 行全体の選択範囲から切り取り用の文字列を生成する。
 *
 * @param {vscode.TextEditor} editor 選択範囲を持つエディター。
 * @param {readonly vscode.Range[]} selections 改行を含む行全体の選択範囲。
 * @returns {string} 選択された行を連結した文字列。
 */
function getWholeLineText(editor, selections) {
  // 一般的な単一行切り取りでは配列を生成せず、テキストを直接取得する。
  if (selections.length === 1) {
    return editor.document.getText(selections[0]);
  }

  // 複数カーソルの場合は、各行が保持する改行をそのまま連結する。
  const lineTexts = [];
  for (const selection of selections) {
    lineTexts.push(editor.document.getText(selection));
  }
  return lineTexts.join('');
}

/**
 * F5:
 * 1. VS Code標準の「次の一致も選択」をそのまま実行。
 * 2. その結果できた選択範囲の文字列をF5専用バッファへ保存。
 *
 * @returns {Promise<void>}
 */
async function pickKeywordAndAddSelection() {
  // コマンド開始時のエディターを取得し、未表示なら処理を終了する。
  const editorBefore = vscode.window.activeTextEditor;
  if (!editorBefore) {
    return;
  }

  // 前回記録した選択状態を無効化してから標準コマンドを実行する。
  pickedKeywordSelection = undefined;

  // 既存のVS Code機能を直接呼ぶため、キーバインド再帰は起こらない。
  await vscode.commands.executeCommand('editor.action.addSelectionToNextFindMatch');

  // コマンド実行中にエディターが切り替わった場合は別文書から取得しない。
  if (vscode.window.activeTextEditor !== editorBefore) {
    return;
  }

  // 標準コマンド実行後に作られた空でない選択範囲を取得する。
  let selection;
  for (const candidate of editorBefore.selections) {
    if (isNonEmptySelection(candidate)) {
      selection = candidate;
      break;
    }
  }
  if (!selection) {
    return;
  }

  // Command由来の選択変更は一般監視の対象外なので、F5の選択だけは明示的にIMEをOFFにする。
  requestImeOffForEditor(editorBefore);

  // 選択文字列と選択状態をF5専用バッファへ記録する。
  const text = editorBefore.document.getText(selection);
  if (text.length > 0) {
    pickedKeyword = text;
    rememberPickedKeywordSelection(editorBefore);
  }
}

/**
 * Shift+F5:
 * F5専用バッファのキーワードを現在位置へ挿入。
 * F5による選択が残っている場合は、選択を解除してその直後へ挿入する。
 * それ以外の選択範囲があれば置換し、複数カーソル時は各位置へ挿入する。
 *
 * @returns {Promise<void>}
 */
async function pastePickedKeyword() {
  // 現在のエディターを取得し、未表示なら処理を終了する。
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // F5でキーワードが取得されていなければユーザーへ通知する。
  if (pickedKeyword.length === 0) {
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('WZ Operation: Capture a keyword with F5 first.'),
      2500
    );
    return;
  }

  // F5による選択が残っている場合は、選択末尾へカーソルを移動する。
  if (hasPickedKeywordSelection(editor)) {
    editor.selections = editor.selections.map(collapseSelectionToEnd);
  }
  // 一度貼り付けを始めたら、記録していた選択状態は再利用しない。
  pickedKeywordSelection = undefined;

  /**
   * 各カーソル位置または選択範囲へ記録済みキーワードを設定する。
   *
   * @param {vscode.TextEditorEdit} editBuilder 編集操作のビルダー。
   * @returns {void}
   */
  function replaceSelectionsWithPickedKeyword(editBuilder) {
    // すべての選択範囲を1回の編集として置換する。
    for (const selection of editor.selections) {
      editBuilder.replace(selection, pickedKeyword);
    }
  }

  // 各カーソル位置または選択範囲へ、記録済みキーワードを挿入する。
  await editor.edit(
    replaceSelectionsWithPickedKeyword,
    {
      undoStopBefore: true,
      undoStopAfter: true
    }
  );
}

/**
 * Shift+F8:
 * 選択範囲をWZ風コピースタックへ追加。元テキストは残す。
 *
 * @returns {Promise<void>}
 */
async function copyToStack() {
  // 現在のエディターを取得し、未表示なら処理を終了する。
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // 空のカーソル位置を除き、コピー対象となる選択範囲だけを集める。
  const selections = editor.selections.filter(isNonEmptySelection);
  if (selections.length === 0) {
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('WZ Operation: Select a range to copy.'),
      2000
    );
    return;
  }

  // 大きな文字列を生成する前に、選択範囲の容量が上限内か検査する。
  const { itemBytes, itemMiB } = cachedClipStackLimits;
  if (selectedTextBytes(editor, selections) > itemBytes) {
    showConfiguredClipItemTooLargeMessage(itemMiB);
    return;
  }

  // 選択テキストを生成し、コピースタックへ追加する。
  const text = getSelectedText(editor, selections);
  pushClipStack(text);
}

/**
 * F8:
 * 選択範囲をWZ風コピースタックへ追加したうえで削除する。
 *
 * @returns {Promise<void>}
 */
async function cutToStack() {
  // 現在のエディターを取得し、未表示なら処理を終了する。
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const editorSelections = editor.selections;
  let selections;
  let cutsWholeLines;

  if (editorSelections.length === 1) {
    const selection = editorSelections[0];
    cutsWholeLines = selection.isEmpty;
    selections = cutsWholeLines
      ? [editor.document.lineAt(selection.active.line).rangeIncludingLineBreak]
      : editorSelections;
  } else {
    selections = editorSelections.filter((selection) => !selection.isEmpty);
    cutsWholeLines = selections.length === 0;

    if (cutsWholeLines) {
      const lineNumbers = new Set();
      for (const selection of editorSelections) {
        lineNumbers.add(selection.active.line);
      }

      selections = [...lineNumbers]
        .sort((a, b) => a - b)
        .map((lineNumber) => editor.document.lineAt(lineNumber).rangeIncludingLineBreak);
    }
  }

  const bytes = cutsWholeLines
    ? selectionRangesBytes(editor, selections)
    : selectedTextBytes(editor, selections);
  const { itemBytes } = cachedClipStackLimits;
  if (bytes > itemBytes) {
    showClipItemTooLargeMessage();
    return;
  }

  // 行切り取りは元の改行を保持し、通常選択は選択間に文書の改行を挿入する。
  const text = cutsWholeLines
    ? getWholeLineText(editor, selections)
    : getSelectedText(editor, selections);

  // 削除前に保存可能か検証し、容量超過時のデータ消失を防ぐ。
  const item = prepareClipItem(text);
  if (!item) {
    return;
  }

  /**
   * 切り取り対象の選択範囲を文書から削除する。
   *
   * @param {vscode.TextEditorEdit} editBuilder 編集操作のビルダー。
   * @returns {void}
   */
  function deleteSelections(editBuilder) {
    // すべての対象範囲を1回の編集として削除する。
    for (const selection of selections) {
      editBuilder.delete(selection);
    }
  }

  // 選択範囲を直接指定し、現在の表示選択に依存せず正確に削除する。
  const edited = await editor.edit(
    deleteSelections,
    {
      undoStopBefore: true,
      undoStopAfter: true
    }
  );

  // 編集が成功したときだけスタックへ積む。
  if (edited) {
    pushPreparedClipItem(item);
  }
}

/**
 * F9 / Shift+F9共通:
 * コピースタック先頭を現在位置へ挿入。
 * popAfterPaste=true のときだけ、貼り付け成功後に先頭を消費する。
 *
 * @param {boolean} popAfterPaste 貼り付け成功後に項目を削除する場合はtrue。
 * @returns {Promise<void>}
 */
async function pasteFromStack(popAfterPaste) {
  // 現在のエディターを取得し、未表示なら処理を終了する。
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // 貼り付け対象がなければユーザーへ通知する。
  if (isClipStackEmpty()) {
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('WZ Operation: The copy stack is empty.'),
      2000
    );
    return;
  }

  // LIFOスタックの最新項目を貼り付け対象として取得する。
  const item = getLatestClipItem();

  // 複数カーソルを含む論理データ量が設定された合計容量上限を超えないか検査する。
  const { totalBytes, totalMiB } = cachedClipStackLimits;
  if (item.bytes > Math.floor(totalBytes / editor.selections.length)) {
    vscode.window.setStatusBarMessage(
      vscode.l10n.t(
        'WZ Operation: The paste exceeds the total copy-stack capacity ({0} MiB) and cannot be performed.',
        totalMiB
      ),
      3000
    );
    return;
  }

  /**
   * 各カーソル位置または選択範囲へスタックの項目を設定する。
   *
   * @param {vscode.TextEditorEdit} editBuilder 編集操作のビルダー。
   * @returns {void}
   */
  function replaceSelectionsWithClipItem(editBuilder) {
    // 複数箇所への置換を1回の編集として実行する。
    for (const selection of editor.selections) {
      editBuilder.replace(selection, item.text);
    }
  }

  // すべてのカーソル位置または選択範囲へ同じ項目を貼り付ける。
  const edited = await editor.edit(
    replaceSelectionsWithClipItem,
    {
      undoStopBefore: true,
      undoStopAfter: true
    }
  );

  // F9では編集成功後だけ項目を消費し、失敗時はスタックに残す。
  if (edited && popAfterPaste) {
    popLatestClipItem();
  }
}

/**
 * コピースタックの最新項目を貼り付け、成功後に消費する。
 *
 * @returns {Promise<void>}
 */
function pasteAndPopStack() {
  // F9用として消費フラグを有効にして共通処理を呼び出す。
  return pasteFromStack(true);
}

/**
 * コピースタックの最新項目を、スタックへ残したまま貼り付ける。
 *
 * @returns {Promise<void>}
 */
function pasteStack() {
  // Shift+F9用として消費フラグを無効にして共通処理を呼び出す。
  return pasteFromStack(false);
}

/**
 * コピースタック設定の変更を処理する。
 *
 * @param {vscode.ConfigurationChangeEvent} event 設定変更イベント。
 * @returns {void}
 */
function handleConfigurationChange(event) {
  // コピースタック容量設定の変更有無をまとめて確認する。
  const totalChanged = event.affectsConfiguration(
    'wzOperation.copyStack.maxTotalSizeMiB'
  );
  const itemChanged = event.affectsConfiguration(
    'wzOperation.copyStack.maxItemSizeMiB'
  );
  if (totalChanged || itemChanged) {
    // 変更後の設定値でキャッシュを再構築する。
    refreshClipStackLimits();

    // 合計上限が縮小された可能性があるため、保持中の項目を整理する。
    trimClipStackToConfiguredLimit();
  }

  // 選択開始時のIME切り替え設定が変更されたか確認する。
  const imeOffChanged = event.affectsConfiguration(
    'wzOperation.keyboard.turnImeOffWhenSelectionStarts'
  );
  if (!imeOffChanged) {
    return;
  }

  // OFFからONへ戻した場合に、以前の一時的な起動失敗を解除して再試行できるようにする。
  const wasImeOffEnabled = cachedTurnImeOffWhenSelectionStarts;
  refreshImeOffSetting();
  if (!wasImeOffEnabled && cachedTurnImeOffWhenSelectionStarts) {
    imeOffHelperUnavailable = false;
    imeOffHelperFailureShown = false;
  }

  // 変更値を補助プロセスの起動状態へ直ちに反映する。
  synchronizeImeOffHelper();

  // 有効化直後に既存の非空選択があれば、その選択についてもIME OFFを要求する。
  if (cachedTurnImeOffWhenSelectionStarts) {
    refreshActiveEditorImeOffState();
  }
}

/**
 * 拡張機能を有効化し、設定監視と各コマンドを登録する。
 *
 * @param {vscode.ExtensionContext} context 拡張機能のコンテキスト。
 * @returns {Promise<void>}
 */
async function activate(context) {
  // コマンドや選択監視が動作する前に、現在の設定値をキャッシュへ反映する。
  refreshClipStackLimits();
  refreshImeOffSetting();

  // 実行アーキテクチャに対応するWindows専用補助プロセスのパスを保存して起動する。
  imeOffHelperPath = resolveImeOffHelperPath(context);
  imeOffHelperUnavailable = false;
  synchronizeImeOffHelper();

  // Windowsでだけ選択状態を初期化し、選択変更とフォーカス変更の監視を登録する。
  if (process.platform === 'win32') {
    for (const editor of vscode.window.visibleTextEditors) {
      initializeImeOffSelectionState(editor);
    }

    // フォーカス中の既存選択については、有効化直後にも1回だけIME OFFを要求する。
    if (vscode.window.state.focused) {
      refreshActiveEditorImeOffState();
    }

    // Windows固有の監視だけを、拡張機能終了時に破棄される購読へ追加する。
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(handleTextEditorSelectionChange),
      vscode.window.onDidChangeWindowState(handleWindowStateChange)
    );
  }

  // 共通の設定監視、補助プロセス終了処理、各コマンドを破棄対象へまとめる。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(handleConfigurationChange),
    new vscode.Disposable(stopImeOffHelper),
    vscode.workspace.onDidCloseTextDocument(clearPickedKeywordSelectionForDocument),
    vscode.commands.registerCommand(
      'wzOperation.pickKeywordAndAddSelection',
      pickKeywordAndAddSelection
    ),
    vscode.commands.registerCommand(
      'wzOperation.pastePickedKeyword',
      pastePickedKeyword
    ),
    vscode.commands.registerCommand('wzOperation.cutToStack', cutToStack),
    vscode.commands.registerCommand('wzOperation.copyToStack', copyToStack),
    vscode.commands.registerCommand('wzOperation.pasteAndPopStack', pasteAndPopStack),
    vscode.commands.registerCommand('wzOperation.pasteStack', pasteStack),
    vscode.commands.registerCommand(
      'wzOperation.resetEditContextWarningState',
      () => resetEditContextWarningState(context)
    )
  );

  // コマンド登録後、現在の設定に応じてバージョン単位の警告を行う。
  await warnIfEditContextEnabled(context);
}

/**
 * 拡張機能の終了処理を行う。
 *
 * @returns {void}
 */
function deactivate() {
  // 常駐補助プロセスを明示的に終了し、Extension Host終了後に残さない。
  stopImeOffHelper();

  // pickedKeyword / clipStack はExtension Host終了時に自然に破棄される。
}

module.exports = {
  activate,
  deactivate
};
