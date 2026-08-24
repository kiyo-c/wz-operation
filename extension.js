'use strict';

const vscode = require('vscode');

// -----------------------------------------------------------------------------
// editor.editContext警告
// -----------------------------------------------------------------------------
const EDIT_CONTEXT_WARNING_STATE_KEY = 'editContextWarningState';
const EDIT_CONTEXT_WARNING_LIMIT = 2;
const EDIT_CONTEXT_WARNING_MESSAGE = '設定(setting.json)で "editor.editContext": true が指定されているため、IME使用中はF8の切り取りを利用できません。';
const OPEN_SETTINGS_ACTION = '設定を開く';

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
    'EditContextの通知状態をリセットしました。次回のVS Code起動時に通知を再判定します。'
  );
}

// -----------------------------------------------------------------------------
// F5系: キーワード専用バッファ
// -----------------------------------------------------------------------------
// OSクリップボード、F8/F9コピースタックとは完全に独立。
let pickedKeyword = '';
let pickedKeywordSelection = undefined;

function rememberPickedKeywordSelection(editor) {
  pickedKeywordSelection = {
    document: editor.document,
    selections: editor.selections
  };
}

function hasPickedKeywordSelection(editor) {
  const currentSelections = editor.selections;
  if (
    !pickedKeywordSelection ||
    pickedKeywordSelection.document !== editor.document ||
    pickedKeywordSelection.selections.length !== currentSelections.length
  ) {
    return false;
  }

  return pickedKeywordSelection.selections.every(
    (selection, index) => selection.isEqual(currentSelections[index])
  );
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
const MAX_CLIP_STACK_BYTES = 64 * 1024 * 1024;
const MAX_CLIP_ITEM_BYTES = 16 * 1024 * 1024;
const MAX_EDIT_PAYLOAD_BYTES = 64 * 1024 * 1024;
let clipStack = [];
let clipStackHead = 0;
let clipStackBytes = 0;

function textBytes(text) {
  // JavaScript文字列の実メモリ量と完全一致はしないが、
  // UTF-16LE換算で安全側の容量管理を行う。
  return text.length * 2;
}

function showClipItemTooLargeMessage() {
  vscode.window.setStatusBarMessage(
    'WZ操作: 選択内容が16 MiBを超えるためコピースタックへ保存できません',
    3000
  );
}

function prepareClipItem(text) {
  if (!text) {
    return null;
  }

  const bytes = textBytes(text);
  if (bytes > MAX_CLIP_ITEM_BYTES) {
    showClipItemTooLargeMessage();
    return null;
  }

  return { text, bytes };
}

function pushPreparedClipItem(item) {
  clipStack.push(item);
  clipStackBytes += item.bytes;

  // 容量上限を超えたら最古の項目から捨てる。
  while (
    clipStackBytes > MAX_CLIP_STACK_BYTES &&
    clipStackHead < clipStack.length
  ) {
    const oldest = clipStack[clipStackHead];
    clipStackBytes -= oldest.bytes;
    clipStack[clipStackHead] = undefined;
    clipStackHead++;
  }

  compactClipStackIfNeeded();

  return true;
}

function compactClipStackIfNeeded() {
  if (clipStackHead >= 1024 && clipStackHead * 2 >= clipStack.length) {
    clipStack = clipStack.slice(clipStackHead);
    clipStackHead = 0;
  }
}

function isClipStackEmpty() {
  return clipStackHead >= clipStack.length;
}

function getLatestClipItem() {
  if (isClipStackEmpty()) {
    return undefined;
  }

  return clipStack[clipStack.length - 1];
}

function popLatestClipItem() {
  const item = getLatestClipItem();
  if (!item) {
    return undefined;
  }

  clipStack.pop();
  clipStackBytes -= item.bytes;

  if (isClipStackEmpty()) {
    clipStack = [];
    clipStackHead = 0;
  }

  return item;
}

function pushClipStack(text) {
  const item = prepareClipItem(text);
  if (!item) {
    return false;
  }

  return pushPreparedClipItem(item);
}

function selectionRangesBytes(editor, selections) {
  let codeUnits = 0;
  for (const selection of selections) {
    const start = editor.document.offsetAt(selection.start);
    const end = editor.document.offsetAt(selection.end);
    codeUnits += end - start;
  }

  return codeUnits * 2;
}

function selectedTextBytes(editor, selections) {
  const eolCodeUnits = editor.document.eol === vscode.EndOfLine.CRLF ? 2 : 1;
  return (
    selectionRangesBytes(editor, selections) +
    eolCodeUnits * Math.max(0, selections.length - 1) * 2
  );
}

function getSelectedText(editor, selections) {
  if (selections.length === 1) {
    return editor.document.getText(selections[0]);
  }

  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  return selections
    .map((selection) => editor.document.getText(selection))
    .join(eol);
}

/**
 * F5:
 * 1. VS Code標準の「次の一致も選択」をそのまま実行。
 * 2. その結果できた選択範囲の文字列をF5専用バッファへ保存。
 */
async function pickKeywordAndAddSelection() {
  const editorBefore = vscode.window.activeTextEditor;
  if (!editorBefore) {
    return;
  }

  pickedKeywordSelection = undefined;

  // 既存のVS Code機能を直接呼ぶため、キーバインド再帰は起こらない。
  await vscode.commands.executeCommand('editor.action.addSelectionToNextFindMatch');

  if (vscode.window.activeTextEditor !== editorBefore) {
    return;
  }

  const selection = editorBefore.selections.find((s) => !s.isEmpty);
  if (!selection) {
    return;
  }

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
 */
async function pastePickedKeyword() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  if (pickedKeyword.length === 0) {
    vscode.window.setStatusBarMessage('WZ操作: 先にF5でキーワードを取得してください', 2500);
    return;
  }

  if (hasPickedKeywordSelection(editor)) {
    editor.selections = editor.selections.map(
      (selection) => new vscode.Selection(selection.end, selection.end)
    );
  }
  pickedKeywordSelection = undefined;

  await editor.edit(
    (editBuilder) => {
      for (const selection of editor.selections) {
        editBuilder.replace(selection, pickedKeyword);
      }
    },
    {
      undoStopBefore: true,
      undoStopAfter: true
    }
  );
}

/**
 * Shift+F8:
 * 選択範囲をWZ風コピースタックへ追加。元テキストは残す。
 */
async function copyToStack() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const selections = editor.selections.filter((selection) => !selection.isEmpty);
  if (selections.length === 0) {
    vscode.window.setStatusBarMessage('WZ操作: コピーする範囲を選択してください', 2000);
    return;
  }

  if (selectedTextBytes(editor, selections) > MAX_CLIP_ITEM_BYTES) {
    showClipItemTooLargeMessage();
    return;
  }

  const text = getSelectedText(editor, selections);
  pushClipStack(text);
}

/**
 * F8:
 * 選択範囲をWZ風コピースタックへ追加したうえで削除する。
 */
async function cutToStack() {
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
  if (bytes > MAX_CLIP_ITEM_BYTES) {
    showClipItemTooLargeMessage();
    return;
  }

  const text = cutsWholeLines
    ? selections.map((selection) => editor.document.getText(selection)).join('')
    : getSelectedText(editor, selections);

  // 削除前に保存可能か検証し、容量超過時のデータ消失を防ぐ。
  const item = prepareClipItem(text);
  if (!item) {
    return;
  }

  const edited = await editor.edit(
    (editBuilder) => {
      for (const selection of selections) {
        editBuilder.delete(selection);
      }
    },
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
 */
async function pasteFromStack(popAfterPaste) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  if (isClipStackEmpty()) {
    vscode.window.setStatusBarMessage('WZ操作: コピースタックが空です', 2000);
    return;
  }

  const item = getLatestClipItem();

  if (item.bytes > Math.floor(MAX_EDIT_PAYLOAD_BYTES / editor.selections.length)) {
    vscode.window.setStatusBarMessage(
      'WZ操作: 貼り付けるデータ量が64 MiBを超えるため実行できません',
      3000
    );
    return;
  }

  const edited = await editor.edit(
    (editBuilder) => {
      for (const selection of editor.selections) {
        editBuilder.replace(selection, item.text);
      }
    },
    {
      undoStopBefore: true,
      undoStopAfter: true
    }
  );

  if (edited && popAfterPaste) {
    popLatestClipItem();
  }
}

function pasteAndPopStack() {
  return pasteFromStack(true);
}

function pasteStack() {
  return pasteFromStack(false);
}

async function activate(context) {
  context.subscriptions.push(
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

function deactivate() {
  // pickedKeyword / clipStack はExtension Host終了時に自然に破棄される。
}

module.exports = {
  activate,
  deactivate
};
