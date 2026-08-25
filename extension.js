'use strict';

const vscode = require('vscode');

// -----------------------------------------------------------------------------
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
let mirroredClipboardItem;
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
 * @param {number} [knownBytes] 事前計算済みのUTF-16換算容量。
 * @returns {{text: string, bytes: number}|null} 保存可能な項目。保存できない場合はnull。
 */
function prepareClipItem(text, knownBytes) {
  // 空文字列はスタックへ保存しない。
  if (!text) {
    return null;
  }

  // 文字列生成後の実容量を現在の1項目上限と比較する。
  const bytes = knownBytes === undefined ? textBytes(text) : knownBytes;
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
 * 現在のコピースタック項目数と使用容量を一時的に表示する。
 *
 * @returns {void}
 */
function showClipStackStatus() {
  const itemCount = clipStack.length - clipStackHead;
  const usedMiB = (clipStackBytes / (1024 * 1024)).toFixed(1);
  vscode.window.setStatusBarMessage(
    vscode.l10n.t(
      'WZ Operation: Stack {0} items / {1} MiB',
      itemCount,
      usedMiB
    ),
    2000
  );
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

  // 選択範囲がなければ、各カーソルの現在行をコピー対象とする。
  const editorSelections = editor.selections;
  let selections;
  let copiesWholeLines;

  if (editorSelections.length === 1) {
    const selection = editorSelections[0];
    copiesWholeLines = selection.isEmpty;
    selections = copiesWholeLines
      ? [editor.document.lineAt(selection.active.line).rangeIncludingLineBreak]
      : editorSelections;
  } else {
    selections = editorSelections.filter(isNonEmptySelection);
    copiesWholeLines = selections.length === 0;

    if (copiesWholeLines) {
      // 同じ行に複数カーソルがある場合は、その行を1回だけコピーする。
      const lineNumbers = new Set();
      for (const selection of editorSelections) {
        lineNumbers.add(selection.active.line);
      }

      selections = [...lineNumbers]
        .sort((a, b) => a - b)
        .map((lineNumber) => editor.document.lineAt(lineNumber).rangeIncludingLineBreak);
    }
  }

  // 大きな文字列を生成する前に、選択範囲の容量が上限内か検査する。
  const { itemBytes, itemMiB } = cachedClipStackLimits;
  const bytes = copiesWholeLines
    ? selectionRangesBytes(editor, selections)
    : selectedTextBytes(editor, selections);
  if (bytes > itemBytes) {
    showConfiguredClipItemTooLargeMessage(itemMiB);
    return;
  }

  // 行コピーでは元の改行を保持し、通常選択では選択間に文書の改行を挿入する。
  const text = copiesWholeLines
    ? getWholeLineText(editor, selections)
    : getSelectedText(editor, selections);
  const item = prepareClipItem(text, bytes);
  if (item) {
    pushPreparedClipItem(item);
    await vscode.env.clipboard.writeText(text);
    mirroredClipboardItem = item;
    showClipStackStatus();
  }
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
  const { itemBytes, itemMiB } = cachedClipStackLimits;
  if (bytes > itemBytes) {
    showConfiguredClipItemTooLargeMessage(itemMiB);
    return;
  }

  // 行切り取りは元の改行を保持し、通常選択は選択間に文書の改行を挿入する。
  const text = cutsWholeLines
    ? getWholeLineText(editor, selections)
    : getSelectedText(editor, selections);

  // 削除前に保存可能か検証し、容量超過時のデータ消失を防ぐ。
  const item = prepareClipItem(text, bytes);
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
    await vscode.env.clipboard.writeText(text);
    mirroredClipboardItem = item;
    showClipStackStatus();
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
async function pasteClipItem(item) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return false;
  }

  const { totalBytes, totalMiB } = cachedClipStackLimits;
  if (item.bytes > Math.floor(totalBytes / editor.selections.length)) {
    vscode.window.setStatusBarMessage(
      vscode.l10n.t(
        'WZ Operation: The paste exceeds the total copy-stack capacity ({0} MiB) and cannot be performed.',
        totalMiB
      ),
      3000
    );
    return false;
  }

  return editor.edit(
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
}

async function pasteFromStack(popAfterPaste) {
  if (!vscode.window.activeTextEditor) {
    return;
  }


  // スタックを優先し、空の場合だけOSクリップボードへフォールバックする。
  const usesClipStack = !isClipStackEmpty();

  // OSクリップボードの内容はスタックへ追加せず、今回の貼り付けだけに使う。
  let item;
  if (usesClipStack) {
    item = getLatestClipItem();
  } else {
    const text = await vscode.env.clipboard.readText();
    if (!text) {
      vscode.window.setStatusBarMessage(
        vscode.l10n.t('WZ Operation: The copy stack and OS clipboard are empty.'),
        2000
      );
      return;
    }
    item = { text, bytes: textBytes(text) };
  }

  const edited = await pasteClipItem(item);

  // F9では、スタック由来の項目だけを編集成功後に消費する。
  if (edited && popAfterPaste) {
    if (usesClipStack) {
      const poppedItem = popLatestClipItem();
      if (poppedItem === mirroredClipboardItem) {
        const clipboardText = await vscode.env.clipboard.readText();
        if (clipboardText === poppedItem.text) {
          await vscode.env.clipboard.writeText('');
        }
        mirroredClipboardItem = undefined;
      }
    } else {
      await vscode.env.clipboard.writeText('');
      mirroredClipboardItem = undefined;
    }
  }
  if (edited) {
    showClipStackStatus();
  }
}

async function showCopyStack() {
  if (isClipStackEmpty()) {
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('WZ Operation: The copy stack is empty.'),
      2000
    );
    return;
  }

  const quickPickItems = [];
  let displayIndex = 1;
  for (let index = clipStack.length - 1; index >= clipStackHead; index--) {
    const item = clipStack[index];
    const preview = item.text.replace(/\s+/g, ' ').trim() || '␤';
    const shortenedPreview = preview.length > 80
      ? `${preview.slice(0, 80)}...`
      : preview;
    quickPickItems.push({
      label: `${displayIndex}: ${shortenedPreview}`,
      clipItem: item
    });
    displayIndex++;
  }

  const selected = await vscode.window.showQuickPick(quickPickItems, {
    placeHolder: vscode.l10n.t('Select a copy-stack item to paste')
  });
  if (selected) {
    const edited = await pasteClipItem(selected.clipItem);
    if (edited) {
      showClipStackStatus();
    }
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

  // 共通の設定監視と各コマンドを破棄対象へまとめる。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(handleConfigurationChange),
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
    vscode.commands.registerCommand('wzOperation.showCopyStack', showCopyStack),
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
  // pickedKeyword / clipStack はExtension Host終了時に自然に破棄される。
}

module.exports = {
  activate,
  deactivate
};
