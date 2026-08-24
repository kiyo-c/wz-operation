#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Shiftを離してからF8を押すまでにIMEをOFFにできるよう、短い間隔で確認する。 */
#define MODIFIER_POLL_INTERVAL_MS 10UL

/* 現在のプロトコルでは最長コマンドが短いため、過大な入力を受け付けない。 */
#define COMMAND_BUFFER_SIZE 64U

/* Windowsが扱えるプロセス実行ファイルパスの上限まで照会できるようにする。 */
#define INITIAL_PATH_CAPACITY 512UL
#define MAXIMUM_PATH_CAPACITY 32768UL

/* Extension側が機能停止理由を判別できる、致命的なworker終了コード。 */
#define HELPER_EXIT_WORKER_WAIT_FAILED 20UL
#define HELPER_EXIT_SEND_INPUT_FAILED 21UL

/**
 * ワーカーへ渡す一件のIME OFF要求を表す。
 */
typedef struct ImeOffRequest {
    ULONGLONG generation;
    HWND foregroundWindow;
    DWORD foregroundProcessId;
} ImeOffRequest;

/**
 * メインスレッドとワーカースレッドが共有する状態を表す。
 */
typedef struct HelperState {
    CRITICAL_SECTION stateLock;
    CRITICAL_SECTION outputLock;
    HANDLE stateChangedEvent;
    HANDLE extensionHostProcess;
    HANDLE mainThread;
    wchar_t *extensionHostImagePath;
    BOOL stopping;
    BOOL mainLeavingInputLoop;
    BOOL hasPendingRequest;
    DWORD fatalExitCode;
    ULONGLONG generation;
    ImeOffRequest pendingRequest;
} HelperState;

/**
 * IME OFF要求をワーカーへ登録する前の検証結果を表す。
 */
typedef enum QueueResult {
    QUEUE_RESULT_OK,
    QUEUE_RESULT_NO_FOREGROUND_WINDOW,
    QUEUE_RESULT_PARENT_EXITED,
    QUEUE_RESULT_PROCESS_MISMATCH,
    QUEUE_RESULT_FOREGROUND_CHANGED,
    QUEUE_RESULT_PROCESS_QUERY_FAILED
} QueueResult;

/**
 * ワーカーによるIME OFF要求の処理結果を表す。
 */
typedef enum ImeOffResult {
    IME_OFF_RESULT_OK,
    IME_OFF_RESULT_CANCELED,
    IME_OFF_RESULT_PARENT_EXITED,
    IME_OFF_RESULT_FOREGROUND_CHANGED,
    IME_OFF_RESULT_MODIFIER_CHANGED,
    IME_OFF_RESULT_WAIT_FAILED,
    IME_OFF_RESULT_SEND_INPUT_FAILED
} ImeOffResult;

/**
 * 複数スレッドからの応答を、一行単位で混在させず標準出力へ書き込む。
 *
 * @param state 共有状態。
 * @param format printf互換の書式文字列。
 */
static void write_response(HelperState *state, const char *format, ...)
{
    va_list arguments;

    /* メインとワーカーの出力が同じ行で混ざらないよう排他する。 */
    EnterCriticalSection(&state->outputLock);
    va_start(arguments, format);
    (void)vprintf(format, arguments);
    va_end(arguments);
    (void)putchar('\n');
    LeaveCriticalSection(&state->outputLock);
}

/**
 * 指定した仮想キーが現在押されているかを判定する。
 *
 * @param virtualKey 判定対象のWindows仮想キーコード。
 * @return 押されている場合はTRUE、それ以外はFALSE。
 */
static BOOL is_virtual_key_pressed(int virtualKey)
{
    /* 上位ビットだけを参照し、呼出し間隔に依存する下位ビットは使用しない。 */
    return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
}

/**
 * IME OFF入力へ影響する修飾キーが一つでも押されているかを判定する。
 *
 * @return Shift、Ctrl、Alt、左右Windowsキーのいずれかが押されていればTRUE。
 */
static BOOL are_modifier_keys_pressed(void)
{
    /* 左右を包含する汎用キーと、個別に定義されるWindowsキーを確認する。 */
    return is_virtual_key_pressed(VK_SHIFT)
        || is_virtual_key_pressed(VK_CONTROL)
        || is_virtual_key_pressed(VK_MENU)
        || is_virtual_key_pressed(VK_LWIN)
        || is_virtual_key_pressed(VK_RWIN);
}

/**
 * 文字列から0より大きいWindowsプロセスIDを厳密に読み取る。
 *
 * @param text 10進数のプロセスID文字列。
 * @param processId 読み取ったプロセスIDを格納する領域。
 * @return 全体を正しく読み取れた場合はTRUE、それ以外はFALSE。
 */
static BOOL parse_process_id(const char *text, DWORD *processId)
{
    char *end;
    unsigned long value;

    /* 空文字、範囲外、数値に続く余分な文字をすべて拒否する。 */
    errno = 0;
    end = NULL;
    value = strtoul(text, &end, 10);
    if (errno == ERANGE
        || end == text
        || end == NULL
        || *end != '\0'
        || value == 0UL
        || value > MAXDWORD) {
        return FALSE;
    }

    *processId = (DWORD)value;
    return TRUE;
}

/**
 * 開いているプロセスハンドルから実行ファイルの完全パスを取得する。
 *
 * @param process 対象プロセスのハンドル。
 * @param errorCode 失敗時のWin32エラーコードを格納する領域。
 * @return 成功時はヒープ上のパス。失敗時はNULL。呼出し元がfreeする。
 */
static wchar_t *query_process_image_path(HANDLE process, DWORD *errorCode)
{
    DWORD capacity = INITIAL_PATH_CAPACITY;

    /* 長いインストール先にも対応するため、必要に応じてバッファを拡大する。 */
    while (capacity <= MAXIMUM_PATH_CAPACITY) {
        wchar_t *path = (wchar_t *)malloc((size_t)capacity * sizeof(wchar_t));
        DWORD length = capacity;

        if (path == NULL) {
            *errorCode = ERROR_NOT_ENOUGH_MEMORY;
            return NULL;
        }

        if (QueryFullProcessImageNameW(process, 0U, path, &length)) {
            /* 念のため終端位置も検証し、境界外への書込みを防ぐ。 */
            if (length < capacity) {
                path[length] = L'\0';
                *errorCode = ERROR_SUCCESS;
                return path;
            }

            *errorCode = ERROR_INSUFFICIENT_BUFFER;
            free(path);
        } else {
            *errorCode = GetLastError();
            free(path);
        }

        if (*errorCode != ERROR_INSUFFICIENT_BUFFER
            || capacity == MAXIMUM_PATH_CAPACITY) {
            return NULL;
        }

        capacity *= 2UL;
        if (capacity > MAXIMUM_PATH_CAPACITY) {
            capacity = MAXIMUM_PATH_CAPACITY;
        }
    }

    *errorCode = ERROR_INSUFFICIENT_BUFFER;
    return NULL;
}

/**
 * プロセスIDから照会用ハンドルを開き、実行ファイルの完全パスを取得する。
 *
 * @param processId 対象プロセスID。
 * @param errorCode 失敗時のWin32エラーコードを格納する領域。
 * @return 成功時はヒープ上のパス。失敗時はNULL。呼出し元がfreeする。
 */
static wchar_t *query_process_image_path_by_id(DWORD processId, DWORD *errorCode)
{
    HANDLE process;
    wchar_t *path;

    /* 実行ファイルパスの照会に必要な最小限のアクセス権だけで開く。 */
    process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
    if (process == NULL) {
        *errorCode = GetLastError();
        return NULL;
    }

    path = query_process_image_path(process, errorCode);
    CloseHandle(process);
    return path;
}

/**
 * Extension Hostプロセスが現在も動作しているかを確認する。
 *
 * @param state 共有状態。
 * @return 動作中の場合はTRUE、終了済みまたは確認失敗時はFALSE。
 */
static BOOL is_extension_host_running(const HelperState *state)
{
    /* 保持中のプロセスハンドルを非待機で確認し、PID再利用の影響を避ける。 */
    return WaitForSingleObject(state->extensionHostProcess, 0UL) == WAIT_TIMEOUT;
}

/**
 * 共有状態内の世代番号を一つ進める。
 *
 * 呼出し元はstateLockを保持していなければならない。
 *
 * @param state 共有状態。
 * @return 更新後の0ではない世代番号。
 */
static ULONGLONG advance_generation_locked(HelperState *state)
{
    /* 事実上到達しない周回時にも、0を予約値として残す。 */
    ++state->generation;
    if (state->generation == 0ULL) {
        ++state->generation;
    }

    return state->generation;
}

/**
 * 致命的なworker障害を記録し、メインスレッドのstdin待機を解除する。
 *
 * @param state 共有状態。
 * @param exitCode helperが返す0以外の終了コード。
 */
static void signal_fatal_failure(HelperState *state, DWORD exitCode)
{
    BOOL shouldInterrupt;

    /* 最初の障害コードを保持し、すべての要求を同時に無効化する。 */
    EnterCriticalSection(&state->stateLock);
    if (state->fatalExitCode == 0UL) {
        state->fatalExitCode = exitCode;
    }
    state->stopping = TRUE;
    (void)advance_generation_locked(state);
    state->hasPendingRequest = FALSE;
    SetEvent(state->stateChangedEvent);
    shouldInterrupt = !state->mainLeavingInputLoop;
    LeaveCriticalSection(&state->stateLock);

    /* fgets内部の同期ReadFileを取り消し、stdin入力がなくてもmainを終了処理へ進める。 */
    while (shouldInterrupt) {
        DWORD cancelError;

        if (CancelSynchronousIo(state->mainThread)) {
            return;
        }

        cancelError = GetLastError();
        EnterCriticalSection(&state->stateLock);
        shouldInterrupt = !state->mainLeavingInputLoop;
        LeaveCriticalSection(&state->stateLock);
        if (!shouldInterrupt) {
            return;
        }

        /* mainがReadFileへ入る直前なら、短時間後に再試行して競合を閉じる。 */
        if (cancelError == ERROR_NOT_FOUND) {
            Sleep(1UL);
            continue;
        }

        /* stdin待機を解除できない異常時は、誤動作を続けないよう即時に非0終了する。 */
        (void)TerminateProcess(GetCurrentProcess(), exitCode);
        return;
    }
}

/**
 * メインスレッドがstdinループを離れることをworkerへ通知する。
 *
 * @param state 共有状態。
 */
static void mark_main_leaving_input_loop(HelperState *state)
{
    /* workerが不要なCancelSynchronousIo再試行を続けないよう状態を共有する。 */
    EnterCriticalSection(&state->stateLock);
    state->mainLeavingInputLoop = TRUE;
    LeaveCriticalSection(&state->stateLock);
}

/**
 * 記録済みの致命的終了コードを取得する。
 *
 * @param state 共有状態。
 * @return 障害がなければ0、障害があれば0以外の終了コード。
 */
static DWORD get_fatal_exit_code(HelperState *state)
{
    DWORD exitCode;

    /* workerと競合しないよう、共有ロック内で終了コードを読み取る。 */
    EnterCriticalSection(&state->stateLock);
    exitCode = state->fatalExitCode;
    LeaveCriticalSection(&state->stateLock);
    return exitCode;
}

/**
 * 致命的なworker障害が記録されているかを確認する。
 *
 * @param state 共有状態。
 * @return 障害が記録済みならTRUE、それ以外はFALSE。
 */
static BOOL has_fatal_failure(HelperState *state)
{
    return get_fatal_exit_code(state) != 0UL;
}

/**
 * 指定世代の要求が現在も有効であるかを確認する。
 *
 * @param state 共有状態。
 * @param generation 確認対象の世代番号。
 * @return 停止中でなく最新世代と一致する場合はTRUE。
 */
static BOOL is_request_current(HelperState *state, ULONGLONG generation)
{
    BOOL current;

    /* cancel、新しいoff、終了要求のいずれでも世代が変わり、旧要求を無効化する。 */
    EnterCriticalSection(&state->stateLock);
    current = !state->stopping && state->generation == generation;
    LeaveCriticalSection(&state->stateLock);
    return current;
}

/**
 * VK_IME_OFFの押下・解放をWindowsの入力キューへ送信する。
 *
 * @param errorCode 失敗時のWin32エラーコードを格納する領域。
 * @return 押下・解放の両方を送信できた場合はTRUE、それ以外はFALSE。
 */
static BOOL send_ime_off_input(DWORD *errorCode)
{
    INPUT inputs[2];
    UINT sentCount;

    /* IME OFFキーのkeydownとkeyupを連続した一組の入力として構成する。 */
    ZeroMemory(inputs, sizeof(inputs));
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_IME_OFF;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = VK_IME_OFF;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;

    /* 戻り値とGetLastErrorの両方から注入結果を呼出し元へ伝える。 */
    SetLastError(ERROR_SUCCESS);
    sentCount = SendInput((UINT)(sizeof(inputs) / sizeof(inputs[0])), inputs, sizeof(INPUT));
    if (sentCount == (UINT)(sizeof(inputs) / sizeof(inputs[0]))) {
        *errorCode = ERROR_SUCCESS;
        return TRUE;
    }

    *errorCode = GetLastError();
    if (*errorCode == ERROR_SUCCESS) {
        *errorCode = ERROR_GEN_FAILURE;
    }

    /* keydownだけが送信された場合は、キー状態を残さないようkeyupを再送する。 */
    if (sentCount == 1U) {
        INPUT keyUp;

        ZeroMemory(&keyUp, sizeof(keyUp));
        keyUp.type = INPUT_KEYBOARD;
        keyUp.ki.wVk = VK_IME_OFF;
        keyUp.ki.dwFlags = KEYEVENTF_KEYUP;
        (void)SendInput(1U, &keyUp, sizeof(INPUT));
    }

    return FALSE;
}

/**
 * 修飾キーが離れるまで待ちながら、世代変更を即座に検知する。
 *
 * @param state 共有状態。
 * @param request 処理中の要求。
 * @param errorCode 待機API失敗時のWin32エラーコードを格納する領域。
 * @return 送信前確認へ進める場合はIME_OFF_RESULT_OK、それ以外は中止理由。
 */
static ImeOffResult wait_until_modifiers_released(
    HelperState *state,
    const ImeOffRequest *request,
    DWORD *errorCode)
{
    /* 選択操作中のShiftなどが離れるまで、状態変更イベント付きで監視する。 */
    while (are_modifier_keys_pressed()) {
        DWORD waitResult;

        /* 新offまたはcancelを受けた旧要求は、次のポーリングを待たず中止する。 */
        if (!is_request_current(state, request->generation)) {
            return IME_OFF_RESULT_CANCELED;
        }

        /* 状態変更イベントなら即復帰し、通常時だけ短いタイムアウトでキーを再確認する。 */
        waitResult = WaitForSingleObject(
            state->stateChangedEvent,
            MODIFIER_POLL_INTERVAL_MS);
        if (waitResult == WAIT_FAILED) {
            *errorCode = GetLastError();
            return IME_OFF_RESULT_WAIT_FAILED;
        }
    }

    /* 修飾キー解放と同時に世代が変わった場合も、送信処理へ進ませない。 */
    if (!is_request_current(state, request->generation)) {
        return IME_OFF_RESULT_CANCELED;
    }

    return IME_OFF_RESULT_OK;
}

/**
 * 最新性と入力先を最終確認し、一件のIME OFF要求を処理する。
 *
 * @param state 共有状態。
 * @param request 処理対象の要求。
 * @param errorCode Win32 API失敗時のエラーコードを格納する領域。
 * @return 要求の処理結果。
 */
static ImeOffResult perform_ime_off(
    HelperState *state,
    const ImeOffRequest *request,
    DWORD *errorCode)
{
    ImeOffResult waitResult;
    DWORD currentForegroundProcessId = 0UL;

    *errorCode = ERROR_SUCCESS;

    /* メインスレッドを塞がず、ワーカー内だけで修飾キー解放を待つ。 */
    waitResult = wait_until_modifiers_released(state, request, errorCode);
    if (waitResult != IME_OFF_RESULT_OK) {
        return waitResult;
    }

    /* 最終確認からSendInputまで世代を固定し、cancelとの競合区間を最小化する。 */
    EnterCriticalSection(&state->stateLock);
    if (state->stopping || state->generation != request->generation) {
        LeaveCriticalSection(&state->stateLock);
        return IME_OFF_RESULT_CANCELED;
    }

    /* Extension Hostが終了済みなら、それ以降のウィンドウへ入力を送らない。 */
    if (!is_extension_host_running(state)) {
        LeaveCriticalSection(&state->stateLock);
        return IME_OFF_RESULT_PARENT_EXITED;
    }

    /* HWND、所有PID、現在の前面ウィンドウをすべて照合してハンドル再利用も防ぐ。 */
    if (!IsWindow(request->foregroundWindow)
        || GetForegroundWindow() != request->foregroundWindow
        || GetWindowThreadProcessId(
            request->foregroundWindow,
            &currentForegroundProcessId) == 0UL
        || currentForegroundProcessId != request->foregroundProcessId) {
        LeaveCriticalSection(&state->stateLock);
        return IME_OFF_RESULT_FOREGROUND_CHANGED;
    }

    /* 最終確認時に新たな修飾キーが押されていれば、安全側へ倒して送信を中止する。 */
    if (are_modifier_keys_pressed()) {
        LeaveCriticalSection(&state->stateLock);
        return IME_OFF_RESULT_MODIFIER_CHANGED;
    }

    /* 最新要求かつ同一ウィンドウである間だけ、IME OFFキーを一度送信する。 */
    if (!send_ime_off_input(errorCode)) {
        LeaveCriticalSection(&state->stateLock);
        return IME_OFF_RESULT_SEND_INPUT_FAILED;
    }

    LeaveCriticalSection(&state->stateLock);
    return IME_OFF_RESULT_OK;
}

/**
 * ワーカー処理結果を世代番号付きの一行応答として出力する。
 *
 * @param state 共有状態。
 * @param request 完了した要求。
 * @param result 要求の処理結果。
 * @param errorCode Win32 API失敗時のエラーコード。
 */
static void write_ime_off_result(
    HelperState *state,
    const ImeOffRequest *request,
    ImeOffResult result,
    DWORD errorCode)
{
    const unsigned long long generation = (unsigned long long)request->generation;

    /* 成功、取り消し、安全上の中止、Win32 API失敗を明確に区別する。 */
    switch (result) {
        case IME_OFF_RESULT_OK:
            write_response(state, "ok off %llu", generation);
            break;
        case IME_OFF_RESULT_CANCELED:
            write_response(state, "skip canceled %llu", generation);
            break;
        case IME_OFF_RESULT_PARENT_EXITED:
            write_response(state, "skip parent-exited %llu", generation);
            break;
        case IME_OFF_RESULT_FOREGROUND_CHANGED:
            write_response(state, "skip foreground-changed %llu", generation);
            break;
        case IME_OFF_RESULT_MODIFIER_CHANGED:
            write_response(state, "skip modifier-changed %llu", generation);
            break;
        case IME_OFF_RESULT_WAIT_FAILED:
            write_response(
                state,
                "error wait %llu %lu",
                generation,
                (unsigned long)errorCode);
            break;
        case IME_OFF_RESULT_SEND_INPUT_FAILED:
            write_response(
                state,
                "error send-input %llu %lu",
                generation,
                (unsigned long)errorCode);
            break;
        default:
            write_response(state, "error internal-result %llu", generation);
            break;
    }
}

/**
 * 共有スロットから最新の待機要求を一件だけ取り出す。
 *
 * @param state 共有状態。
 * @param request 取り出した要求を格納する領域。
 * @param stopping 停止要求の有無を格納する領域。
 * @return 要求を取り出した場合はTRUE、待機すべき場合はFALSE。
 */
static BOOL take_latest_request(
    HelperState *state,
    ImeOffRequest *request,
    BOOL *stopping)
{
    BOOL hasRequest = FALSE;

    /* 一つだけの共有スロットを使い、古い待機要求を蓄積しない。 */
    EnterCriticalSection(&state->stateLock);
    *stopping = state->stopping;
    if (!state->stopping && state->hasPendingRequest) {
        *request = state->pendingRequest;
        state->hasPendingRequest = FALSE;
        hasRequest = TRUE;
    }

    /* ロック中にリセットし、メイン側のSetEventとの取りこぼしを防ぐ。 */
    ResetEvent(state->stateChangedEvent);
    LeaveCriticalSection(&state->stateLock);
    return hasRequest;
}

/**
 * 最新のIME OFF要求だけを非同期に処理する常駐ワーカー。
 *
 * @param parameter HelperStateへのポインタ。
 * @return 正常終了時は0、待機API失敗時はWin32エラーコード。
 */
static DWORD WINAPI worker_thread_main(LPVOID parameter)
{
    HelperState *state = (HelperState *)parameter;

    /* 新しい要求、cancel、終了のいずれかが通知されるまで待機する。 */
    for (;;) {
        DWORD eventResult = WaitForSingleObject(state->stateChangedEvent, INFINITE);
        ImeOffRequest request = {0};
        BOOL stopping;

        if (eventResult == WAIT_FAILED) {
            const DWORD errorCode = GetLastError();

            write_response(state, "error worker-wait %lu", (unsigned long)errorCode);
            signal_fatal_failure(state, HELPER_EXIT_WORKER_WAIT_FAILED);
            return errorCode;
        }

        if (!take_latest_request(state, &request, &stopping)) {
            if (stopping) {
                return 0UL;
            }

            continue;
        }

        /* 待機と送信はワーカー内で行い、メインは次のstdinコマンドを読み続ける。 */
        {
            DWORD errorCode;
            const ImeOffResult result = perform_ime_off(state, &request, &errorCode);

            /* 終了処理中は追加応答を抑止し、exit応答を最後の出力にする。 */
            EnterCriticalSection(&state->stateLock);
            stopping = state->stopping;
            LeaveCriticalSection(&state->stateLock);
            if (!stopping) {
                write_ime_off_result(state, &request, result, errorCode);

                /* 待機機構またはSendInputの故障後は、機能を継続せず非0終了する。 */
                if (result == IME_OFF_RESULT_WAIT_FAILED) {
                    signal_fatal_failure(state, HELPER_EXIT_WORKER_WAIT_FAILED);
                    return HELPER_EXIT_WORKER_WAIT_FAILED;
                }
                if (result == IME_OFF_RESULT_SEND_INPUT_FAILED) {
                    signal_fatal_failure(state, HELPER_EXIT_SEND_INPUT_FAILED);
                    return HELPER_EXIT_SEND_INPUT_FAILED;
                }
            }
        }
    }
}

/**
 * 前面ウィンドウとExtension Hostの実行ファイルを照合し、最新要求を登録する。
 *
 * @param state 共有状態。
 * @param queuedGeneration 登録した世代番号を格納する領域。
 * @param coalescedGeneration 上書きした待機要求の世代番号を格納する領域。
 * @param didCoalesce 待機要求を上書きしたかを格納する領域。
 * @param errorCode プロセス照会失敗時のWin32エラーコードを格納する領域。
 * @return 登録結果。
 */
static QueueResult queue_ime_off_request(
    HelperState *state,
    ULONGLONG *queuedGeneration,
    ULONGLONG *coalescedGeneration,
    BOOL *didCoalesce,
    DWORD *errorCode)
{
    HWND foregroundWindow;
    DWORD foregroundProcessId = 0UL;
    wchar_t *foregroundImagePath;

    *queuedGeneration = 0ULL;
    *coalescedGeneration = 0ULL;
    *didCoalesce = FALSE;
    *errorCode = ERROR_SUCCESS;

    /* offを読み取った直後の前面HWNDを、以降の入力先として固定する。 */
    foregroundWindow = GetForegroundWindow();
    if (foregroundWindow == NULL) {
        return QUEUE_RESULT_NO_FOREGROUND_WINDOW;
    }

    if (!is_extension_host_running(state)) {
        return QUEUE_RESULT_PARENT_EXITED;
    }

    /* 前面ウィンドウを所有するプロセスの実行ファイルパスを取得する。 */
    if (GetWindowThreadProcessId(foregroundWindow, &foregroundProcessId) == 0UL
        || foregroundProcessId == 0UL) {
        *errorCode = GetLastError();
        if (*errorCode == ERROR_SUCCESS) {
            *errorCode = ERROR_INVALID_WINDOW_HANDLE;
        }
        return QUEUE_RESULT_PROCESS_QUERY_FAILED;
    }

    foregroundImagePath = query_process_image_path_by_id(foregroundProcessId, errorCode);
    if (foregroundImagePath == NULL) {
        return QUEUE_RESULT_PROCESS_QUERY_FAILED;
    }

    /* 別アプリのウィンドウへIME OFFを送らないよう、実行ファイルを比較する。 */
    if (_wcsicmp(foregroundImagePath, state->extensionHostImagePath) != 0) {
        free(foregroundImagePath);
        return QUEUE_RESULT_PROCESS_MISMATCH;
    }
    free(foregroundImagePath);

    /* パス照会中にフォーカスまたはHWNDの所有者が変わった場合は受け付けない。 */
    {
        DWORD currentForegroundProcessId = 0UL;

        if (GetForegroundWindow() != foregroundWindow
            || GetWindowThreadProcessId(
                foregroundWindow,
                &currentForegroundProcessId) == 0UL
            || currentForegroundProcessId != foregroundProcessId) {
            return QUEUE_RESULT_FOREGROUND_CHANGED;
        }
    }

    /* 世代を進め、未処理スロットを最新要求で置き換えてワーカーを起こす。 */
    EnterCriticalSection(&state->stateLock);
    if (state->stopping) {
        LeaveCriticalSection(&state->stateLock);
        return QUEUE_RESULT_PARENT_EXITED;
    }

    *didCoalesce = state->hasPendingRequest;
    if (*didCoalesce) {
        *coalescedGeneration = state->pendingRequest.generation;
    }

    *queuedGeneration = advance_generation_locked(state);
    state->pendingRequest.generation = *queuedGeneration;
    state->pendingRequest.foregroundWindow = foregroundWindow;
    state->pendingRequest.foregroundProcessId = foregroundProcessId;
    state->hasPendingRequest = TRUE;
    SetEvent(state->stateChangedEvent);
    LeaveCriticalSection(&state->stateLock);
    return QUEUE_RESULT_OK;
}

/**
 * offコマンドを検証・登録し、即時受付結果を出力する。
 *
 * @param state 共有状態。
 */
static void handle_off_command(HelperState *state)
{
    ULONGLONG queuedGeneration;
    ULONGLONG coalescedGeneration;
    BOOL didCoalesce;
    DWORD errorCode;
    QueueResult result;

    /* 前面ウィンドウを即記録し、安全な場合だけ共有スロットへ登録する。 */
    result = queue_ime_off_request(
        state,
        &queuedGeneration,
        &coalescedGeneration,
        &didCoalesce,
        &errorCode);

    /* 非同期の完了応答とは別に、コマンドの受付結果を直ちに返す。 */
    switch (result) {
        case QUEUE_RESULT_OK:
            if (didCoalesce) {
                write_response(
                    state,
                    "skip coalesced %llu",
                    (unsigned long long)coalescedGeneration);
            }
            write_response(
                state,
                "ok queued %llu",
                (unsigned long long)queuedGeneration);
            break;
        case QUEUE_RESULT_NO_FOREGROUND_WINDOW:
            write_response(state, "skip no-foreground");
            break;
        case QUEUE_RESULT_PARENT_EXITED:
            write_response(state, "skip parent-exited");
            break;
        case QUEUE_RESULT_PROCESS_MISMATCH:
            write_response(state, "skip process-mismatch");
            break;
        case QUEUE_RESULT_FOREGROUND_CHANGED:
            write_response(state, "skip foreground-changed");
            break;
        case QUEUE_RESULT_PROCESS_QUERY_FAILED:
            write_response(
                state,
                "error process-query %lu",
                (unsigned long)errorCode);
            break;
        default:
            write_response(state, "error internal-queue-result");
            break;
    }
}

/**
 * 現在の待機・処理中要求を世代更新により無効化する。
 *
 * @param state 共有状態。
 * @return cancelに割り当てた新しい世代番号。
 */
static ULONGLONG cancel_ime_off_request(HelperState *state)
{
    ULONGLONG generation;

    /* 未処理スロットを空にし、処理中ワーカーをイベントで即座に起こす。 */
    EnterCriticalSection(&state->stateLock);
    generation = advance_generation_locked(state);
    state->hasPendingRequest = FALSE;
    SetEvent(state->stateChangedEvent);
    LeaveCriticalSection(&state->stateLock);
    return generation;
}

/**
 * ワーカーへ停止を通知し、処理中要求を同時に無効化する。
 *
 * @param state 共有状態。
 */
static void request_worker_stop(HelperState *state)
{
    /* stoppingと世代更新を同じロック内で行い、停止後の送信を禁止する。 */
    EnterCriticalSection(&state->stateLock);
    state->stopping = TRUE;
    (void)advance_generation_locked(state);
    state->hasPendingRequest = FALSE;
    SetEvent(state->stateChangedEvent);
    LeaveCriticalSection(&state->stateLock);
}

/**
 * fgetsで読み込んだコマンド末尾の改行文字を取り除く。
 *
 * @param line 終端済みの文字列バッファ。
 */
static void trim_line_ending(char *line)
{
    size_t length = strlen(line);

    /* LFと、その直前に残る可能性があるCRを順に除去する。 */
    while (length > 0U && (line[length - 1U] == '\n' || line[length - 1U] == '\r')) {
        line[length - 1U] = '\0';
        --length;
    }
}

/**
 * コマンドバッファへ収まらなかった一行の残りを標準入力から破棄する。
 */
static void discard_remaining_line(void)
{
    int character;

    /* 次のコマンドへ断片が混入しないよう、改行またはEOFまで読み捨てる。 */
    do {
        character = getchar();
    } while (character != '\n' && character != EOF);
}

/**
 * HelperStateが保持するWindows資源とメモリを解放する。
 *
 * ワーカースレッドが終了済みであることを呼出し元が保証する。
 *
 * @param state 解放対象の共有状態。
 */
static void destroy_helper_state(HelperState *state)
{
    /* 作成時と逆順に、ハンドル、パス、同期オブジェクトを解放する。 */
    if (state->stateChangedEvent != NULL) {
        CloseHandle(state->stateChangedEvent);
    }
    if (state->extensionHostProcess != NULL) {
        CloseHandle(state->extensionHostProcess);
    }
    if (state->mainThread != NULL) {
        CloseHandle(state->mainThread);
    }
    free(state->extensionHostImagePath);
    DeleteCriticalSection(&state->outputLock);
    DeleteCriticalSection(&state->stateLock);
}

/**
 * 親プロセスとの非同期一行コマンドプロトコルを実行する。
 *
 * 起動引数にはExtension HostのプロセスIDを一つ指定する。
 * 対応コマンドはping、off、cancel、exit。
 *
 * @param argumentCount 起動引数の個数。
 * @param arguments 起動引数の配列。
 * @return 正常終了時は0、起動に失敗した場合は0以外。
 */
int main(int argumentCount, char **arguments)
{
    HelperState state;
    DWORD extensionHostProcessId;
    DWORD errorCode;
    HANDLE workerThread;
    char command[COMMAND_BUFFER_SIZE];
    BOOL exitRequested = FALSE;

    /* どの終了経路でも安全に解放できるよう、共有状態を初期化する。 */
    ZeroMemory(&state, sizeof(state));
    InitializeCriticalSection(&state.stateLock);
    InitializeCriticalSection(&state.outputLock);
    (void)setvbuf(stdout, NULL, _IONBF, 0);

    /* PIDを必須にし、実行ファイル照合を省略した危険な起動を許可しない。 */
    if (argumentCount != 2 || !parse_process_id(arguments[1], &extensionHostProcessId)) {
        puts("error invalid-extension-host-pid");
        DeleteCriticalSection(&state.outputLock);
        DeleteCriticalSection(&state.stateLock);
        return 2;
    }

    /* PID再利用を避けるためExtension Hostのプロセスハンドルを終了まで保持する。 */
    state.extensionHostProcess = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
        FALSE,
        extensionHostProcessId);
    if (state.extensionHostProcess == NULL) {
        printf("error open-extension-host %lu\n", (unsigned long)GetLastError());
        DeleteCriticalSection(&state.outputLock);
        DeleteCriticalSection(&state.stateLock);
        return 3;
    }

    state.extensionHostImagePath = query_process_image_path(
        state.extensionHostProcess,
        &errorCode);
    if (state.extensionHostImagePath == NULL) {
        printf("error query-extension-host %lu\n", (unsigned long)errorCode);
        destroy_helper_state(&state);
        return 4;
    }

    /* workerがstdin待機を安全に解除できるよう、mainの実ハンドルを保持する。 */
    if (!DuplicateHandle(
        GetCurrentProcess(),
        GetCurrentThread(),
        GetCurrentProcess(),
        &state.mainThread,
        THREAD_TERMINATE,
        FALSE,
        0UL)) {
        printf("error duplicate-main-thread %lu\n", (unsigned long)GetLastError());
        destroy_helper_state(&state);
        return 5;
    }

    /* 手動リセットイベントで最新要求、cancel、終了をワーカーへ通知する。 */
    state.stateChangedEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (state.stateChangedEvent == NULL) {
        printf("error create-event %lu\n", (unsigned long)GetLastError());
        destroy_helper_state(&state);
        return 6;
    }

    workerThread = CreateThread(NULL, 0U, worker_thread_main, &state, 0U, NULL);
    if (workerThread == NULL) {
        printf("error create-worker %lu\n", (unsigned long)GetLastError());
        destroy_helper_state(&state);
        return 7;
    }

    puts("ready 2");

    /* ワーカーの待機中も、メインスレッドはstdinコマンドを読み続ける。 */
    while (!exitRequested
        && !has_fatal_failure(&state)
        && fgets(command, (int)sizeof(command), stdin) != NULL) {
        const size_t length = strlen(command);
        const BOOL hasLineEnding = length > 0U && command[length - 1U] == '\n';

        /* バッファを超える入力は全体を破棄し、コマンドとして部分実行しない。 */
        if (!hasLineEnding && !feof(stdin)) {
            discard_remaining_line();
            write_response(&state, "error line-too-long");
            continue;
        }

        trim_line_ending(command);

        /* 既知のコマンドだけを処理し、未知入力は副作用なく拒否する。 */
        if (strcmp(command, "ping") == 0) {
            write_response(&state, "ok pong");
        } else if (strcmp(command, "off") == 0) {
            handle_off_command(&state);
        } else if (strcmp(command, "cancel") == 0) {
            const ULONGLONG generation = cancel_ime_off_request(&state);

            write_response(
                &state,
                "ok cancel %llu",
                (unsigned long long)generation);
        } else if (strcmp(command, "exit") == 0) {
            exitRequested = TRUE;
        } else if (command[0] == '\0') {
            write_response(&state, "error empty-command");
        } else {
            write_response(&state, "error unknown-command");
        }
    }

    /* exit、EOF、worker障害のいずれでもstdinを離れたことを先に通知する。 */
    mark_main_leaving_input_loop(&state);

    /* すべての要求を無効化し、ワーカー終了を確実に待つ。 */
    request_worker_stop(&state);
    (void)WaitForSingleObject(workerThread, INFINITE);
    CloseHandle(workerThread);

    errorCode = get_fatal_exit_code(&state);
    if (exitRequested && errorCode == 0UL) {
        write_response(&state, "ok exit");
    }

    destroy_helper_state(&state);
    return errorCode == 0UL ? 0 : (int)errorCode;
}
