from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from llm_review_payloads import (
    build_review_system_prompt,
    build_review_user_payload,
    estimate_review_input_tokens,
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _safe_slug(text: str, max_len: int = 80) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "").strip()).strip("-").lower()
    return (slug[:max_len].rstrip("-") or "card")


def _json_dump(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _json_load(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def normalize_text(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"\s+", " ", s).strip()
    return s


def normalize_text_loose(s: str) -> str:
    s = normalize_text(s)
    return re.sub(r"[^a-z0-9 ]+", "", s)


def similarity_score(a: str, b: str) -> float:
    # stdlib-only fuzzy score for v1
    import difflib

    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, normalize_text_loose(a), normalize_text_loose(b)).ratio()


@dataclass
class WorkbenchPaths:
    root: Path
    cards_dir: Path
    checklist_file: Path
    checklist_template_file: Optional[Path] = None


def init_workbench_paths(
    root: Path,
    *,
    checklist_file: Optional[Path] = None,
    checklist_template_file: Optional[Path] = None,
) -> WorkbenchPaths:
    cards_dir = root / "cards"
    root.mkdir(parents=True, exist_ok=True)
    cards_dir.mkdir(parents=True, exist_ok=True)
    checklist_path = checklist_file or (root / "checklist.json")
    checklist_path.parent.mkdir(parents=True, exist_ok=True)
    paths = WorkbenchPaths(
        root=root,
        cards_dir=cards_dir,
        checklist_file=checklist_path,
        checklist_template_file=checklist_template_file,
    )
    _ensure_checklist_file(paths)
    return paths


def _built_in_default_checklist() -> Dict[str, Any]:
    return {
        "version": 1,
        "name": "Checklist de revisión",
        "instructions": "Edita este Checklist en la interfaz. Mantén estables los IDs de los criterios una vez que existan citas o ejecuciones.",
        "items": [
            {
                "id": "item_001",
                "title": "El documento requerido está presente",
                "description": "Confirma que el documento de respaldo requerido exista y parezca completo.",
                "pass_criteria": "El documento existe y contiene el contenido o las secciones esperadas.",
                "fail_criteria": "El documento no existe, está incompleto o es claramente inconsistente.",
            }
        ],
    }


def default_checklist(template_file: Optional[Path] = None) -> Dict[str, Any]:
    fallback = _built_in_default_checklist()
    if not template_file or not template_file.exists():
        return fallback
    raw = _json_load(template_file, fallback)
    if not isinstance(raw, dict):
        return fallback
    try:
        return validate_and_normalize_checklist(raw)
    except Exception:
        return fallback


def _ensure_checklist_file(paths: WorkbenchPaths) -> None:
    if not paths.checklist_file.exists():
        _json_dump(paths.checklist_file, default_checklist(paths.checklist_template_file))


def load_checklist(paths: WorkbenchPaths) -> Dict[str, Any]:
    _ensure_checklist_file(paths)
    raw = _json_load(paths.checklist_file, default_checklist(paths.checklist_template_file))
    return validate_and_normalize_checklist(raw)


def load_checklist_text(paths: WorkbenchPaths) -> str:
    _ensure_checklist_file(paths)
    return paths.checklist_file.read_text(encoding="utf-8")


def save_checklist(paths: WorkbenchPaths, payload: Dict[str, Any]) -> Dict[str, Any]:
    normalized = validate_and_normalize_checklist(payload)
    paths.checklist_file.write_text(json.dumps(normalized, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return normalized


def save_checklist_text(paths: WorkbenchPaths, text: str) -> Dict[str, Any]:
    parsed = json.loads(text)
    return save_checklist(paths, parsed)


def reset_checklist(paths: WorkbenchPaths) -> Dict[str, Any]:
    return save_checklist(paths, default_checklist(paths.checklist_template_file))


def _auto_item_id(idx: int, title: str, seen: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", (title or "").lower()).strip("_")
    if not base:
        base = f"item_{idx:03d}"
    else:
        base = f"item_{base[:48].strip('_') or idx}"
    candidate = base
    n = 2
    while candidate in seen:
        candidate = f"{base}_{n}"
        n += 1
    return candidate


def validate_and_normalize_checklist(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("El Checklist debe ser un objeto JSON")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("El Checklist debe contener un arreglo `items` no vacío")
    seen: set[str] = set()
    out_items: List[Dict[str, Any]] = []
    for idx, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"El criterio #{idx} del Checklist debe ser un objeto")
        title = str(item.get("title") or "").strip()
        if not title:
            raise ValueError(f"Al criterio #{idx} del Checklist le falta el título")
        item_id = str(item.get("id") or "").strip()
        if not item_id:
            item_id = _auto_item_id(idx, title, seen)
        if item_id in seen:
            raise ValueError(f"ID duplicado de criterio del Checklist: {item_id}")
        seen.add(item_id)
        out_items.append(
            {
                "id": item_id,
                "title": title,
                "description": str(item.get("description") or "").strip(),
                "pass_criteria": str(item.get("pass_criteria") or "").strip(),
                "fail_criteria": str(item.get("fail_criteria") or "").strip(),
                "required_evidence_types": item.get("required_evidence_types") or [],
            }
        )
    return {
        "version": int(payload.get("version") or 1),
        "name": str(payload.get("name") or "Checklist de revisión").strip() or "Checklist de revisión",
        "instructions": str(payload.get("instructions") or "").strip(),
        "items": out_items,
    }


def _find_card_workspace_dir(paths: WorkbenchPaths, card_id: str) -> Optional[Path]:
    suffix = "__" + card_id
    for p in paths.cards_dir.iterdir():
        if p.is_dir() and p.name.endswith(suffix):
            return p
    return None


def _card_workspace_dir(paths: WorkbenchPaths, card_id: str, card_name: str) -> Path:
    return paths.cards_dir / f"{_safe_slug(card_name)}__{card_id}"


def _manifest_path(ws_dir: Path) -> Path:
    return ws_dir / "manifest.json"


def _card_meta_path(ws_dir: Path) -> Path:
    return ws_dir / "card_meta.json"


def _indexes_dir(ws_dir: Path) -> Path:
    return ws_dir / "indexes"


def _runs_dir(ws_dir: Path) -> Path:
    return ws_dir / "runs"


def _attachments_dir(ws_dir: Path) -> Path:
    return ws_dir / "attachments"


def _trello_cache_dir(ws_dir: Path) -> Path:
    return ws_dir / "trello_attachments"


def _default_manifest(card_id: str) -> Dict[str, Any]:
    return {
        "version": 1,
        "card_id": card_id,
        "updated_at": utc_now_iso(),
        "local_files": {},
        "trello_sources": {},
        "indexes": {},
        "runs": [],
    }


def _load_manifest(ws_dir: Path, card_id: str) -> Dict[str, Any]:
    manifest = _json_load(_manifest_path(ws_dir), _default_manifest(card_id))
    if not isinstance(manifest, dict):
        manifest = _default_manifest(card_id)
    manifest.setdefault("version", 1)
    manifest.setdefault("card_id", card_id)
    manifest.setdefault("local_files", {})
    manifest.setdefault("trello_sources", {})
    manifest.setdefault("indexes", {})
    manifest.setdefault("runs", [])
    return manifest


def _save_manifest(ws_dir: Path, manifest: Dict[str, Any]) -> None:
    manifest["updated_at"] = utc_now_iso()
    _json_dump(_manifest_path(ws_dir), manifest)


def _sha1_text(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()  # noqa: S324 - non-security id only


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ensure_card_workspace(
    paths: WorkbenchPaths,
    *,
    card_id: str,
    card_name: str,
    card_url: str = "",
) -> Dict[str, Any]:
    existing = _find_card_workspace_dir(paths, card_id)
    ws_dir = existing or _card_workspace_dir(paths, card_id, card_name)
    ws_dir.mkdir(parents=True, exist_ok=True)
    _attachments_dir(ws_dir).mkdir(parents=True, exist_ok=True)
    _trello_cache_dir(ws_dir).mkdir(parents=True, exist_ok=True)
    _indexes_dir(ws_dir).mkdir(parents=True, exist_ok=True)
    _runs_dir(ws_dir).mkdir(parents=True, exist_ok=True)
    meta = {
        "id": card_id,
        "name": card_name,
        "url": card_url,
        "workspace_folder": ws_dir.name,
        "updated_at": utc_now_iso(),
    }
    _json_dump(_card_meta_path(ws_dir), meta)
    manifest = _load_manifest(ws_dir, card_id)
    _save_manifest(ws_dir, manifest)
    return get_card_workspace_info(paths, card_id)


def _iter_local_files(root: Path) -> Iterable[Path]:
    for p in sorted(root.rglob("*")):
        if p.is_file():
            if any(part.startswith(".") for part in p.relative_to(root).parts):
                continue
            yield p


def _rel_posix(root: Path, p: Path) -> str:
    return p.relative_to(root).as_posix()


def file_stat_fingerprint(path: Path) -> Dict[str, Any]:
    st = path.stat()
    return {
        "size": st.st_size,
        "mtime_ns": getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)),
    }


def list_runs_summary(ws_dir: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    runs_dir = _runs_dir(ws_dir)
    if not runs_dir.exists():
        return out
    for run_dir in sorted([p for p in runs_dir.iterdir() if p.is_dir()], key=lambda p: p.name, reverse=True):
        result_path = run_dir / "run_result.json"
        if not result_path.exists():
            continue
        data = _json_load(result_path, {})
        summary = data.get("summary") or {}
        out.append(
            {
                "run_id": run_dir.name,
                "created_at": data.get("created_at"),
                "model": data.get("model"),
                "counts": summary.get("counts"),
                "status": summary.get("status"),
            }
        )
    return out[:20]


def get_card_workspace_info(paths: WorkbenchPaths, card_id: str) -> Dict[str, Any]:
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        return {"exists": False, "card_id": card_id}
    manifest = _load_manifest(ws_dir, card_id)
    attachments_dir = _attachments_dir(ws_dir)
    local_files: List[Dict[str, Any]] = []
    manifest_local = manifest.get("local_files", {})
    for p in _iter_local_files(attachments_dir):
        rel = _rel_posix(attachments_dir, p)
        fp = file_stat_fingerprint(p)
        entry = manifest_local.get(rel, {}) if isinstance(manifest_local, dict) else {}
        stored_size = entry.get("size")
        stored_mtime_ns = entry.get("mtime_ns")
        indexed = bool(entry.get("index_file"))
        changed = indexed and (
            (stored_size is not None and stored_size != fp["size"])
            or (stored_mtime_ns is not None and stored_mtime_ns != fp["mtime_ns"])
        )
        status = entry.get("index_status") or ("indexed" if indexed else "not_indexed")
        if changed:
            status = "changed"
        local_files.append(
            {
                "relativePath": rel,
                "size": fp["size"],
                "mtimeNs": fp["mtime_ns"],
                "indexedHash": entry.get("content_hash"),
                "lastIndexedAt": entry.get("last_indexed_at"),
                "indexSourceKey": entry.get("source_key"),
                "indexStatus": status,
                "indexFileKind": entry.get("file_kind"),
                "indexWarnings": entry.get("warnings") or [],
            }
        )
    meta = _json_load(_card_meta_path(ws_dir), {})
    return {
        "exists": True,
        "card_id": card_id,
        "workspaceFolder": ws_dir.name,
        "workspacePath": str(ws_dir),
        "attachmentsPath": str(attachments_dir),
        "cardMeta": meta,
        "manifest": manifest,
        "localFiles": local_files,
        "runs": list_runs_summary(ws_dir),
    }


def _index_file_exists(ws_dir: Path, idx_rel: Any) -> bool:
    if not idx_rel:
        return False
    idx_path = (ws_dir / str(idx_rel)).resolve()
    if ws_dir.resolve() not in [idx_path, *idx_path.parents]:
        return False
    return idx_path.is_file()


def _scan_local_workspace_sources(ws_dir: Path, manifest: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    attachments_dir = _attachments_dir(ws_dir)
    manifest_local = manifest.get("local_files", {})
    local_items: List[Dict[str, Any]] = []
    seen_rels: set[str] = set()
    for p in _iter_local_files(attachments_dir):
        rel = _rel_posix(attachments_dir, p)
        seen_rels.add(rel)
        fp = file_stat_fingerprint(p)
        entry = manifest_local.get(rel, {}) if isinstance(manifest_local, dict) else {}
        has_index = _index_file_exists(ws_dir, entry.get("index_file"))
        changed = has_index and (
            entry.get("size") != fp["size"] or entry.get("mtime_ns") != fp["mtime_ns"]
        )
        status = "indexed" if has_index else "not_indexed"
        if changed:
            status = "changed"
        local_items.append(
            {
                "relativePath": rel,
                "size": fp["size"],
                "mtimeNs": fp["mtime_ns"],
                "lastIndexedAt": entry.get("last_indexed_at"),
                "sourceKey": entry.get("source_key") or f"local:{rel}",
                "indexStatus": status,
                "indexFileKind": entry.get("file_kind"),
                "indexWarnings": entry.get("warnings") or [],
            }
        )

    stale_local: List[Dict[str, Any]] = []
    if isinstance(manifest_local, dict):
        for rel, entry in manifest_local.items():
            if rel in seen_rels or not isinstance(entry, dict):
                continue
            stale_local.append(
                {
                    "relativePath": rel,
                    "sourceKey": entry.get("source_key") or f"local:{rel}",
                    "indexStatus": "missing",
                    "lastIndexedAt": entry.get("last_indexed_at"),
                    "indexFileKind": entry.get("file_kind"),
                    "indexWarnings": entry.get("warnings") or [],
                }
            )

    return local_items, stale_local


def _scan_remote_workspace_sources(
    ws_dir: Path,
    manifest: Dict[str, Any],
    card_packet: Dict[str, Any],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    attachments = [a for a in (card_packet.get("attachments") or []) if isinstance(a, dict)]
    manifest_remote = manifest.get("trello_sources", {})
    remote_items: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()
    for att in attachments:
        attachment_id = str(att.get("id") or "").strip()
        if not attachment_id:
            continue
        seen_ids.add(attachment_id)
        entry = manifest_remote.get(attachment_id, {}) if isinstance(manifest_remote, dict) else {}
        has_index = _index_file_exists(ws_dir, entry.get("index_file"))
        remote_items.append(
            {
                "attachmentId": attachment_id,
                "name": att.get("name") or att.get("fileName") or attachment_id,
                "fileName": att.get("fileName") or att.get("name") or attachment_id,
                "mimeType": att.get("mimeType") or "",
                "proxyUrl": att.get("proxyUrl"),
                "sourceUrl": att.get("url"),
                "date": att.get("date"),
                "sourceKey": entry.get("source_key") or f"trello:{attachment_id}",
                "indexStatus": "indexed" if has_index else "not_indexed",
                "lastIndexedAt": entry.get("last_indexed_at"),
                "indexFileKind": ((manifest.get("indexes") or {}).get(entry.get("source_key"), {}) or {}).get("file_kind"),
                "indexWarnings": entry.get("warnings") or [],
            }
        )

    stale_remote: List[Dict[str, Any]] = []
    if isinstance(manifest_remote, dict):
        for attachment_id, entry in manifest_remote.items():
            if attachment_id in seen_ids or not isinstance(entry, dict):
                continue
            stale_remote.append(
                {
                    "attachmentId": attachment_id,
                    "name": entry.get("name") or attachment_id,
                    "mimeType": entry.get("mime_type") or "",
                    "sourceKey": entry.get("source_key") or f"trello:{attachment_id}",
                    "indexStatus": "missing",
                    "lastIndexedAt": entry.get("last_indexed_at"),
                    "indexFileKind": ((manifest.get("indexes") or {}).get(entry.get("source_key"), {}) or {}).get("file_kind"),
                    "indexWarnings": entry.get("warnings") or [],
                }
            )

    return remote_items, stale_remote


def _summarize_preparation_state(
    *,
    workspace_exists: bool,
    local_items: List[Dict[str, Any]],
    stale_local: List[Dict[str, Any]],
    remote_items: List[Dict[str, Any]],
    stale_remote: List[Dict[str, Any]],
) -> Dict[str, Any]:
    pending_local = [row for row in local_items if row.get("indexStatus") in ("not_indexed", "changed")]
    pending_remote = [row for row in remote_items if row.get("indexStatus") == "not_indexed"]
    indexed_local = [row for row in local_items if row.get("indexStatus") == "indexed"]
    indexed_remote = [row for row in remote_items if row.get("indexStatus") == "indexed"]
    evidence_docs = len(indexed_local) + len(indexed_remote)

    actions: List[str] = []
    if not workspace_exists:
        actions.append("Crea la carpeta de revisión.")
    if pending_local:
        changed_count = sum(1 for row in pending_local if row.get("indexStatus") == "changed")
        new_count = len(pending_local) - changed_count
        if new_count:
            actions.append(f"Indexa {new_count} archivo(s) local(es).")
        if changed_count:
            actions.append(f"Vuelve a indexar {changed_count} archivo(s) local(es) modificados.")
    if pending_remote:
        actions.append(f"Indexa {len(pending_remote)} adjunto(s) de Trello.")
    if stale_local:
        actions.append(f"Elimina {len(stale_local)} referencia(s) obsoleta(s) de índices locales.")
    if stale_remote:
        actions.append(f"Elimina {len(stale_remote)} referencia(s) obsoleta(s) de índices de Trello.")
    if workspace_exists and evidence_docs == 0 and not pending_local and not pending_remote:
        actions.append("Agrega archivos locales a /attachments o adjunta archivos en Trello.")

    if not workspace_exists:
        state = "needs_prepare"
        summary = "Prepara la revisión para crear el espacio de trabajo e indexar la evidencia."
    elif actions:
        state = "needs_prepare"
        summary = "Se requiere preparación antes de que la revisión esté al día."
    elif evidence_docs:
        state = "ready"
        summary = "Lista para ejecutar."
    else:
        state = "empty"
        summary = "Todavía no se encontró evidencia."

    ready_for_run = state == "ready" and evidence_docs > 0
    blocking_message = ""
    if not ready_for_run:
        if actions:
            blocking_message = "Se requiere preparación: " + " ".join(actions)
        elif evidence_docs == 0:
            blocking_message = "No se encontró evidencia. Agrega archivos locales o adjuntos de Trello y luego prepara la revisión."
        else:
            blocking_message = "Se requiere preparación antes de ejecutar la revisión."

    return {
        "state": state,
        "summary": summary,
        "actions": actions,
        "readyForRun": ready_for_run,
        "blockingMessage": blocking_message,
        "counts": {
            "localTotal": len(local_items),
            "localIndexed": len(indexed_local),
            "localPending": len(pending_local),
            "localStale": len(stale_local),
            "remoteTotal": len(remote_items),
            "remoteIndexed": len(indexed_remote),
            "remotePending": len(pending_remote),
            "remoteStale": len(stale_remote),
            "evidenceDocs": evidence_docs,
        },
        "validSourceKeys": [str(row.get("sourceKey")) for row in indexed_local + indexed_remote if row.get("sourceKey")],
    }


def get_card_workspace_status(
    paths: WorkbenchPaths,
    *,
    card_id: str,
    card_packet: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    workspace = get_card_workspace_info(paths, card_id)
    packet = card_packet if isinstance(card_packet, dict) else {}
    if not workspace.get("exists"):
        remote_items = []
        for att in [a for a in (packet.get("attachments") or []) if isinstance(a, dict)]:
            attachment_id = str(att.get("id") or "").strip()
            if not attachment_id:
                continue
            remote_items.append(
                {
                    "attachmentId": attachment_id,
                    "name": att.get("name") or att.get("fileName") or attachment_id,
                    "fileName": att.get("fileName") or att.get("name") or attachment_id,
                    "mimeType": att.get("mimeType") or "",
                    "proxyUrl": att.get("proxyUrl"),
                    "sourceUrl": att.get("url"),
                    "date": att.get("date"),
                    "sourceKey": f"trello:{attachment_id}",
                    "indexStatus": "not_indexed",
                    "lastIndexedAt": None,
                    "indexFileKind": None,
                    "indexWarnings": [],
                }
            )
        prep = _summarize_preparation_state(
            workspace_exists=False,
            local_items=[],
            stale_local=[],
            remote_items=remote_items,
            stale_remote=[],
        )
        return {
            "workspace": workspace,
            "prep": {
                **prep,
                "attachmentsPath": None,
                "local": {"items": [], "stale": []},
                "remote": {"items": remote_items, "stale": []},
            },
        }

    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise FileNotFoundError("No se encontró el espacio de trabajo")
    manifest = _load_manifest(ws_dir, card_id)
    local_items, stale_local = _scan_local_workspace_sources(ws_dir, manifest)
    remote_items, stale_remote = _scan_remote_workspace_sources(ws_dir, manifest, packet)
    prep = _summarize_preparation_state(
        workspace_exists=True,
        local_items=local_items,
        stale_local=stale_local,
        remote_items=remote_items,
        stale_remote=stale_remote,
    )
    return {
        "workspace": workspace,
        "prep": {
            **prep,
            "attachmentsPath": workspace.get("attachmentsPath"),
            "local": {"items": local_items, "stale": stale_local},
            "remote": {"items": remote_items, "stale": stale_remote},
        },
    }


def get_local_file_path(paths: WorkbenchPaths, card_id: str, rel_path: str) -> Path:
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise FileNotFoundError("El espacio de trabajo no existe")
    attachments_dir = _attachments_dir(ws_dir).resolve()
    candidate = (attachments_dir / rel_path).resolve()
    if attachments_dir not in [candidate, *candidate.parents]:
        raise ValueError("Ruta relativa no válida")
    if not candidate.is_file():
        raise FileNotFoundError("No se encontró el archivo")
    return candidate


def import_local_files_for_card(
    paths: WorkbenchPaths,
    *,
    card_id: str,
    card_name: str,
    card_url: str,
    files: List[Dict[str, Any]],
) -> Dict[str, Any]:
    ensure_card_workspace(paths, card_id=card_id, card_name=card_name, card_url=card_url)
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise RuntimeError("Falló la creación o carga del espacio de trabajo")
    attachments_dir = _attachments_dir(ws_dir).resolve()
    saved: List[Dict[str, Any]] = []

    for idx, payload in enumerate(files, start=1):
        if not isinstance(payload, dict):
            raise ValueError(f"La carga útil del archivo #{idx} debe ser un objeto")
        raw_name = str(payload.get("name") or "").strip()
        if not raw_name:
            raise ValueError(f"A la carga útil del archivo #{idx} le falta el nombre")
        safe_name = Path(raw_name.replace("\\", "/")).name.strip()
        if not safe_name:
            raise ValueError(f"La carga útil del archivo #{idx} tiene un nombre no válido")
        raw_content = payload.get("contentBase64")
        if not isinstance(raw_content, str) or not raw_content.strip():
            raise ValueError(f"A la carga útil del archivo #{idx} le falta `contentBase64`")
        try:
            body = base64.b64decode(raw_content.encode("ascii"), validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError(f"La carga útil del archivo #{idx} tiene contenido base64 no válido") from exc

        target = (attachments_dir / safe_name).resolve()
        if attachments_dir not in [target, *target.parents]:
            raise ValueError(f"Ruta de destino no válida para la carga útil del archivo #{idx}")
        target.write_bytes(body)
        saved.append({"name": safe_name, "size": len(body)})

    return {"saved": saved, "workspace": get_card_workspace_info(paths, card_id)}


def _index_filename(source_key: str, file_kind: str) -> str:
    ext = ".json"
    return f"{file_kind}__{_sha1_text(source_key)[:16]}{ext}"


def _safe_filename(name: str, fallback: str) -> str:
    base = Path((name or "").replace("\\", "/")).name.strip()
    if not base:
        base = fallback
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")
    return cleaned[:180] or fallback


def _store_trello_attachment_cache(
    *,
    ws_dir: Path,
    attachment_id: str,
    display_name: str,
    content_base64: str,
) -> str:
    try:
        body = base64.b64decode(content_base64.encode("ascii"), validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError(f"El adjunto de Trello {attachment_id} tiene contenido base64 no válido") from exc
    cache_dir = _trello_cache_dir(ws_dir)
    filename = f"{attachment_id}__{_safe_filename(display_name, attachment_id)}"
    target = (cache_dir / filename).resolve()
    if cache_dir.resolve() not in [target, *target.parents]:
        raise ValueError(f"Ruta de caché no válida para el adjunto de Trello {attachment_id}")
    target.write_bytes(body)
    return target.relative_to(ws_dir).as_posix()


def save_indexes_for_card(
    paths: WorkbenchPaths,
    *,
    card_id: str,
    card_name: str,
    card_url: str,
    indexes: List[Dict[str, Any]],
) -> Dict[str, Any]:
    info = ensure_card_workspace(paths, card_id=card_id, card_name=card_name, card_url=card_url)
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise RuntimeError("Falló la creación o carga del espacio de trabajo")
    manifest = _load_manifest(ws_dir, card_id)
    indexes_dir = _indexes_dir(ws_dir)
    saved: List[Dict[str, Any]] = []

    for payload in indexes:
        if not isinstance(payload, dict):
            continue
        source = str(payload.get("source") or "").strip()
        source_key = str(payload.get("sourceKey") or "").strip()
        card_ref = str(payload.get("cardId") or card_id)
        if card_ref != card_id:
            raise ValueError(f"La fuente de índice {source_key} hace referencia a un ID de tarjeta distinto")
        if source not in ("local", "trello"):
            raise ValueError(f"Fuente no válida para el índice {source_key}")
        if not source_key:
            raise ValueError("A la carga útil del índice le falta `sourceKey`")
        index_data = payload.get("index")
        if not isinstance(index_data, dict):
            raise ValueError(f"A la carga útil del índice {source_key} le falta el objeto `index`")

        file_kind = str(index_data.get("file_kind") or payload.get("fileKind") or "unknown").lower()
        idx_name = _index_filename(source_key, file_kind)
        idx_rel = f"indexes/{idx_name}"
        idx_path = indexes_dir / idx_name
        _json_dump(idx_path, index_data)

        index_summary = {
            "source": source,
            "source_key": source_key,
            "file_kind": file_kind,
            "display_name": payload.get("displayName") or index_data.get("display_name") or source_key,
            "mime_type": payload.get("mimeType") or index_data.get("mime_type") or "",
            "content_hash": payload.get("contentHash") or index_data.get("content_hash") or "",
            "index_file": idx_rel,
            "segment_count": len(index_data.get("segments") or []),
            "updated_at": utc_now_iso(),
            "warnings": index_data.get("warnings") or [],
            "source_locator": payload.get("sourceLocator") or {},
        }
        manifest["indexes"][source_key] = index_summary

        if source == "local":
            rel = str((payload.get("localFile") or {}).get("relativePath") or "").strip()
            if rel:
                stat = None
                try:
                    stat = file_stat_fingerprint(get_local_file_path(paths, card_id, rel))
                except Exception:
                    stat = None
                manifest["local_files"][rel] = {
                    "source_key": source_key,
                    "content_hash": index_summary["content_hash"],
                    "file_kind": file_kind,
                    "index_file": idx_rel,
                    "index_status": "indexed",
                    "last_indexed_at": utc_now_iso(),
                    "warnings": index_summary["warnings"],
                    "size": stat["size"] if stat else None,
                    "mtime_ns": stat["mtime_ns"] if stat else None,
                }
        else:
            trello_meta = payload.get("trelloAttachment") or {}
            attachment_id = str(trello_meta.get("attachmentId") or trello_meta.get("id") or "").strip()
            if attachment_id:
                cached_file = None
                raw_content = payload.get("contentBase64")
                if isinstance(raw_content, str) and raw_content.strip():
                    cached_file = _store_trello_attachment_cache(
                        ws_dir=ws_dir,
                        attachment_id=attachment_id,
                        display_name=str(trello_meta.get("name") or payload.get("displayName") or attachment_id),
                        content_base64=raw_content.strip(),
                    )
                    locator = index_summary.get("source_locator") or {}
                    if isinstance(locator, dict):
                        locator = dict(locator)
                        locator["cachedRelativePath"] = cached_file
                        index_summary["source_locator"] = locator
                manifest["trello_sources"][attachment_id] = {
                    "attachment_id": attachment_id,
                    "source_key": source_key,
                    "name": trello_meta.get("name") or payload.get("displayName"),
                    "mime_type": payload.get("mimeType") or trello_meta.get("mimeType"),
                    "content_hash": index_summary["content_hash"],
                    "index_file": idx_rel,
                    "last_indexed_at": utc_now_iso(),
                    "proxy_url": trello_meta.get("proxyUrl"),
                    "source_url": trello_meta.get("sourceUrl"),
                    "cached_file": cached_file,
                    "warnings": index_summary["warnings"],
                }

        saved.append({"sourceKey": source_key, "fileKind": file_kind, "indexFile": idx_rel})

    _save_manifest(ws_dir, manifest)
    return {"saved": saved, "workspace": get_card_workspace_info(paths, card_id)}


def remove_index_sources_for_card(
    paths: WorkbenchPaths,
    *,
    card_id: str,
    source_keys: List[str],
) -> Dict[str, Any]:
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise FileNotFoundError("No se encontró el espacio de trabajo")
    manifest = _load_manifest(ws_dir, card_id)
    remove_set = {str(key).strip() for key in source_keys if str(key).strip()}
    if not remove_set:
        return {"removed": [], "workspace": get_card_workspace_info(paths, card_id)}

    removed = []
    indexes = manifest.get("indexes") or {}
    for source_key in list(indexes.keys()):
        if source_key in remove_set:
            removed.append(source_key)
            indexes.pop(source_key, None)
    manifest["indexes"] = indexes

    local_files = manifest.get("local_files") or {}
    for rel, entry in list(local_files.items()):
        if isinstance(entry, dict) and entry.get("source_key") in remove_set:
            local_files.pop(rel, None)
    manifest["local_files"] = local_files

    trello_sources = manifest.get("trello_sources") or {}
    for attachment_id, entry in list(trello_sources.items()):
        if isinstance(entry, dict) and entry.get("source_key") in remove_set:
            trello_sources.pop(attachment_id, None)
    manifest["trello_sources"] = trello_sources

    _save_manifest(ws_dir, manifest)
    return {"removed": sorted(removed), "workspace": get_card_workspace_info(paths, card_id)}


def _load_index_by_source_key(ws_dir: Path, manifest: Dict[str, Any], source_key: str) -> Dict[str, Any]:
    entry = (manifest.get("indexes") or {}).get(source_key)
    if not entry:
        raise FileNotFoundError(f"No se encontró un índice para sourceKey={source_key}")
    idx_rel = entry.get("index_file")
    if not idx_rel:
        raise FileNotFoundError(f"Falta el archivo de índice para sourceKey={source_key}")
    idx_path = (ws_dir / idx_rel).resolve()
    if ws_dir.resolve() not in [idx_path, *idx_path.parents]:
        raise ValueError("Ruta de índice no válida")
    data = _json_load(idx_path, {})
    if not isinstance(data, dict):
        raise ValueError("Archivo de índice no válido")
    return data


def get_index_for_card(paths: WorkbenchPaths, card_id: str, source_key: str) -> Dict[str, Any]:
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise FileNotFoundError("No se encontró el espacio de trabajo")
    manifest = _load_manifest(ws_dir, card_id)
    index_data = _load_index_by_source_key(ws_dir, manifest, source_key)
    entry = manifest.get("indexes", {}).get(source_key, {})
    return {
        "sourceKey": source_key,
        "summary": entry,
        "index": index_data,
    }


def list_index_summaries(paths: WorkbenchPaths, card_id: str) -> Dict[str, Any]:
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        return {"indexes": []}
    manifest = _load_manifest(ws_dir, card_id)
    indexes = []
    for source_key, entry in sorted((manifest.get("indexes") or {}).items()):
        if isinstance(entry, dict):
            row = dict(entry)
            row["source_key"] = source_key
            indexes.append(row)
    return {"indexes": indexes}


def _collect_evidence_segments(
    paths: WorkbenchPaths,
    card_id: str,
    allowed_source_keys: Optional[List[str]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise FileNotFoundError("No se encontró el espacio de trabajo")
    manifest = _load_manifest(ws_dir, card_id)
    idx_entries = manifest.get("indexes") or {}
    evidence: List[Dict[str, Any]] = []
    index_lookup: Dict[str, Dict[str, Any]] = {}
    allowed = {str(key).strip() for key in (allowed_source_keys or []) if str(key).strip()} if allowed_source_keys else None
    for source_key, entry in idx_entries.items():
        if not isinstance(entry, dict):
            continue
        if allowed is not None and source_key not in allowed:
            continue
        try:
            data = _load_index_by_source_key(ws_dir, manifest, source_key)
        except Exception:
            continue
        index_lookup[source_key] = data
        segments = data.get("segments") or []
        # Keep payload compact while preserving anchors
        ev_segments = []
        for seg in segments[:500]:
            if not isinstance(seg, dict):
                continue
            ev_segments.append(
                {
                    "anchor_id": seg.get("anchor_id"),
                    "kind": seg.get("kind"),
                    "text": str(seg.get("text") or "")[:1200],
                    "page": seg.get("page"),
                    "sheet": seg.get("sheet"),
                    "meta": seg.get("meta") or {},
                }
            )
        evidence.append(
            {
                "source_key": source_key,
                "source": entry.get("source"),
                "display_name": entry.get("display_name"),
                "file_kind": data.get("file_kind") or entry.get("file_kind"),
                "mime_type": data.get("mime_type") or entry.get("mime_type"),
                "content_hash": data.get("content_hash") or entry.get("content_hash"),
                "warnings": data.get("warnings") or entry.get("warnings") or [],
                "segments": ev_segments,
            }
        )
    return evidence, index_lookup


def _response_text_from_responses_api(payload: Dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text
    texts: List[str] = []
    for item in payload.get("output") or []:
        if not isinstance(item, dict):
            continue
        for content in item.get("content") or []:
            if not isinstance(content, dict):
                continue
            txt = content.get("text")
            if isinstance(txt, str):
                texts.append(txt)
    return "\n".join(texts).strip()


def checklist_run_schema() -> Dict[str, Any]:
    citation = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "source_key": {"type": "string"},
            "anchor_id": {"type": "string"},
            "effect": {"type": "string", "enum": ["supports", "contradicts", "insufficient"]},
            "quote": {"type": "string"},
            "reason": {"type": "string"},
            "page": {"type": ["integer", "null"]},
            "sheet": {"type": ["string", "null"]},
            "bbox": {
                "type": ["array", "null"],
                "items": {"type": "number"},
                "minItems": 4,
                "maxItems": 4,
            },
        },
        "required": ["source_key", "anchor_id", "effect", "quote", "reason", "page", "sheet", "bbox"],
    }
    item = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "item_number": {"type": "integer", "minimum": 1},
            "item_id": {"type": "string"},
            "status": {"type": "string", "enum": ["pass", "fail", "needs_review"]},
            "confidence": {"type": "number"},
            "rationale": {"type": "string"},
            "citations": {"type": "array", "items": citation},
            "missing_evidence": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["item_number", "item_id", "status", "confidence", "rationale", "citations", "missing_evidence"],
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "summary": {"type": "string"},
            "items": {"type": "array", "items": item},
            "global_notes": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["summary", "items", "global_notes"],
    }


def build_system_prompt() -> str:
    return build_review_system_prompt()


def estimate_llm_input_tokens_for_card(
    paths: WorkbenchPaths,
    *,
    card_id: str,
    card_name: str,
    card_url: str,
    card_packet: Dict[str, Any],
    model: Optional[str] = None,
) -> Dict[str, Any]:
    checklist = load_checklist(paths)
    try:
        prep = get_card_workspace_status(paths, card_id=card_id, card_packet=card_packet).get("prep") or {}
        valid_source_keys = prep.get("validSourceKeys")
        evidence, _ = _collect_evidence_segments(paths, card_id, allowed_source_keys=valid_source_keys)
        multimodal_assets = _collect_multimodal_assets(paths, card_id, allowed_source_keys=valid_source_keys)
        workspace_exists = True
    except FileNotFoundError:
        evidence = []
        multimodal_assets = []
        workspace_exists = False
    return estimate_review_input_tokens(
        checklist=checklist,
        evidence=evidence,
        multimodal_assets=multimodal_assets,
        card_id=card_id,
        card_name=card_name,
        card_url=card_url,
        card_packet=card_packet,
        model=model,
        workspace_exists=workspace_exists,
    )


MULTIMODAL_MAX_TOTAL_BYTES = max(1, int(float(os.getenv("OPENAI_MULTIMODAL_MAX_BYTES", str(40 * 1024 * 1024)))))
MULTIMODAL_SUPPORTED_IMAGE_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
}


def _resolve_workspace_file(ws_dir: Path, rel_path: str) -> Path:
    candidate = (ws_dir / rel_path).resolve()
    if ws_dir.resolve() not in [candidate, *candidate.parents]:
        raise ValueError("Ruta del espacio de trabajo no válida")
    return candidate


def _source_path_for_multimodal_asset(
    paths: WorkbenchPaths,
    *,
    ws_dir: Path,
    manifest: Dict[str, Any],
    source_key: str,
    entry: Dict[str, Any],
) -> Optional[Path]:
    locator = entry.get("source_locator") or {}
    if isinstance(locator, dict):
        if locator.get("type") == "local_file":
            rel = str(locator.get("relativePath") or "").strip()
            if rel:
                try:
                    return get_local_file_path(paths, manifest.get("card_id") or "", rel)
                except Exception:
                    return None
        if locator.get("type") == "trello_attachment":
            cached_rel = str(locator.get("cachedRelativePath") or "").strip()
            if cached_rel:
                try:
                    path = _resolve_workspace_file(ws_dir, cached_rel)
                    if path.is_file():
                        return path
                except Exception:
                    return None

    for rel, local_entry in (manifest.get("local_files") or {}).items():
        if not isinstance(local_entry, dict) or local_entry.get("source_key") != source_key:
            continue
        try:
            return get_local_file_path(paths, manifest.get("card_id") or "", str(rel))
        except Exception:
            return None

    for attachment_id, trello_entry in (manifest.get("trello_sources") or {}).items():
        if not isinstance(trello_entry, dict) or trello_entry.get("source_key") != source_key:
            continue
        cached_rel = str(trello_entry.get("cached_file") or "").strip()
        if not cached_rel:
            continue
        try:
            path = _resolve_workspace_file(ws_dir, cached_rel)
            if path.is_file():
                return path
        except Exception:
            return None
    return None


def _collect_multimodal_assets(
    paths: WorkbenchPaths,
    card_id: str,
    allowed_source_keys: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise FileNotFoundError("No se encontró el espacio de trabajo")
    manifest = _load_manifest(ws_dir, card_id)
    idx_entries = manifest.get("indexes") or {}
    allowed = {str(key).strip() for key in (allowed_source_keys or []) if str(key).strip()} if allowed_source_keys else None
    assets: List[Dict[str, Any]] = []
    for source_key, entry in idx_entries.items():
        if not isinstance(entry, dict):
            continue
        if allowed is not None and source_key not in allowed:
            continue
        file_kind = str(entry.get("file_kind") or "").lower()
        mime_type = str(entry.get("mime_type") or detect_mime_from_name(str(entry.get("display_name") or ""))).split(";")[0].lower()
        if file_kind not in {"image", "pdf"}:
            continue
        source_path = _source_path_for_multimodal_asset(
            paths,
            ws_dir=ws_dir,
            manifest=manifest,
            source_key=source_key,
            entry=entry,
        )
        if not source_path or not source_path.is_file():
            continue
        byte_size = source_path.stat().st_size
        if file_kind == "image" and mime_type not in MULTIMODAL_SUPPORTED_IMAGE_MIME_TYPES:
            continue
        assets.append(
            {
                "source_key": source_key,
                "display_name": entry.get("display_name") or source_path.name,
                "file_kind": file_kind,
                "mime_type": mime_type,
                "byte_size": byte_size,
                "source_path": str(source_path),
                "anchor_hint": "image_full" if file_kind == "image" else "page_<n>",
                "warnings": entry.get("warnings") or [],
            }
        )
    assets.sort(key=lambda row: (str(row.get("source_key") or ""), str(row.get("display_name") or "")))
    return assets


def _multimodal_summary_payload(assets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {
            "source_key": asset.get("source_key"),
            "display_name": asset.get("display_name"),
            "file_kind": asset.get("file_kind"),
            "mime_type": asset.get("mime_type"),
            "byte_size": asset.get("byte_size"),
            "anchor_hint": asset.get("anchor_hint"),
            "warnings": asset.get("warnings") or [],
        }
        for asset in assets
    ]


def _build_multimodal_user_content(
    *,
    user_payload: Dict[str, Any],
    multimodal_assets: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    content: List[Dict[str, Any]] = []
    if multimodal_assets:
        content.append(
            {
                "type": "input_text",
                "text": (
                    "Multimodal evidence assets are attached below. "
                    "Use them together with the indexed evidence_documents. "
                    "For image files, cite anchor_id=image_full. "
                    "For PDFs, cite page anchors like page_1, page_2, etc. "
                    "If the relevant evidence is visual only, leave quote empty."
                ),
            }
        )
        total_bytes = 0
        omitted_assets: List[str] = []
        for asset in multimodal_assets:
            byte_size = int(asset.get("byte_size") or 0)
            if byte_size <= 0:
                continue
            if total_bytes + byte_size > MULTIMODAL_MAX_TOTAL_BYTES:
                omitted_assets.append(str(asset.get("source_key") or "?"))
                continue
            source_path = Path(str(asset.get("source_path") or ""))
            if not source_path.is_file():
                omitted_assets.append(str(asset.get("source_key") or "?"))
                continue
            raw = source_path.read_bytes()
            if len(raw) != byte_size:
                byte_size = len(raw)
            total_bytes += byte_size
            source_key = str(asset.get("source_key") or "?")
            file_kind = str(asset.get("file_kind") or "")
            display_name = str(asset.get("display_name") or source_path.name)
            anchor_hint = str(asset.get("anchor_hint") or "")
            content.append(
                {
                    "type": "input_text",
                    "text": (
                        f"Multimodal asset for source_key={source_key}; "
                        f"display_name={display_name}; file_kind={file_kind}; anchor_hint={anchor_hint}."
                    ),
                }
            )
            if file_kind == "pdf":
                mime_type = str(asset.get("mime_type") or "application/pdf")
                content.append(
                    {
                        "type": "input_file",
                        "filename": source_path.name,
                        "file_data": f"data:{mime_type};base64,{base64.b64encode(raw).decode('ascii')}",
                    }
                )
            elif file_kind == "image":
                mime_type = str(asset.get("mime_type") or "image/png")
                content.append(
                    {
                        "type": "input_image",
                        "detail": "high",
                        "image_url": f"data:{mime_type};base64,{base64.b64encode(raw).decode('ascii')}",
                    }
                )
        if omitted_assets:
            content.append(
                {
                    "type": "input_text",
                    "text": (
                        "The following multimodal assets were omitted from this request because the inline size limit was reached: "
                        + ", ".join(omitted_assets)
                        + ". Use indexed evidence only for them."
                    ),
                }
            )
    content.append({"type": "input_text", "text": json.dumps(user_payload, ensure_ascii=False)})
    return content


def _openai_request(
    *,
    api_key: str,
    model: str,
    reasoning_effort: str = "high",
    system_prompt: str,
    user_payload: Dict[str, Any],
    multimodal_assets: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    timeout_seconds = max(30, int(float(os.getenv("OPENAI_HTTP_TIMEOUT_SECONDS", "600"))))
    user_content = _build_multimodal_user_content(
        user_payload=user_payload,
        multimodal_assets=multimodal_assets or [],
    )
    base_body = {
        "model": model,
        "reasoning": {"effort": reasoning_effort},
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    }
    attempts = [
        {
            **base_body,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "checklist_review",
                    "schema": checklist_run_schema(),
                    "strict": True,
                }
            },
        },
        {
            **base_body,
            "input": [
                {"role": "system", "content": system_prompt + " Return strict JSON matching the requested schema."},
                {"role": "user", "content": user_content},
            ],
        },
    ]
    last_err: Optional[Exception] = None
    for attempt_idx, body in enumerate(attempts, start=1):
        req = Request(
            "https://api.openai.com/v1/responses",
            method="POST",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(req, timeout=timeout_seconds) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            last_err = RuntimeError(f"Error de OpenAI Responses API {e.code} (intento {attempt_idx}): {detail}")
            # If structured format is rejected, try plain JSON-prompt fallback once.
            if attempt_idx == 1:
                continue
            raise last_err from e
        except URLError as e:
            raise RuntimeError(
                f"Error de red de OpenAI Responses API para model={model} reasoning={reasoning_effort} "
                f"(timeout={timeout_seconds}s): {e}"
            ) from e
    if last_err:
        raise last_err
    raise RuntimeError("La solicitud a OpenAI Responses API falló")


def _validate_citations(result: Dict[str, Any], index_lookup: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    segment_maps: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for source_key, idx in index_lookup.items():
        seg_map: Dict[str, Dict[str, Any]] = {}
        for seg in idx.get("segments") or []:
            if isinstance(seg, dict) and seg.get("anchor_id"):
                seg_map[str(seg["anchor_id"])] = seg
        segment_maps[source_key] = seg_map

    for item in result.get("items") or []:
        if not isinstance(item, dict):
            continue
        validated = []
        for cit in item.get("citations") or []:
            if not isinstance(cit, dict):
                continue
            source_key = str(cit.get("source_key") or "")
            anchor_id = str(cit.get("anchor_id") or "")
            seg = segment_maps.get(source_key, {}).get(anchor_id)
            quote = str(cit.get("quote") or "")
            val = dict(cit)
            if val.get("effect") not in {"supports", "contradicts", "insufficient"}:
                val["effect"] = "insufficient"
            if not seg:
                val["validation"] = {"status": "missing_anchor", "score": 0}
            else:
                seg_text = str(seg.get("text") or "")
                if not quote:
                    score = 1.0 if not seg_text else 0.0
                elif normalize_text(quote) in normalize_text(seg_text):
                    score = 1.0
                else:
                    score = round(similarity_score(quote, seg_text), 4)
                val["validation"] = {
                    "status": "ok" if score >= 0.55 else "weak_match",
                    "score": score,
                    "segment_text_preview": seg_text[:240],
                }
                if val.get("page") is None and seg.get("page") is not None:
                    val["page"] = seg.get("page")
                if val.get("sheet") is None and seg.get("sheet") is not None:
                    val["sheet"] = seg.get("sheet")
            validated.append(val)
        item["citations"] = validated
    return result


def _align_run_items_to_checklist(result: Dict[str, Any], checklist: Dict[str, Any]) -> Dict[str, Any]:
    checklist_items = checklist.get("items") or []
    raw_items = result.get("items") or []
    by_id: Dict[str, Dict[str, Any]] = {}
    by_num: Dict[int, Dict[str, Any]] = {}
    extras: List[Dict[str, Any]] = []
    for row in raw_items:
        if not isinstance(row, dict):
            continue
        item_id = str(row.get("item_id") or "").strip()
        item_number = row.get("item_number")
        stored = False
        if item_id and item_id not in by_id:
            by_id[item_id] = row
            stored = True
        if isinstance(item_number, int) and item_number > 0 and item_number not in by_num:
            by_num[item_number] = row
            stored = True
        if not stored:
            extras.append(row)

    aligned: List[Dict[str, Any]] = []
    for idx, ck in enumerate(checklist_items, start=1):
        expected_id = str((ck or {}).get("id") or "")
        row = by_id.get(expected_id) or by_num.get(idx) or {}
        if not isinstance(row, dict):
            row = {}
        try:
            confidence = float(row.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        aligned.append(
            {
                "item_number": idx,
                "item_id": expected_id,
                "status": row.get("status") if row.get("status") in {"pass", "fail", "needs_review"} else "needs_review",
                "confidence": confidence,
                "rationale": str(row.get("rationale") or "El modelo no devolvió una respuesta para este criterio del Checklist.").strip(),
                "citations": row.get("citations") if isinstance(row.get("citations"), list) else [],
                "missing_evidence": (
                    row.get("missing_evidence")
                    if isinstance(row.get("missing_evidence"), list)
                    else ["El modelo omitió este criterio del Checklist en la respuesta."]
                ),
            }
        )

    result["items"] = aligned
    if extras:
        notes = result.get("global_notes")
        if not isinstance(notes, list):
            notes = []
        notes.append(f"Se ignoraron {len(extras)} resultado(s) extra de criterios del Checklist que no coinciden con el Checklist actual.")
        result["global_notes"] = notes
    return result


def _summarize_run(result: Dict[str, Any]) -> Dict[str, Any]:
    counts = {"pass": 0, "fail": 0, "needs_review": 0}
    for item in result.get("items") or []:
        status = str((item or {}).get("status") or "")
        if status in counts:
            counts[status] += 1
    overall = "ok"
    if counts["fail"] > 0:
        overall = "has_failures"
    elif counts["needs_review"] > 0:
        overall = "needs_review"
    return {"status": overall, "counts": counts}


def run_checklist_for_card(
    paths: WorkbenchPaths,
    *,
    card_id: str,
    card_name: str,
    card_url: str,
    card_packet: Dict[str, Any],
    model: Optional[str] = None,
    reasoning_effort: str = "high",
) -> Dict[str, Any]:
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise FileNotFoundError("No se encontró el espacio de trabajo de la tarjeta. Créalo primero.")
    prep = get_card_workspace_status(paths, card_id=card_id, card_packet=card_packet).get("prep") or {}
    if not prep.get("readyForRun"):
        raise ValueError(str(prep.get("blockingMessage") or "Se requiere preparación antes de ejecutar la revisión."))
    checklist = load_checklist(paths)
    valid_source_keys = prep.get("validSourceKeys")
    evidence, index_lookup = _collect_evidence_segments(paths, card_id, allowed_source_keys=valid_source_keys)
    if not evidence:
        raise ValueError("No se encontró evidencia indexada después de la conciliación. Prepara la revisión primero.")
    multimodal_assets = _collect_multimodal_assets(paths, card_id, allowed_source_keys=valid_source_keys)

    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Falta OPENAI_API_KEY en el entorno")
    model_name = (model or os.getenv("OPENAI_MODEL") or "gpt-5.4").strip()
    user_payload = build_review_user_payload(
        checklist=checklist,
        evidence=evidence,
        multimodal_assets=_multimodal_summary_payload(multimodal_assets),
        card_id=card_id,
        card_name=card_name,
        card_url=card_url,
        card_packet=card_packet,
    )

    raw_api = _openai_request(
        api_key=api_key,
        model=model_name,
        reasoning_effort=reasoning_effort,
        system_prompt=build_system_prompt(),
        user_payload=user_payload,
        multimodal_assets=multimodal_assets,
    )
    text = _response_text_from_responses_api(raw_api)
    if not text:
        raise RuntimeError("La respuesta de OpenAI no contenía texto de salida")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"La salida del modelo no era JSON válido: {e}\n{text[:1000]}") from e

    parsed = _align_run_items_to_checklist(parsed, checklist)
    parsed = _validate_citations(parsed, index_lookup)
    summary = _summarize_run(parsed)

    run_id = f"run_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid.uuid4().hex[:8]}"
    run_dir = _runs_dir(ws_dir) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    _json_dump(run_dir / "llm_request.json", user_payload)
    _json_dump(run_dir / "llm_response_raw.json", raw_api)
    run_result = {
        "run_id": run_id,
        "created_at": utc_now_iso(),
        "model": model_name,
        "reasoning_effort": reasoning_effort,
        "summary": summary,
        "card": {"id": card_id, "name": card_name, "url": card_url},
        "result": parsed,
    }
    _json_dump(run_dir / "run_result.json", run_result)

    manifest = _load_manifest(ws_dir, card_id)
    manifest_runs = manifest.get("runs")
    if not isinstance(manifest_runs, list):
        manifest_runs = []
        manifest["runs"] = manifest_runs
    manifest_runs.insert(
        0,
        {
            "run_id": run_id,
            "created_at": run_result["created_at"],
            "model": model_name,
            "reasoning_effort": reasoning_effort,
            "summary": summary,
        },
    )
    manifest["runs"] = manifest_runs[:50]
    _save_manifest(ws_dir, manifest)

    return {"run": run_result, "runs": list_runs_summary(ws_dir)}


def get_run_result(paths: WorkbenchPaths, card_id: str, run_id: str) -> Dict[str, Any]:
    ws_dir = _find_card_workspace_dir(paths, card_id)
    if not ws_dir:
        raise FileNotFoundError("No se encontró el espacio de trabajo")
    run_dir = _runs_dir(ws_dir) / run_id
    if not run_dir.exists():
        raise FileNotFoundError("No se encontró la ejecución")
    result = _json_load(run_dir / "run_result.json", None)
    if not isinstance(result, dict):
        raise FileNotFoundError("Falta el resultado de la ejecución")
    return result


def detect_mime_from_name(name: str) -> str:
    ext = Path(name).suffix.lower()
    return {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".csv": "text/csv",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(ext, "application/octet-stream")


def sha256_of_path(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()
