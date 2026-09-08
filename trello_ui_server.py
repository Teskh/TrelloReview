#!/usr/bin/env python3
"""Local Trello review workbench UI (stdlib only).

Starts an HTTP server that:
  - serves a small HTML UI
  - exposes JSON endpoints that read Trello using API_KEY/TOKEN from .env

Usage:
  python trello_ui_server.py
  python trello_ui_server.py --port 9266
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import errno
import json
import os
import mimetypes
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

if os.name == "nt":
    from ctypes import wintypes

from app_paths import resolve_app_paths
from trello_smoke_test import TrelloClient, load_dotenv
from workbench_store import (
    delete_local_file_for_card,
    delete_open_review_document,
    detect_mime_from_name,
    estimate_llm_input_tokens_for_card,
    ensure_card_workspace,
    get_card_workspace_info,
    get_card_workspace_status,
    get_index_for_card,
    get_local_file_path,
    get_open_review_documents_info,
    get_open_review_file_path,
    get_open_review_index,
    get_run_result,
    import_local_files_for_card,
    import_open_review_documents,
    init_workbench_paths,
    list_completed_run_cards,
    list_index_summaries,
    load_checklist,
    load_checklist_text,
    load_open_review_config,
    load_open_review_config_text,
    remove_index_sources_for_card,
    reset_checklist,
    reset_open_review_config,
    run_checklist_for_card,
    run_open_review_for_card,
    save_checklist,
    save_checklist_text,
    save_open_review_config,
    save_open_review_config_text,
    save_open_review_indexes,
    save_indexes_for_card,
    utc_now_iso,
)

try:
    import pystray
    from PIL import Image, ImageDraw
except Exception:  # pragma: no cover - optional in local dev, bundled for desktop app
    pystray = None
    Image = None
    ImageDraw = None

WINDOWS_SINGLE_INSTANCE_MUTEX: Any = None

APP_PATHS = resolve_app_paths()
ROOT_DIR = APP_PATHS.resource_root
UI_DIR = APP_PATHS.ui_dir
VALID_REASONING_EFFORTS = {"low", "medium", "high"}
VALID_OPENAI_MODELS = {"gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"}
VALID_OPENAI_SERVICE_TIERS = {"auto", "flex"}
DEFAULT_OPENAI_MODEL = "gpt-6-astra"
DEFAULT_OPENAI_SERVICE_TIER = "auto"
STARTUP_LOG_PATH = APP_PATHS.settings_root / "startup.log"


def startup_log(message: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    try:
        STARTUP_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with STARTUP_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    stream = getattr(sys, "stdout", None)
    if stream is not None:
        try:
            stream.write(line + "\n")
            stream.flush()
        except Exception:
            pass


def _serve_server(server: ThreadingHTTPServer, *, label: str) -> None:
    startup_log(f"{label}: server loop starting")
    try:
        server.serve_forever()
    except Exception:
        startup_log(f"{label}: server loop crashed\n{traceback.format_exc()}")
        raise
    finally:
        startup_log(f"{label}: server loop stopped")


@dataclass
class AppConfig:
    api_key: str
    token: str


@dataclass
class ReviewJob:
    job_id: str
    card_id: str
    card_name: str
    card_url: str
    model: str
    reasoning_effort: str
    requested_service_tier: str
    service_tier: str
    multimodal_limit_bytes: int | None
    status: str
    created_at: str
    updated_at: str
    run_type: str = "checklist"
    open_review_question: str | None = None
    open_review_system_prompt: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    run_id: str | None = None
    run_summary: Dict[str, Any] | None = None
    stage: str | None = None
    progress_message: str | None = None
    progress_current: int | None = None
    progress_total: int | None = None
    diagnostics: Dict[str, Any] | None = None
    error: str | None = None

    def to_payload(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "card": {
                "id": self.card_id,
                "name": self.card_name,
                "url": self.card_url,
            },
            "model": self.model,
            "reasoning_effort": self.reasoning_effort,
            "requested_service_tier": self.requested_service_tier,
            "service_tier": self.service_tier,
            "multimodal_limit_bytes": self.multimodal_limit_bytes,
            "run_type": self.run_type,
            "open_review_question": self.open_review_question,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "run_id": self.run_id,
            "run_summary": self.run_summary,
            "stage": self.stage,
            "progress_message": self.progress_message,
            "progress_current": self.progress_current,
            "progress_total": self.progress_total,
            "diagnostics": self.diagnostics,
            "error": self.error,
        }


class ReviewJobManager:
    def __init__(self, paths: Any) -> None:
        self._paths = paths
        self._lock = threading.Lock()
        self._jobs: Dict[str, ReviewJob] = {}

    def list_jobs(self) -> List[Dict[str, Any]]:
        with self._lock:
            jobs = [job.to_payload() for job in self._jobs.values()]
        jobs.sort(key=lambda row: (row.get("updated_at") or row.get("created_at") or ""), reverse=True)
        return jobs[:50]

    def start_job(
        self,
        *,
        card_id: str,
        card_name: str,
        card_url: str,
        card_packet: Dict[str, Any],
        model: str,
        reasoning_effort: str,
        service_tier: str,
        multimodal_limit_bytes: int | None,
        run_type: str = "checklist",
        open_review_question: str | None = None,
        open_review_system_prompt: str | None = None,
    ) -> tuple[Dict[str, Any], bool]:
        with self._lock:
            for job in self._jobs.values():
                if job.card_id == card_id and job.run_type == run_type and job.status in {"queued", "running"}:
                    return job.to_payload(), True

            now = utc_now_iso()
            job = ReviewJob(
                job_id=f"job_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}",
                card_id=card_id,
                card_name=card_name,
                card_url=card_url,
                model=model,
                reasoning_effort=reasoning_effort,
                requested_service_tier=service_tier,
                service_tier=service_tier,
                multimodal_limit_bytes=multimodal_limit_bytes,
                run_type=run_type,
                open_review_question=open_review_question,
                open_review_system_prompt=open_review_system_prompt,
                status="queued",
                created_at=now,
                updated_at=now,
            )
            self._jobs[job.job_id] = job

        worker = threading.Thread(
            target=self._run_job,
            kwargs={
                "job_id": job.job_id,
                "card_id": card_id,
                "card_name": card_name,
                "card_url": card_url,
                "card_packet": card_packet,
                "model": model,
                "reasoning_effort": reasoning_effort,
                "service_tier": service_tier,
                "multimodal_limit_bytes": multimodal_limit_bytes,
                "run_type": run_type,
                "open_review_question": open_review_question,
                "open_review_system_prompt": open_review_system_prompt,
            },
            daemon=True,
        )
        worker.start()
        return job.to_payload(), False

    def _run_job(
        self,
        *,
        job_id: str,
        card_id: str,
        card_name: str,
        card_url: str,
        card_packet: Dict[str, Any],
        model: str,
        reasoning_effort: str,
        service_tier: str,
        multimodal_limit_bytes: int | None,
        run_type: str,
        open_review_question: str | None,
        open_review_system_prompt: str | None,
    ) -> None:
        started_at = utc_now_iso()
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job.status = "running"
            job.started_at = started_at
            job.updated_at = started_at
            job.stage = "starting"
            job.progress_message = "Inicializando revisión abierta." if run_type == "open_review" else "Inicializando revisión."
            job.progress_current = None
            job.progress_total = None
            job.diagnostics = {"started_at": started_at}

        def report_progress(
            *,
            stage: str,
            message: str,
            current: int | None = None,
            total: int | None = None,
            diagnostics: Dict[str, Any] | None = None,
        ) -> None:
            with self._lock:
                job = self._jobs.get(job_id)
                if not job:
                    return
                job.stage = stage
                job.progress_message = message
                job.progress_current = current
                job.progress_total = total
                job.updated_at = utc_now_iso()
                merged = dict(job.diagnostics or {})
                if diagnostics:
                    merged.update(diagnostics)
                job.diagnostics = merged

        try:
            if run_type == "open_review":
                result = run_open_review_for_card(
                    self._paths,
                    card_id=card_id,
                    card_name=card_name,
                    card_url=card_url,
                    card_packet=card_packet,
                    question=open_review_question,
                    system_prompt=open_review_system_prompt,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    service_tier=service_tier,
                    multimodal_limit_bytes=multimodal_limit_bytes,
                    progress_callback=report_progress,
                )
            else:
                result = run_checklist_for_card(
                    self._paths,
                    card_id=card_id,
                    card_name=card_name,
                    card_url=card_url,
                    card_packet=card_packet,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    service_tier=service_tier,
                    multimodal_limit_bytes=multimodal_limit_bytes,
                    progress_callback=report_progress,
                )
            finished_at = utc_now_iso()
            run = result.get("run") or {}
            with self._lock:
                job = self._jobs.get(job_id)
                if not job:
                    return
                job.status = "succeeded"
                job.updated_at = finished_at
                job.finished_at = finished_at
                job.run_id = run.get("run_id")
                job.run_summary = run.get("summary") if isinstance(run, dict) else None
                job.service_tier = str(run.get("service_tier") or job.service_tier)
                job.stage = "done"
                job.progress_message = "Revisión abierta completada." if run_type == "open_review" else "Revisión completada."
                job.progress_current = None
                job.progress_total = None
                if isinstance(run, dict) and isinstance(run.get("diagnostics"), dict):
                    job.diagnostics = run.get("diagnostics")
                job.error = None
        except Exception as exc:
            finished_at = utc_now_iso()
            with self._lock:
                job = self._jobs.get(job_id)
                if not job:
                    return
                job.status = "failed"
                job.updated_at = finished_at
                job.finished_at = finished_at
                stage = job.stage or "unknown"
                job.error = f"[{stage}] {exc}"


def load_config() -> AppConfig:
    env: Dict[str, str] = {}
    for env_path in APP_PATHS.env_search_paths:
        env.update(load_dotenv(env_path))
    # Populate process env for other modules (e.g., checklist runs) that read OpenAI vars directly.
    for key in ("OPENAI_API_KEY", "OPENAI_MODEL"):
        if env.get(key) and not os.getenv(key):
            os.environ[key] = env[key]
    api_key = env.get("API_KEY") or os.getenv("API_KEY") or ""
    token = env.get("TOKEN") or os.getenv("TOKEN") or ""
    if not api_key or not token:
        raise RuntimeError("Faltan API_KEY/TOKEN en .env o en las variables de entorno")
    if any(ch in api_key for ch in "[]") or any(ch in token for ch in "[]"):
        raise RuntimeError("Reemplaza los valores de ejemplo en .env por API_KEY/TOKEN reales")
    return AppConfig(api_key=api_key, token=token)


def make_client(cfg: AppConfig) -> TrelloClient:
    return TrelloClient(api_key=cfg.api_key, token=cfg.token)


def maybe_show_error_dialog(title: str, message: str) -> None:
    if os.name != "nt" and not getattr(sys, "frozen", False):
        return
    try:
        import tkinter as tk
        from tkinter import messagebox
    except Exception:
        return

    root = None
    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        messagebox.showerror(title, message)
    except Exception:
        return
    finally:
        if root is not None:
            try:
                root.destroy()
            except Exception:
                pass


def _single_instance_mutex_name() -> str:
    return "Local\\TrelloReviewWorkbench"


def acquire_single_instance() -> bool:
    global WINDOWS_SINGLE_INSTANCE_MUTEX
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return True
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateMutexW(None, False, _single_instance_mutex_name())
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        return False
    WINDOWS_SINGLE_INSTANCE_MUTEX = handle
    return True


def release_single_instance() -> None:
    global WINDOWS_SINGLE_INSTANCE_MUTEX
    if not WINDOWS_SINGLE_INSTANCE_MUTEX or os.name != "nt":
        return
    try:
        ctypes.windll.kernel32.CloseHandle(WINDOWS_SINGLE_INSTANCE_MUTEX)
    except Exception:
        pass
    WINDOWS_SINGLE_INSTANCE_MUTEX = None


def open_browser_soon(url: str) -> None:
    def _open() -> None:
        try:
            webbrowser.open(url, new=1)
        except Exception:
            pass

    timer = threading.Timer(0.6, _open)
    timer.daemon = True
    timer.start()


def open_path_in_shell(path: Path) -> None:
    try:
        if hasattr(os, "startfile"):
            os.startfile(str(path))  # type: ignore[attr-defined]
            return
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
            return
        subprocess.Popen(["xdg-open", str(path)])
    except Exception:
        return


def probe_status(url: str, timeout: float = 1.5) -> bool:
    try:
        with urlopen(url, timeout=timeout) as resp:
            if resp.status != HTTPStatus.OK:
                return False
            payload = json.loads(resp.read().decode("utf-8"))
            return bool(payload.get("ok"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError):
        return False


def open_browser_when_ready(app_url: str, *, wait_seconds: float = 8.0) -> None:
    status_url = app_url.rstrip("/") + "/api/status"

    def _wait_then_open() -> None:
        startup_log(f"browser: waiting for {status_url}")
        deadline = time.time() + wait_seconds
        while time.time() < deadline:
            if probe_status(status_url, timeout=1.0):
                try:
                    webbrowser.open(app_url, new=1)
                    startup_log(f"browser: opened {app_url}")
                except Exception:
                    startup_log(f"browser: failed to open {app_url}\n{traceback.format_exc()}")
                    pass
                return
            time.sleep(0.2)
        startup_log(f"browser: timeout waiting for {status_url}")

    thread = threading.Thread(target=_wait_then_open, daemon=True)
    thread.start()


def open_existing_instance(app_url: str, *, wait_seconds: float = 8.0) -> bool:
    status_url = app_url.rstrip("/") + "/api/status"
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if probe_status(status_url, timeout=1.0):
            try:
                webbrowser.open(app_url, new=1)
            except Exception:
                pass
            return True
        time.sleep(0.2)
    return False


def create_tray_icon_image() -> Any:
    if Image is None or ImageDraw is None:
        return None
    image = Image.new("RGBA", (64, 64), (246, 242, 235, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((4, 4, 60, 60), radius=14, fill=(252, 249, 244, 255), outline=(33, 31, 28, 255), width=2)
    draw.rounded_rectangle((15, 14, 27, 49), radius=4, fill=(33, 31, 28, 255))
    draw.rounded_rectangle((37, 14, 49, 34), radius=4, fill=(193, 86, 47, 255))
    draw.rounded_rectangle((37, 39, 49, 49), radius=4, fill=(120, 138, 102, 255))
    return image


def stop_server(server: ThreadingHTTPServer) -> None:
    try:
        server.shutdown()
    except Exception:
        pass
    try:
        server.server_close()
    except Exception:
        pass


def run_with_tray(
    *,
    server: ThreadingHTTPServer,
    app_url: str,
    user_root: Path,
    open_browser: bool,
) -> None:
    if pystray is None:
        raise RuntimeError("pystray no está instalado")
    tray_image = create_tray_icon_image()
    if tray_image is None:
        raise RuntimeError("Pillow no está instalado")

    def on_open(_: Any, __: Any) -> None:
        open_browser_soon(app_url)

    def on_open_data(_: Any, __: Any) -> None:
        open_path_in_shell(user_root)

    def on_quit(icon: Any, _: Any) -> None:
        def _shutdown() -> None:
            stop_server(server)
            try:
                icon.stop()
            except Exception:
                pass

        threading.Thread(target=_shutdown, daemon=True).start()

    menu = pystray.Menu(
        pystray.MenuItem("Abrir Trello Review", on_open, default=True),
        pystray.MenuItem("Abrir carpeta de datos", on_open_data),
        pystray.MenuItem("Salir", on_quit),
    )
    icon = pystray.Icon("trello_review", tray_image, "Trello Review", menu)
    startup_log("tray: starting pystray mode")
    server_thread = threading.Thread(target=_serve_server, kwargs={"server": server, "label": "tray"}, daemon=True)
    server_thread.start()

    def setup(tray_icon: Any) -> None:
        tray_icon.visible = True
        if open_browser:
            open_browser_when_ready(app_url)

    try:
        startup_log("tray: entering icon loop")
        icon.run(setup=setup)
    finally:
        startup_log("tray: leaving icon loop")
        stop_server(server)
        server_thread.join(timeout=2.0)


def run_with_windows_tray(
    *,
    server: ThreadingHTTPServer,
    app_url: str,
    user_root: Path,
    open_browser: bool,
) -> None:
    if os.name != "nt":
        raise RuntimeError("La bandeja nativa de Windows solo está disponible en Windows")
    startup_log("windows_tray: initializing")

    user32 = ctypes.windll.user32
    shell32 = ctypes.windll.shell32
    kernel32 = ctypes.windll.kernel32

    WM_APP = 0x8000
    WM_TRAYICON = WM_APP + 1
    WM_DESTROY = 0x0002
    WM_COMMAND = 0x0111
    WM_CLOSE = 0x0010
    WM_LBUTTONDBLCLK = 0x0203
    WM_RBUTTONUP = 0x0205
    NIM_ADD = 0x00000000
    NIM_DELETE = 0x00000002
    NIF_MESSAGE = 0x00000001
    NIF_ICON = 0x00000002
    NIF_TIP = 0x00000004
    CS_VREDRAW = 0x0001
    CS_HREDRAW = 0x0002
    IDI_APPLICATION = 32512
    IDC_ARROW = 32512
    TPM_LEFTALIGN = 0x0000
    TPM_BOTTOMALIGN = 0x0020
    TPM_RIGHTBUTTON = 0x0002
    MF_STRING = 0x0000
    MF_SEPARATOR = 0x0800
    CMD_OPEN = 1001
    CMD_OPEN_DATA = 1002
    CMD_EXIT = 1003
    WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_long, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

    class POINT(ctypes.Structure):
        _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

    class MSG(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("message", wintypes.UINT),
            ("wParam", wintypes.WPARAM),
            ("lParam", wintypes.LPARAM),
            ("time", wintypes.DWORD),
            ("pt", POINT),
            ("lPrivate", wintypes.DWORD),
        ]

    class WNDCLASSW(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", WNDPROC),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON),
            ("hCursor", wintypes.HCURSOR),
            ("hbrBackground", wintypes.HANDLE),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("hWnd", wintypes.HWND),
            ("uID", wintypes.UINT),
            ("uFlags", wintypes.UINT),
            ("uCallbackMessage", wintypes.UINT),
            ("hIcon", wintypes.HICON),
            ("szTip", wintypes.WCHAR * 128),
            ("dwState", wintypes.DWORD),
            ("dwStateMask", wintypes.DWORD),
            ("szInfo", wintypes.WCHAR * 256),
            ("uTimeoutOrVersion", wintypes.UINT),
            ("szInfoTitle", wintypes.WCHAR * 64),
            ("dwInfoFlags", wintypes.DWORD),
            ("guidItem", ctypes.c_byte * 16),
            ("hBalloonIcon", wintypes.HICON),
        ]

    def loword(value: int) -> int:
        return value & 0xFFFF

    h_instance = kernel32.GetModuleHandleW(None)
    class_name = f"TrelloReviewTrayWindow_{os.getpid()}"
    h_icon = shell32.ExtractIconW(h_instance, str(Path(sys.executable).resolve()), 0)
    if not h_icon:
        h_icon = user32.LoadIconW(None, ctypes.c_void_p(IDI_APPLICATION))
    h_cursor = user32.LoadCursorW(None, ctypes.c_void_p(IDC_ARROW))
    quit_requested = {"value": False}

    def show_menu(hwnd: int) -> None:
        menu = user32.CreatePopupMenu()
        if not menu:
            return
        try:
            user32.AppendMenuW(menu, MF_STRING, CMD_OPEN, "Abrir Trello Review")
            user32.AppendMenuW(menu, MF_STRING, CMD_OPEN_DATA, "Abrir carpeta de datos")
            user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
            user32.AppendMenuW(menu, MF_STRING, CMD_EXIT, "Salir")
            pt = POINT()
            user32.GetCursorPos(ctypes.byref(pt))
            user32.SetForegroundWindow(hwnd)
            user32.TrackPopupMenu(menu, TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, None)
        finally:
            user32.DestroyMenu(menu)

    @ctypes.WINFUNCTYPE(ctypes.c_long, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    def window_proc(hwnd: int, msg: int, w_param: int, l_param: int) -> int:
        if msg == WM_TRAYICON:
            if l_param == WM_LBUTTONDBLCLK:
                open_browser_soon(app_url)
                return 0
            if l_param == WM_RBUTTONUP:
                show_menu(hwnd)
                return 0
        elif msg == WM_COMMAND:
            command_id = loword(int(w_param))
            if command_id == CMD_OPEN:
                open_browser_soon(app_url)
                return 0
            if command_id == CMD_OPEN_DATA:
                open_path_in_shell(user_root)
                return 0
            if command_id == CMD_EXIT:
                quit_requested["value"] = True
                threading.Thread(target=stop_server, args=(server,), daemon=True).start()
                user32.DestroyWindow(hwnd)
                return 0
        elif msg == WM_CLOSE:
            user32.DestroyWindow(hwnd)
            return 0
        elif msg == WM_DESTROY:
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, w_param, l_param)

    wnd_class = WNDCLASSW()
    wnd_class.style = CS_HREDRAW | CS_VREDRAW
    wnd_class.lpfnWndProc = window_proc
    wnd_class.hInstance = h_instance
    wnd_class.hIcon = h_icon
    wnd_class.hCursor = h_cursor
    wnd_class.lpszClassName = class_name

    atom = user32.RegisterClassW(ctypes.byref(wnd_class))
    if not atom:
        startup_log(f"windows_tray: RegisterClassW failed last_error={ctypes.get_last_error()}")
        raise ctypes.WinError(ctypes.get_last_error())
    startup_log("windows_tray: window class registered")

    hwnd = user32.CreateWindowExW(
        0,
        class_name,
        "Trello Review",
        0,
        0,
        0,
        0,
        0,
        None,
        None,
        h_instance,
        None,
    )
    if not hwnd:
        startup_log(f"windows_tray: CreateWindowExW failed last_error={ctypes.get_last_error()}")
        raise ctypes.WinError(ctypes.get_last_error())
    startup_log("windows_tray: hidden window created")

    nid = NOTIFYICONDATAW()
    nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
    nid.hWnd = hwnd
    nid.uID = 1
    nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
    nid.uCallbackMessage = WM_TRAYICON
    nid.hIcon = h_icon
    nid.szTip = "Trello Review"

    if not shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid)):
        startup_log(f"windows_tray: Shell_NotifyIconW failed last_error={ctypes.get_last_error()}")
        raise ctypes.WinError(ctypes.get_last_error())
    startup_log("windows_tray: tray icon registered")

    server_thread = threading.Thread(target=_serve_server, kwargs={"server": server, "label": "windows_tray"}, daemon=True)
    server_thread.start()
    startup_log("windows_tray: server thread started")

    try:
        if open_browser:
            open_browser_when_ready(app_url)

        startup_log("windows_tray: entering message loop")
        msg = MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
    finally:
        startup_log("windows_tray: leaving message loop")
        shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(nid))
        if not quit_requested["value"]:
            stop_server(server)
        server_thread.join(timeout=2.0)
        user32.UnregisterClassW(class_name, h_instance)


def parse_reasoning_effort(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if not value:
        return "high"
    if value not in VALID_REASONING_EFFORTS:
        raise ValueError(
            f"reasoning_effort no válido: '{value}'. Se esperaba uno de: {', '.join(sorted(VALID_REASONING_EFFORTS))}"
        )
    return value


def parse_openai_model(raw: Any) -> str:
    value = str(raw or "").strip() or DEFAULT_OPENAI_MODEL
    if value not in VALID_OPENAI_MODELS:
        raise ValueError(
            f"model no válido: '{value}'. Se esperaba uno de: {', '.join(sorted(VALID_OPENAI_MODELS))}"
        )
    return value


def parse_openai_service_tier(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if not value:
        return DEFAULT_OPENAI_SERVICE_TIER
    if value not in VALID_OPENAI_SERVICE_TIERS:
        raise ValueError(
            f"service_tier no válido: '{value}'. Se esperaba uno de: {', '.join(sorted(VALID_OPENAI_SERVICE_TIERS))}"
        )
    return value


def parse_multimodal_limit_bytes(raw: Any) -> int | None:
    if raw in (None, "", 0):
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError) as e:
        raise ValueError("multimodal_limit_bytes debe ser un entero positivo") from e
    if value <= 0:
        return None
    return value


def get_me_and_boards(client: TrelloClient) -> Dict[str, Any]:
    me = client.get("/members/me", fields="id,fullName,username")
    boards = client.get(
        "/members/me/boards",
        fields="id,name,desc,url,closed,dateLastActivity",
        filter="open",
    )
    boards_sorted = sorted(boards, key=lambda b: (b.get("name") or "").lower())
    return {"me": me, "boards": boards_sorted}


def get_board_cards(client: TrelloClient, board_id: str, limit: int = 200, query: str = "") -> Dict[str, Any]:
    board = client.get("/boards/" + board_id, fields="id,name,desc,url,dateLastActivity")
    cards = client.get(
        "/boards/" + board_id + "/cards",
        fields="id,name,desc,idList,idMembers,labels,dateLastActivity,url,closed,due,start",
        filter="open",
    )
    total_open_cards = len(cards)
    q = (query or "").strip().lower()
    if q:
        cards = [
            c
            for c in cards
            if q in (str(c.get("name") or "").lower()) or q in (str(c.get("desc") or "").lower())
        ]
    matched_cards = len(cards)
    cards_sorted = sorted(cards, key=lambda c: (c.get("dateLastActivity") or ""), reverse=True)
    if limit > 0:
        cards_sorted = cards_sorted[:limit]
    return {
        "board": board,
        "cards": cards_sorted,
        "query": query or "",
        "total_open_cards": total_open_cards,
        "matched_cards": matched_cards,
        "returned_cards": len(cards_sorted),
    }


def is_image_attachment(attachment: Dict[str, Any]) -> bool:
    mime = (attachment.get("mimeType") or "").lower()
    name = (attachment.get("name") or attachment.get("fileName") or "").lower()
    if mime.startswith("image/"):
        return True
    return name.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic"))


def attachment_proxy_path(card_id: str, attachment_id: str) -> str:
    return f"/api/cards/{card_id}/attachments/{attachment_id}/content"


def append_trello_auth(url: str, api_key: str, token: str) -> str:
    parsed = urlparse(url)
    if "trello.com" not in (parsed.netloc or ""):
        return url
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.setdefault("key", api_key)
    query.setdefault("token", token)
    return urlunparse(parsed._replace(query=urlencode(query)))


def normalize_attachments(card_id: str, attachments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for a in attachments:
        item = dict(a)
        item["isImage"] = is_image_attachment(item)
        item["proxyUrl"] = attachment_proxy_path(card_id, item.get("id", ""))
        out.append(item)
    return out


def build_timeline(
    card_id: str,
    actions: List[Dict[str, Any]],
    attachments_by_id: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    for action in actions:
        event_type = action.get("type")
        author = (
            (action.get("memberCreator") or {}).get("fullName")
            or (action.get("memberCreator") or {}).get("username")
            or "Desconocido"
        )
        ts = action.get("date") or ""
        if event_type == "commentCard":
            events.append(
                {
                    "kind": "comment",
                    "date": ts,
                    "author": author,
                    "text": ((action.get("data") or {}).get("text") or "").strip(),
                    "actionId": action.get("id"),
                }
            )
            continue

        if event_type == "addAttachmentToCard":
            data = action.get("data") or {}
            att_stub = data.get("attachment") or {}
            attachment_id = att_stub.get("id")
            att_full = attachments_by_id.get(attachment_id, {})
            attachment = dict(att_full) if att_full else dict(att_stub)
            if attachment_id:
                attachment.setdefault("id", attachment_id)
                # Only emit a proxy URL for attachments that still exist on the card.
                # Old attachment actions can remain in history after the file is removed,
                # which causes broken inline image previews in the rendered transcript.
                if att_full:
                    attachment.setdefault("proxyUrl", attachment_proxy_path(card_id, attachment_id))
            attachment["isCurrentAttachment"] = bool(att_full)
            attachment["isImage"] = is_image_attachment(attachment)
            events.append(
                {
                    "kind": "attachment",
                    "date": ts,
                    "author": author,
                    "text": (data.get("text") or "").strip(),
                    "attachment": attachment,
                    "actionId": action.get("id"),
                }
            )
    return sorted(events, key=lambda e: e.get("date") or "")


def get_card_packet(client: TrelloClient, card_id: str) -> Dict[str, Any]:
    card = client.get(
        "/cards/" + card_id,
        fields="id,name,desc,idList,idBoard,idMembers,labels,dateLastActivity,url,closed,due,start",
    )
    actions = client.get(
        "/cards/" + card_id + "/actions",
        filter="commentCard,addAttachmentToCard",
        limit=1000,
        fields="data,date,type,idMemberCreator",
        memberCreator="true",
        memberCreator_fields="id,fullName,username",
    )
    attachments = client.get(
        "/cards/" + card_id + "/attachments",
        fields="id,name,fileName,url,bytes,date,mimeType,isUpload,idMember",
    )
    checklists = client.get("/cards/" + card_id + "/checklists")
    members = client.get("/cards/" + card_id + "/members", fields="id,fullName,username")
    attachments_norm = normalize_attachments(card_id, sorted(attachments, key=lambda a: a.get("date") or ""))
    attachments_by_id = {a.get("id"): a for a in attachments_norm if a.get("id")}
    actions_sorted = sorted(actions, key=lambda a: a.get("date") or "")
    timeline = build_timeline(card_id=card_id, actions=actions_sorted, attachments_by_id=attachments_by_id)
    comments_only = [e for e in timeline if e.get("kind") == "comment"]
    llm_assets = [
        {
            "attachmentId": a.get("id"),
            "name": a.get("name"),
            "mimeType": a.get("mimeType"),
            "isImage": a.get("isImage", False),
            "proxyUrl": a.get("proxyUrl"),
            "sourceUrl": a.get("url"),
            "date": a.get("date"),
        }
        for a in attachments_norm
    ]
    return {
        "card": card,
        "members": members,
        "comments": comments_only,
        "actions": actions_sorted,
        "timeline": timeline,
        "attachments": attachments_norm,
        "llm_assets": llm_assets,
        "checklists": checklists,
    }


def render_markdown_transcript(packet: Dict[str, Any]) -> str:
    card = packet.get("card", {})
    members = packet.get("members", [])
    timeline = packet.get("timeline", [])
    attachments = packet.get("attachments", [])
    checklists = packet.get("checklists", [])

    member_names = ", ".join(
        f"{m.get('fullName') or m.get('username')}" for m in members if (m.get("fullName") or m.get("username"))
    )
    labels = ", ".join(l.get("name") or l.get("color") or "etiqueta" for l in card.get("labels", []))

    lines: List[str] = []
    lines.append(f"# Paquete de revisión de tarjeta de Trello: {card.get('name', '(sin nombre)')}")
    lines.append("")
    lines.append("## Metadatos de la tarjeta")
    lines.append(f"- ID de la tarjeta: `{card.get('id', '')}`")
    lines.append(f"- URL: {card.get('url', '')}")
    lines.append(f"- Última actividad: {card.get('dateLastActivity', '')}")
    if card.get("due"):
        lines.append(f"- Vence: {card.get('due')}")
    if labels:
        lines.append(f"- Etiquetas: {labels}")
    if member_names:
        lines.append(f"- Miembros: {member_names}")

    desc = (card.get("desc") or "").strip()
    lines.append("")
    lines.append("## Descripción de la tarjeta")
    lines.append(desc if desc else "_No hay descripción_")

    lines.append("")
    lines.append("## Checklists")
    if not checklists:
        lines.append("_No hay checklists_")
    else:
        for checklist in checklists:
            lines.append(f"### {checklist.get('name', 'Checklist')}")
            for item in checklist.get("checkItems", []):
                mark = "x" if item.get("state") == "complete" else " "
                lines.append(f"- [{mark}] {item.get('name', '')}")
            lines.append("")

    lines.append("## Línea de tiempo de la conversación (cronológica)")
    if not timeline:
        lines.append("_No hay comentarios ni eventos de adjuntos_")
    else:
        for event in timeline:
            ts = event.get("date") or ""
            author = event.get("author") or "Desconocido"
            if event.get("kind") == "comment":
                text = (event.get("text") or "").strip()
                lines.append(f"[{ts}] {author}: {text}")
                continue

            attachment = event.get("attachment") or {}
            name = attachment.get("name") or attachment.get("fileName") or "adjunto"
            mime = attachment.get("mimeType") or "desconocido"
            lines.append(f"[{ts}] {author} adjuntó `{name}` ({mime})")
            if attachment.get("isImage") and attachment.get("proxyUrl"):
                lines.append(f"![{name}]({attachment.get('proxyUrl')})")
            if event.get("text"):
                lines.append(f"Nota: {event.get('text')}")

    lines.append("")
    lines.append("## Adjuntos")
    if not attachments:
        lines.append("_No hay adjuntos_")
    else:
        for a in attachments:
            size = a.get("bytes")
            size_text = f"{size} bytes" if isinstance(size, int) else "tamaño desconocido"
            mime = a.get("mimeType") or "desconocido"
            lines.append(
                f"- `{a.get('name', '')}` ({mime}, {size_text}) | {a.get('date', '')} | origen={a.get('url', '')} | proxy={a.get('proxyUrl', '')}"
            )

    lines.append("")
    lines.append("## Recursos multimodales del LLM")
    image_assets = [a for a in packet.get("llm_assets", []) if a.get("isImage")]
    if not image_assets:
        lines.append("_No hay recursos de imagen_")
    else:
        lines.append("Usa estas URL o archivos de imagen como entradas multimodales separadas (no como markdown solo de texto).")
        for a in image_assets:
            lines.append(f"- `{a.get('name', '')}` | {a.get('mimeType', '')} | {a.get('proxyUrl', '')}")

    lines.append("")
    lines.append("## Notas sugeridas para la entrada del Checklist del LLM")
    lines.append("- Usa la transcripción de la conversación como cronología autoritativa.")
    lines.append("- Valida el estado del Checklist contra los comentarios y los adjuntos.")
    lines.append("- Marca evidencia faltante si un criterio del Checklist implica un documento o una foto y no hay nada adjunto.")

    return "\n".join(lines).strip() + "\n"


class TrelloWorkbenchHandler(SimpleHTTPRequestHandler):
    server_version = "TrelloWorkbench/0.1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        # Windowed PyInstaller builds on Windows may not have a usable stderr.
        # Avoid crashing request handling just to emit access logs.
        try:
            super().log_message(format, *args)
        except Exception:
            return

    @property
    def app_config(self) -> AppConfig:
        return self.server.app_config  # type: ignore[attr-defined]

    @property
    def workbench_paths(self) -> Any:
        return self.server.workbench_paths  # type: ignore[attr-defined]

    @property
    def review_job_manager(self) -> ReviewJobManager:
        return self.server.review_job_manager  # type: ignore[attr-defined]

    def _client(self) -> TrelloClient:
        return make_client(self.app_config)

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status: int, message: str) -> None:
        self._send_json({"error": message}, status=status)

    def _read_json_body(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError as e:
            raise ValueError("Content-Length no válido") from e
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise ValueError("Cuerpo JSON no válido") from e
        if not isinstance(payload, dict):
            raise ValueError("El cuerpo JSON debe ser un objeto")
        return payload

    def _send_binary(self, body: bytes, content_type: str, filename: str | None = None) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            safe_name = filename.replace('"', "")
            self.send_header("Content-Disposition", f'inline; filename="{safe_name}"')
        self.end_headers()
        self.wfile.write(body)

    def _download_attachment_content(self, client: TrelloClient, card_id: str, attachment_id: str) -> tuple[bytes, str, str | None]:
        attachment = client.get(
            f"/cards/{card_id}/attachments/{attachment_id}",
            fields="id,name,fileName,url,mimeType",
        )
        source_url = attachment.get("url")
        if not source_url:
            raise FileNotFoundError("La URL del adjunto no está disponible")
        oauth_header = (
            f'OAuth oauth_consumer_key="{self.app_config.api_key}", '
            f'oauth_token="{self.app_config.token}"'
        )
        fetch_url = append_trello_auth(source_url, self.app_config.api_key, self.app_config.token)
        req = Request(
            fetch_url,
            headers={
                "User-Agent": "trello-workbench/0.1",
                "Authorization": oauth_header,
            },
        )
        try:
            with urlopen(req, timeout=60) as resp:
                body = resp.read()
                content_type = resp.headers.get("Content-Type") or attachment.get("mimeType") or "application/octet-stream"
        except HTTPError as e:
            try:
                detail = e.read().decode("utf-8", errors="replace")
            except Exception:
                detail = str(e)
            raise RuntimeError(f"Falló la descarga del adjunto: {detail}") from e
        except URLError as e:
            raise RuntimeError(f"Error de red al descargar el adjunto: {e}") from e

        filename = attachment.get("fileName") or attachment.get("name")
        return body, content_type, filename

    def _proxy_attachment_content(self, client: TrelloClient, card_id: str, attachment_id: str) -> None:
        try:
            body, content_type, filename = self._download_attachment_content(client, card_id, attachment_id)
        except FileNotFoundError as e:
            self._send_error_json(HTTPStatus.NOT_FOUND, str(e))
            return
        except RuntimeError as e:
            self._send_error_json(HTTPStatus.BAD_GATEWAY, str(e))
            return
        self._send_binary(body=body, content_type=content_type, filename=filename)

    def _send_local_file(self, card_id: str, rel_path: str) -> None:
        file_path = get_local_file_path(self.workbench_paths, card_id, rel_path)
        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(file_path.name)[0] or detect_mime_from_name(file_path.name)
        self._send_binary(body, content_type=content_type, filename=file_path.name)

    def _send_open_review_file(self, rel_path: str) -> None:
        file_path = get_open_review_file_path(self.workbench_paths, rel_path)
        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(file_path.name)[0] or detect_mime_from_name(file_path.name)
        self._send_binary(body, content_type=content_type, filename=file_path.name)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api_get(parsed)
            return

        if parsed.path in ("/", ""):
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self._send_error_json(HTTPStatus.NOT_FOUND, "Ruta no encontrada")
            return
        self._handle_api_post(parsed)

    def _handle_api_get(self, parsed: Any) -> None:
        path = parsed.path
        qs = parse_qs(parsed.query)
        try:
            client = self._client()
            if path == "/api/status":
                self._send_json({"ok": True})
                return

            if path == "/api/boards":
                self._send_json(get_me_and_boards(client))
                return

            if path == "/api/checklist":
                self._send_json(
                    {
                        "text": load_checklist_text(self.workbench_paths),
                        "parsed": load_checklist(self.workbench_paths),
                    }
                )
                return

            if path == "/api/open-review":
                self._send_json(
                    {
                        "text": load_open_review_config_text(self.workbench_paths),
                        "parsed": load_open_review_config(self.workbench_paths),
                    }
                )
                return

            if path == "/api/open-review/documents":
                self._send_json(get_open_review_documents_info(self.workbench_paths))
                return

            if path == "/api/open-review/documents/content":
                rel_path = (qs.get("path", [""])[0] or "").strip()
                if not rel_path:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Falta el parámetro de consulta `path`")
                    return
                self._send_open_review_file(rel_path)
                return

            if path == "/api/open-review/index":
                source_key = (qs.get("sourceKey", [""])[0] or "").strip()
                if not source_key:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Falta sourceKey")
                    return
                self._send_json(get_open_review_index(self.workbench_paths, source_key))
                return

            if path == "/api/completed-cards":
                self._send_json(list_completed_run_cards(self.workbench_paths))
                return

            if path == "/api/review-jobs":
                self._send_json({"jobs": self.review_job_manager.list_jobs()})
                return

            if path.startswith("/api/boards/") and path.endswith("/cards"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de tarjetas de tablero no válida")
                    return
                board_id = parts[2]
                limit = int(qs.get("limit", ["200"])[0])
                query = (qs.get("q", [""])[0] or "").strip()
                self._send_json(get_board_cards(client, board_id=board_id, limit=limit, query=query))
                return

            if path.startswith("/api/cards/") and path.endswith("/packet"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de paquete de tarjeta no válida")
                    return
                card_id = parts[2]
                packet = get_card_packet(client, card_id=card_id)
                markdown = render_markdown_transcript(packet)
                self._send_json({"packet": packet, "markdown": markdown})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de espacio de trabajo no válida")
                    return
                card_id = parts[2]
                self._send_json(get_card_workspace_info(self.workbench_paths, card_id))
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/indexes"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de índices del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                self._send_json(list_index_summaries(self.workbench_paths, card_id))
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/index"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de índice del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                source_key = (qs.get("sourceKey", [""])[0] or "").strip()
                if not source_key:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Falta sourceKey")
                    return
                self._send_json(get_index_for_card(self.workbench_paths, card_id, source_key))
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/files/content"):
                parts = path.strip("/").split("/")
                if len(parts) != 6:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de contenido de archivo local no válida")
                    return
                card_id = parts[2]
                rel_path = (qs.get("path", [""])[0] or "").strip()
                if not rel_path:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Falta el parámetro de consulta `path`")
                    return
                self._send_local_file(card_id, rel_path)
                return

            if "/workspace/runs/" in path:
                parts = path.strip("/").split("/")
                if len(parts) != 6 or parts[3] != "workspace" or parts[4] != "runs":
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de ejecución del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                run_id = parts[5]
                self._send_json(get_run_result(self.workbench_paths, card_id, run_id))
                return

            if path.startswith("/api/cards/") and "/attachments/" in path and path.endswith("/content"):
                parts = path.strip("/").split("/")
                if len(parts) != 6 or parts[3] != "attachments":
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de contenido de adjunto no válida")
                    return
                card_id = parts[2]
                attachment_id = parts[4]
                self._proxy_attachment_content(client, card_id=card_id, attachment_id=attachment_id)
                return

            self._send_error_json(HTTPStatus.NOT_FOUND, "Ruta no encontrada")
        except ValueError as e:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        except FileNotFoundError as e:
            self._send_error_json(HTTPStatus.NOT_FOUND, str(e))
        except Exception as e:  # pragma: no cover - debug-friendly for local tool
            traceback.print_exc()
            self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))

    def _handle_api_post(self, parsed: Any) -> None:
        path = parsed.path
        try:
            payload = self._read_json_body()
            client = self._client()

            if path == "/api/checklist":
                if isinstance(payload.get("checklist"), dict):
                    parsed_checklist = save_checklist(self.workbench_paths, payload["checklist"])
                else:
                    text = str(payload.get("text") or "")
                    parsed_checklist = save_checklist_text(self.workbench_paths, text)
                self._send_json({"ok": True, "parsed": parsed_checklist, "text": load_checklist_text(self.workbench_paths)})
                return

            if path == "/api/checklist/reset":
                parsed_checklist = reset_checklist(self.workbench_paths)
                self._send_json({"ok": True, "parsed": parsed_checklist, "text": load_checklist_text(self.workbench_paths)})
                return

            if path == "/api/open-review":
                if isinstance(payload.get("config"), dict):
                    parsed_config = save_open_review_config(self.workbench_paths, payload["config"])
                else:
                    text = str(payload.get("text") or "")
                    parsed_config = save_open_review_config_text(self.workbench_paths, text)
                self._send_json({"ok": True, "parsed": parsed_config, "text": load_open_review_config_text(self.workbench_paths)})
                return

            if path == "/api/open-review/reset":
                parsed_config = reset_open_review_config(self.workbench_paths)
                self._send_json({"ok": True, "parsed": parsed_config, "text": load_open_review_config_text(self.workbench_paths)})
                return

            if path == "/api/open-review/documents/import":
                files = payload.get("files")
                if not isinstance(files, list) or not files:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "El cuerpo debe contener un arreglo `files` no vacío")
                    return
                result = import_open_review_documents(self.workbench_paths, files=files)
                self._send_json({"ok": True, **result})
                return

            if path == "/api/open-review/documents/delete":
                relative_path = str(payload.get("relativePath") or "").strip()
                if not relative_path:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Falta `relativePath`")
                    return
                result = delete_open_review_document(self.workbench_paths, relative_path=relative_path)
                self._send_json({"ok": True, **result})
                return

            if path == "/api/open-review/indexes":
                indexes = payload.get("indexes")
                if not isinstance(indexes, list):
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "El cuerpo debe contener un arreglo `indexes`")
                    return
                result = save_open_review_indexes(self.workbench_paths, indexes=indexes)
                self._send_json({"ok": True, **result})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/token-estimate"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de estimación de tokens del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                card_packet = payload.get("cardPacket")
                multimodal_limit_bytes = parse_multimodal_limit_bytes(payload.get("multimodal_limit_bytes"))
                model = parse_openai_model(payload.get("model"))
                if not isinstance(card_packet, dict):
                    card_packet = get_card_packet(client, card_id=card_id)
                card_obj = card_packet.get("card") if isinstance(card_packet, dict) else {}
                if not isinstance(card_obj, dict):
                    card_obj = {}
                estimate = estimate_llm_input_tokens_for_card(
                    self.workbench_paths,
                    card_id=card_id,
                    card_name=card_obj.get("name") or card_id,
                    card_url=card_obj.get("url") or "",
                    card_packet=card_packet if isinstance(card_packet, dict) else {},
                    model=model,
                    multimodal_limit_bytes=multimodal_limit_bytes,
                )
                self._send_json({"ok": True, "estimate": estimate})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/status"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de estado del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                card_packet = payload.get("cardPacket")
                multimodal_limit_bytes = parse_multimodal_limit_bytes(payload.get("multimodal_limit_bytes"))
                if not isinstance(card_packet, dict):
                    card_packet = get_card_packet(client, card_id=card_id)
                self._send_json(
                    get_card_workspace_status(
                        self.workbench_paths,
                        card_id=card_id,
                        card_packet=card_packet,
                        multimodal_limit_bytes=multimodal_limit_bytes,
                    )
                )
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/create"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de creación del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                card = client.get("/cards/" + card_id, fields="id,name,url")
                info = ensure_card_workspace(
                    self.workbench_paths,
                    card_id=card_id,
                    card_name=card.get("name") or card_id,
                    card_url=card.get("url") or "",
                )
                self._send_json(info)
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/indexes"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta para guardar índices del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                indexes = payload.get("indexes")
                if not isinstance(indexes, list):
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "El cuerpo debe contener un arreglo `indexes`")
                    return
                enriched_indexes: List[Dict[str, Any]] = []
                for row in indexes:
                    if not isinstance(row, dict):
                        continue
                    enriched = dict(row)
                    if str(enriched.get("source") or "").strip() == "trello" and not enriched.get("contentBase64"):
                        index_data = enriched.get("index") or {}
                        file_kind = str((index_data.get("file_kind") if isinstance(index_data, dict) else "") or enriched.get("fileKind") or "").lower()
                        trello_attachment = enriched.get("trelloAttachment") or {}
                        attachment_id = str(
                            trello_attachment.get("attachmentId") or trello_attachment.get("id") or ""
                        ).strip()
                        if attachment_id and file_kind in {"image", "pdf"}:
                            try:
                                body, _, _ = self._download_attachment_content(client, card_id=card_id, attachment_id=attachment_id)
                                enriched["contentBase64"] = base64.b64encode(body).decode("ascii")
                            except (FileNotFoundError, RuntimeError):
                                if isinstance(index_data, dict):
                                    warnings = index_data.get("warnings")
                                    if not isinstance(warnings, list):
                                        warnings = []
                                    warning = "No se pudo cachear el adjunto remoto; el índice se guardó sin copia local."
                                    if warning not in warnings:
                                        warnings.append(warning)
                                    index_data["warnings"] = warnings
                                    enriched["index"] = index_data
                    enriched_indexes.append(enriched)
                card = client.get("/cards/" + card_id, fields="id,name,url")
                result = save_indexes_for_card(
                    self.workbench_paths,
                    card_id=card_id,
                    card_name=card.get("name") or card_id,
                    card_url=card.get("url") or "",
                    indexes=enriched_indexes,
                )
                self._send_json({"ok": True, **result})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/files/import"):
                parts = path.strip("/").split("/")
                if len(parts) != 6:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de importación de archivos del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                files = payload.get("files")
                if not isinstance(files, list) or not files:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "El cuerpo debe contener un arreglo `files` no vacío")
                    return
                card = client.get("/cards/" + card_id, fields="id,name,url")
                result = import_local_files_for_card(
                    self.workbench_paths,
                    card_id=card_id,
                    card_name=card.get("name") or card_id,
                    card_url=card.get("url") or "",
                    files=files,
                )
                self._send_json({"ok": True, **result})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/files/delete"):
                parts = path.strip("/").split("/")
                if len(parts) != 6:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de eliminación de archivos del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                relative_path = str(payload.get("relativePath") or "").strip()
                if not relative_path:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Falta `relativePath`")
                    return
                result = delete_local_file_for_card(
                    self.workbench_paths,
                    card_id=card_id,
                    relative_path=relative_path,
                )
                self._send_json({"ok": True, **result})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/indexes/prune"):
                parts = path.strip("/").split("/")
                if len(parts) != 6:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de depuración del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                source_keys = payload.get("sourceKeys")
                if not isinstance(source_keys, list):
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "El cuerpo debe contener un arreglo `sourceKeys`")
                    return
                result = remove_index_sources_for_card(
                    self.workbench_paths,
                    card_id=card_id,
                    source_keys=[str(key) for key in source_keys],
                )
                self._send_json({"ok": True, **result})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/run"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de ejecución del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                card_packet = get_card_packet(client, card_id=card_id)
                card = card_packet.get("card") or {}
                model = parse_openai_model(payload.get("model"))
                reasoning_effort = parse_reasoning_effort(payload.get("reasoning_effort"))
                service_tier = parse_openai_service_tier(payload.get("service_tier"))
                multimodal_limit_bytes = parse_multimodal_limit_bytes(payload.get("multimodal_limit_bytes"))
                result = run_checklist_for_card(
                    self.workbench_paths,
                    card_id=card_id,
                    card_name=card.get("name") or card_id,
                    card_url=card.get("url") or "",
                    card_packet=card_packet,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    service_tier=service_tier,
                    multimodal_limit_bytes=multimodal_limit_bytes,
                )
                self._send_json({"ok": True, **result})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/run-async"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de ejecución asíncrona del espacio de trabajo no válida")
                    return
                card_id = parts[2]
                card_packet = payload.get("cardPacket")
                if not isinstance(card_packet, dict):
                    card_packet = get_card_packet(client, card_id=card_id)
                card = card_packet.get("card") if isinstance(card_packet, dict) else {}
                if not isinstance(card, dict):
                    card = {}
                model = parse_openai_model(payload.get("model"))
                reasoning_effort = parse_reasoning_effort(payload.get("reasoning_effort"))
                service_tier = parse_openai_service_tier(payload.get("service_tier"))
                multimodal_limit_bytes = parse_multimodal_limit_bytes(payload.get("multimodal_limit_bytes"))
                job, existing = self.review_job_manager.start_job(
                    card_id=card_id,
                    card_name=str(card.get("name") or card_id),
                    card_url=str(card.get("url") or ""),
                    card_packet=card_packet,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    service_tier=service_tier,
                    multimodal_limit_bytes=multimodal_limit_bytes,
                )
                self._send_json({"ok": True, "job": job, "existing": existing})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/open-review/run-async"):
                parts = path.strip("/").split("/")
                if len(parts) != 6:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Ruta de revisión abierta asíncrona no válida")
                    return
                card_id = parts[2]
                card_packet = payload.get("cardPacket")
                if not isinstance(card_packet, dict):
                    card_packet = get_card_packet(client, card_id=card_id)
                card = card_packet.get("card") if isinstance(card_packet, dict) else {}
                if not isinstance(card, dict):
                    card = {}
                model = parse_openai_model(payload.get("model"))
                reasoning_effort = parse_reasoning_effort(payload.get("reasoning_effort"))
                service_tier = parse_openai_service_tier(payload.get("service_tier"))
                multimodal_limit_bytes = parse_multimodal_limit_bytes(payload.get("multimodal_limit_bytes"))
                question = str(payload.get("question") or "").strip()
                system_prompt = str(payload.get("system_prompt") or "").strip()
                job, existing = self.review_job_manager.start_job(
                    card_id=card_id,
                    card_name=str(card.get("name") or card_id),
                    card_url=str(card.get("url") or ""),
                    card_packet=card_packet,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    service_tier=service_tier,
                    multimodal_limit_bytes=multimodal_limit_bytes,
                    run_type="open_review",
                    open_review_question=question or None,
                    open_review_system_prompt=system_prompt or None,
                )
                self._send_json({"ok": True, "job": job, "existing": existing})
                return

            self._send_error_json(HTTPStatus.NOT_FOUND, "Ruta no encontrada")
        except ValueError as e:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        except FileNotFoundError as e:
            self._send_error_json(HTTPStatus.NOT_FOUND, str(e))
        except Exception as e:  # pragma: no cover - debug-friendly for local tool
            traceback.print_exc()
            self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Trello workbench UI server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9266)
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open the browser")
    parser.add_argument("--no-tray", action="store_true", help="Do not show the system tray icon")
    args = parser.parse_args()
    startup_log("main: process starting")

    if not UI_DIR.exists():
        startup_log(f"main: UI directory missing at {UI_DIR}")
        raise SystemExit(f"UI directory not found: {UI_DIR}")

    app_url = f"http://{args.host}:{args.port}"
    if not acquire_single_instance():
        startup_log("main: existing instance detected")
        if not args.no_browser and open_existing_instance(app_url):
            return 0
        maybe_show_error_dialog("Trello Review", "Trello Review ya se está ejecutando.")
        return 0
    try:
        startup_log(f"main: loading config from {', '.join(str(p) for p in APP_PATHS.env_search_paths)}")
        cfg = load_config()
        startup_log("main: config loaded")
        server = ThreadingHTTPServer((args.host, args.port), TrelloWorkbenchHandler)
        startup_log(f"main: HTTP server bound on {app_url}")
        server.app_config = cfg  # type: ignore[attr-defined]
        server.workbench_paths = init_workbench_paths(
            APP_PATHS.review_workspace_dir,
            checklist_file=APP_PATHS.user_checklist_file,
            checklist_template_file=APP_PATHS.default_checklist_file,
            open_review_file=APP_PATHS.user_open_review_file,
        )  # type: ignore[attr-defined]
        server.review_job_manager = ReviewJobManager(server.workbench_paths)  # type: ignore[attr-defined]
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            if not args.no_browser and probe_status(app_url.rstrip("/") + "/api/status"):
                release_single_instance()
                open_browser_soon(app_url)
                return 0
            maybe_show_error_dialog(
                "Trello Review",
                f"El puerto {args.port} ya está en uso por otra aplicación. Ciérrala o ejecuta Trello Review en otro puerto.",
            )
            release_single_instance()
            return 0
        maybe_show_error_dialog("Trello Review", str(e))
        release_single_instance()
        raise
    except Exception as e:
        startup_log(f"main: startup exception before serve\n{traceback.format_exc()}")
        maybe_show_error_dialog("Trello Review", f"{e}\n\nRegistro: {STARTUP_LOG_PATH}")
        release_single_instance()
        raise

    startup_log(f"main: app_url={app_url}")
    startup_log(f"main: user_data={APP_PATHS.user_root}")
    try:
        use_tray = not args.no_tray and getattr(sys, "frozen", False)
        startup_log(f"main: use_tray={use_tray} os={os.name} frozen={getattr(sys, 'frozen', False)}")
        if use_tray and os.name == "nt":
            startup_log("main: entering windows tray mode")
            try:
                run_with_windows_tray(
                    server=server,
                    app_url=app_url,
                    user_root=APP_PATHS.user_root,
                    open_browser=not args.no_browser,
                )
            except Exception:
                startup_log(f"main: windows tray failed, falling back to foreground mode\n{traceback.format_exc()}")
                if not args.no_browser:
                    open_browser_when_ready(app_url)
                _serve_server(server, label="foreground_fallback")
        elif use_tray and pystray is not None:
            startup_log("main: entering pystray mode")
            run_with_tray(
                server=server,
                app_url=app_url,
                user_root=APP_PATHS.user_root,
                open_browser=not args.no_browser,
            )
        else:
            if use_tray and os.name != "nt" and pystray is None:
                maybe_show_error_dialog("Trello Review", "No se pudo cargar el soporte de icono de bandeja para esta compilación.")
            if not args.no_browser:
                open_browser_when_ready(app_url)
            _serve_server(server, label="foreground")
    except KeyboardInterrupt:
        startup_log("main: keyboard interrupt")
    finally:
        startup_log("main: shutting down")
        stop_server(server)
        release_single_instance()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
