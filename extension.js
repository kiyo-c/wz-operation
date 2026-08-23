'use strict';

const vscode = require('vscode');

// -----------------------------------------------------------------------------
// F5系: キーワード専用バッファ
// -----------------------------------------------------------------------------
// OSクリップボード、F8/F9コピースタックとは完全に独立。
let pickedKeyword = '';

// -----------------------------------------------------------------------------
// F8/F9系: WZ風コピースタック
// -----------------------------------------------------------------------------
// Extension Hostのメモリ上だけに保持するテキスト専用LIFOスタック。
// WZ本体の永続TEMPスタックとは異なり、VS Code再起動時に破棄される。
const MAX_CLIP_STACK_BYTES = 256 * 1024 * 1024; // 256 MiB
let clipStack = [];
let clipStackBytes = 0;

function textBytes(text) {
  // JavaScript文字列の実メモリ量と完全一致はしないが、
  // UTF-16LE換算で安全側の容量管理を行う。
  return Buffer.byteLength(text, 'utf16le');
}

function prepareClipItem(text) {
  if (!text) {
    return null;
  }

  const bytes = textBytes(text);
  if (bytes > MAX_CLIP_STACK_BYTES) {
    vscode.window.setStatusBarMessage(
      'WZ操作: 選択内容が256 MiBを超えるためコピースタックへ保存できません',
      3000
    );
    return null;
  }

  return { text, bytes };
}

function pushPreparedClipItem(item) {
  clipStack.unshift(item);
  clipStackBytes += item.bytes;

  // 容量上限を超えたら最古の項目から捨てる。
  while (clipStackBytes > MAX_CLIP_STACK_BYTES && clipStack.length > 0) {
    const oldest = clipStack.pop();
    clipStackBytes -= oldest.bytes;
  }

  return true;
}

function pushClipStack(text) {
  const item = prepareClipItem(text);
  if (!item) {
    return false;
  }

  return pushPreparedClipItem(item);
}

function getSelectedText(editor) {
  const nonEmptySelections = editor.selections.filter((selection) => !selection.isEmpty);
  if (nonEmptySelections.length === 0) {
    return '';
  }

  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  return nonEmptySelections
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

  // 既存のVS Code機能を直接呼ぶため、キーバインド再帰は起こらない。
  await vscode.commands.executeCommand('editor.action.addSelectionToNextFindMatch');

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const selection = editor.selections.find((s) => !s.isEmpty);
  if (!selection) {
    return;
  }

  const text = editor.document.getText(selection);
  if (text.length > 0) {
    pickedKeyword = text;
  }
}

/**
 * Shift+F5:
 * F5専用バッファのキーワードを現在位置へ挿入。
 * 選択範囲があれば置換し、複数カーソル時は各位置へ挿入する。
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

  const text = getSelectedText(editor);
  if (!text) {
    vscode.window.setStatusBarMessage('WZ操作: コピーする範囲を選択してください', 2000);
    return;
  }

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

  const selections = editor.selections.filter((selection) => !selection.isEmpty);
  if (selections.length === 0) {
    vscode.window.setStatusBarMessage('WZ操作: 切り取る範囲を選択してください', 2000);
    return;
  }

  const text = getSelectedText(editor);
  if (!text) {
    return;
  }

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

  if (clipStack.length === 0) {
    vscode.window.setStatusBarMessage('WZ操作: コピースタックが空です', 2000);
    return;
  }

  const item = clipStack[0];

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
    const removed = clipStack.shift();
    clipStackBytes -= removed.bytes;
  }
}

function pasteAndPopStack() {
  return pasteFromStack(true);
}

function pasteStack() {
  return pasteFromStack(false);
}

function activate(context) {
  context.subscriptions.push(
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
    vscode.commands.registerCommand('wzOperation.pasteStack', pasteStack)
  );
}

function deactivate() {
  // pickedKeyword / clipStack はExtension Host終了時に自然に破棄される。
}

module.exports = {
  activate,
  deactivate
};
