from __future__ import annotations

import json
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import List

APP_DIR_NAME = "Trello Review Workbench"
DEFAULT_DATA_DIR_NAME = "Trello App"


@dataclass(frozen=True)
class AppPaths:
    resource_root: Path
    executable_dir: Path
    settings_root: Path
    settings_file: Path
    ui_dir: Path
    default_checklist_file: Path
    user_root: Path
    review_workspace_dir: Path
    user_checklist_file: Path
    env_search_paths: List[Path]


def _resource_root() -> Path:
    frozen_root = getattr(sys, "_MEIPASS", None)
    if frozen_root:
        return Path(frozen_root).resolve()
    return Path(__file__).resolve().parent


def _executable_dir(resource_root: Path) -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return resource_root


def _preferred_user_root() -> Path:
    if os.name == "nt":
        base = os.getenv("LOCALAPPDATA") or os.getenv("APPDATA")
        if base:
            return Path(base) / APP_DIR_NAME
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIR_NAME
    else:
        xdg = os.getenv("XDG_DATA_HOME")
        if xdg:
            return Path(xdg) / APP_DIR_NAME
        return Path.home() / ".local" / "share" / APP_DIR_NAME
    return Path.home() / APP_DIR_NAME


def _writable_dir_candidates(executable_dir: Path) -> List[Path]:
    return [
        _preferred_user_root(),
        executable_dir / ".appdata",
        Path(tempfile.gettempdir()) / APP_DIR_NAME,
    ]


def _pick_first_writable_dir(candidates: List[Path]) -> Path:
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
        except OSError:
            continue
        return candidate
    raise RuntimeError("No se pudo crear una carpeta de datos de la aplicación con permiso de escritura")


def _default_visible_data_dir() -> Path:
    home = Path.home()
    if os.name == "nt":
        return home / "Documents" / DEFAULT_DATA_DIR_NAME
    return home / "Documents" / DEFAULT_DATA_DIR_NAME


def _load_saved_data_dir(settings_file: Path) -> Path | None:
    if not settings_file.exists():
        return None
    try:
        payload = json.loads(settings_file.read_text(encoding="utf-8"))
    except Exception:
        return None
    path = str((payload or {}).get("data_root") or "").strip()
    if not path:
        return None
    return Path(path).expanduser()


def _save_data_dir(settings_file: Path, data_root: Path) -> None:
    settings_file.parent.mkdir(parents=True, exist_ok=True)
    payload = {"data_root": str(data_root)}
    settings_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _choose_data_dir_interactively(initial_dir: Path) -> Path | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception:
        return None

    root = None
    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected = filedialog.askdirectory(
            title="Elige dónde debe guardar Trello Review sus archivos de Checklist y revisión",
            initialdir=str(initial_dir),
            mustexist=False,
        )
    except Exception:
        return None
    finally:
        if root is not None:
            try:
                root.destroy()
            except Exception:
                pass

    selected = str(selected or "").strip()
    if not selected:
        return None
    return Path(selected).expanduser()


def _resolve_data_root(settings_file: Path) -> Path:
    override = os.getenv("TRELLO_REVIEW_APP_HOME", "").strip()
    if override:
        return Path(override).expanduser()

    saved = _load_saved_data_dir(settings_file)
    if saved is not None:
        return saved

    default_dir = _default_visible_data_dir()
    chosen = _choose_data_dir_interactively(default_dir.parent if default_dir.parent != default_dir else default_dir)
    data_root = chosen or default_dir
    _save_data_dir(settings_file, data_root)
    return data_root


def resolve_app_paths() -> AppPaths:
    resource_root = _resource_root()
    executable_dir = _executable_dir(resource_root)
    settings_root = _pick_first_writable_dir(_writable_dir_candidates(executable_dir))
    settings_file = settings_root / "settings.json"

    user_root = _resolve_data_root(settings_file)
    user_root.mkdir(parents=True, exist_ok=True)

    candidates = [
        resource_root / ".env",
        executable_dir / ".env",
        user_root / ".env",
        settings_root / ".env",
    ]
    env_search_paths: List[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path.resolve())
        if key in seen:
            continue
        seen.add(key)
        env_search_paths.append(path)

    return AppPaths(
        resource_root=resource_root,
        executable_dir=executable_dir,
        settings_root=settings_root,
        settings_file=settings_file,
        ui_dir=resource_root / "ui",
        default_checklist_file=resource_root / "defaults" / "checklist.template.json",
        user_root=user_root,
        review_workspace_dir=user_root / "review_workspace",
        user_checklist_file=user_root / "checklist.json",
        env_search_paths=env_search_paths,
    )
