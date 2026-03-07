#!/usr/bin/env python3
"""Local Trello review workbench UI (stdlib only).

Starts an HTTP server that:
  - serves a small HTML UI
  - exposes JSON endpoints that read Trello using API_KEY/TOKEN from .env

Usage:
  python trello_ui_server.py
  python trello_ui_server.py --port 8765
"""

from __future__ import annotations

import argparse
import json
import os
import mimetypes
from dataclasses import dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

from trello_smoke_test import TrelloClient, load_dotenv
from workbench_store import (
    detect_mime_from_name,
    estimate_llm_input_tokens_for_card,
    ensure_card_workspace,
    get_card_workspace_info,
    get_index_for_card,
    get_local_file_path,
    get_run_result,
    init_workbench_paths,
    list_index_summaries,
    load_checklist,
    load_checklist_text,
    run_checklist_for_card,
    save_checklist,
    save_checklist_text,
    save_indexes_for_card,
)

ROOT_DIR = Path(__file__).resolve().parent
UI_DIR = ROOT_DIR / "ui"
VALID_REASONING_EFFORTS = {"minimal", "low", "medium", "high"}


@dataclass
class AppConfig:
    api_key: str
    token: str


def load_config() -> AppConfig:
    env = load_dotenv(ROOT_DIR / ".env")
    # Populate process env for other modules (e.g., checklist runs) that read OpenAI vars directly.
    for key in ("OPENAI_API_KEY", "OPENAI_MODEL"):
        if env.get(key) and not os.getenv(key):
            os.environ[key] = env[key]
    api_key = env.get("API_KEY") or os.getenv("API_KEY") or ""
    token = env.get("TOKEN") or os.getenv("TOKEN") or ""
    if not api_key or not token:
        raise RuntimeError("Missing API_KEY/TOKEN in .env or environment")
    if any(ch in api_key for ch in "[]") or any(ch in token for ch in "[]"):
        raise RuntimeError("Replace placeholder values in .env with real API_KEY/TOKEN")
    return AppConfig(api_key=api_key, token=token)


def make_client(cfg: AppConfig) -> TrelloClient:
    return TrelloClient(api_key=cfg.api_key, token=cfg.token)


def parse_reasoning_effort(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    if not value:
        return "high"
    if value not in VALID_REASONING_EFFORTS:
        raise ValueError(
            f"Invalid reasoning_effort '{value}'. Expected one of: {', '.join(sorted(VALID_REASONING_EFFORTS))}"
        )
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
            or "Unknown"
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
    labels = ", ".join(l.get("name") or l.get("color") or "label" for l in card.get("labels", []))

    lines: List[str] = []
    lines.append(f"# Trello Card Review Packet: {card.get('name', '(unnamed)')}")
    lines.append("")
    lines.append("## Card Metadata")
    lines.append(f"- Card ID: `{card.get('id', '')}`")
    lines.append(f"- URL: {card.get('url', '')}")
    lines.append(f"- Last Activity: {card.get('dateLastActivity', '')}")
    if card.get("due"):
        lines.append(f"- Due: {card.get('due')}")
    if labels:
        lines.append(f"- Labels: {labels}")
    if member_names:
        lines.append(f"- Members: {member_names}")

    desc = (card.get("desc") or "").strip()
    lines.append("")
    lines.append("## Card Description")
    lines.append(desc if desc else "_No description_")

    lines.append("")
    lines.append("## Checklists")
    if not checklists:
        lines.append("_No checklists_")
    else:
        for checklist in checklists:
            lines.append(f"### {checklist.get('name', 'Checklist')}")
            for item in checklist.get("checkItems", []):
                mark = "x" if item.get("state") == "complete" else " "
                lines.append(f"- [{mark}] {item.get('name', '')}")
            lines.append("")

    lines.append("## Conversation Timeline (chronological)")
    if not timeline:
        lines.append("_No comments or attachment events_")
    else:
        for event in timeline:
            ts = event.get("date") or ""
            author = event.get("author") or "Unknown"
            if event.get("kind") == "comment":
                text = (event.get("text") or "").strip()
                lines.append(f"[{ts}] {author}: {text}")
                continue

            attachment = event.get("attachment") or {}
            name = attachment.get("name") or attachment.get("fileName") or "attachment"
            mime = attachment.get("mimeType") or "unknown"
            lines.append(f"[{ts}] {author} attached `{name}` ({mime})")
            if attachment.get("isImage") and attachment.get("proxyUrl"):
                lines.append(f"![{name}]({attachment.get('proxyUrl')})")
            if event.get("text"):
                lines.append(f"Note: {event.get('text')}")

    lines.append("")
    lines.append("## Attachments")
    if not attachments:
        lines.append("_No attachments_")
    else:
        for a in attachments:
            size = a.get("bytes")
            size_text = f"{size} bytes" if isinstance(size, int) else "size unknown"
            mime = a.get("mimeType") or "unknown"
            lines.append(
                f"- `{a.get('name', '')}` ({mime}, {size_text}) | {a.get('date', '')} | source={a.get('url', '')} | proxy={a.get('proxyUrl', '')}"
            )

    lines.append("")
    lines.append("## LLM Multimodal Assets")
    image_assets = [a for a in packet.get("llm_assets", []) if a.get("isImage")]
    if not image_assets:
        lines.append("_No image assets_")
    else:
        lines.append("Use these image URLs/files as separate multimodal inputs (not text-only markdown).")
        for a in image_assets:
            lines.append(f"- `{a.get('name', '')}` | {a.get('mimeType', '')} | {a.get('proxyUrl', '')}")

    lines.append("")
    lines.append("## Suggested LLM Checklist Input Notes")
    lines.append("- Use the conversation transcript as authoritative chronology.")
    lines.append("- Validate checklist status against comments and attachments.")
    lines.append("- Flag missing evidence if a checklist item implies a document/photo but none is attached.")

    return "\n".join(lines).strip() + "\n"


class TrelloWorkbenchHandler(SimpleHTTPRequestHandler):
    server_version = "TrelloWorkbench/0.1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    @property
    def app_config(self) -> AppConfig:
        return self.server.app_config  # type: ignore[attr-defined]

    @property
    def workbench_paths(self) -> Any:
        return self.server.workbench_paths  # type: ignore[attr-defined]

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
            raise ValueError("Invalid Content-Length") from e
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise ValueError("Invalid JSON body") from e
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
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

    def _proxy_attachment_content(self, client: TrelloClient, card_id: str, attachment_id: str) -> None:
        attachment = client.get(
            f"/cards/{card_id}/attachments/{attachment_id}",
            fields="id,name,fileName,url,mimeType",
        )
        source_url = attachment.get("url")
        if not source_url:
            self._send_error_json(HTTPStatus.NOT_FOUND, "Attachment URL not available")
            return
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
            self._send_error_json(e.code or HTTPStatus.BAD_GATEWAY, f"Attachment fetch failed: {detail}")
            return
        except URLError as e:
            self._send_error_json(HTTPStatus.BAD_GATEWAY, f"Attachment fetch network error: {e}")
            return

        filename = attachment.get("fileName") or attachment.get("name")
        self._send_binary(body=body, content_type=content_type, filename=filename)

    def _send_local_file(self, card_id: str, rel_path: str) -> None:
        file_path = get_local_file_path(self.workbench_paths, card_id, rel_path)
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
            self._send_error_json(HTTPStatus.NOT_FOUND, "Route not found")
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

            if path.startswith("/api/boards/") and path.endswith("/cards"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid board cards route")
                    return
                board_id = parts[2]
                limit = int(qs.get("limit", ["200"])[0])
                query = (qs.get("q", [""])[0] or "").strip()
                self._send_json(get_board_cards(client, board_id=board_id, limit=limit, query=query))
                return

            if path.startswith("/api/cards/") and path.endswith("/packet"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid card packet route")
                    return
                card_id = parts[2]
                packet = get_card_packet(client, card_id=card_id)
                markdown = render_markdown_transcript(packet)
                self._send_json({"packet": packet, "markdown": markdown})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace"):
                parts = path.strip("/").split("/")
                if len(parts) != 4:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid workspace route")
                    return
                card_id = parts[2]
                self._send_json(get_card_workspace_info(self.workbench_paths, card_id))
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/indexes"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid workspace indexes route")
                    return
                card_id = parts[2]
                self._send_json(list_index_summaries(self.workbench_paths, card_id))
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/index"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid workspace index route")
                    return
                card_id = parts[2]
                source_key = (qs.get("sourceKey", [""])[0] or "").strip()
                if not source_key:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Missing sourceKey")
                    return
                self._send_json(get_index_for_card(self.workbench_paths, card_id, source_key))
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/files/content"):
                parts = path.strip("/").split("/")
                if len(parts) != 6:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid local file content route")
                    return
                card_id = parts[2]
                rel_path = (qs.get("path", [""])[0] or "").strip()
                if not rel_path:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Missing path query parameter")
                    return
                self._send_local_file(card_id, rel_path)
                return

            if "/workspace/runs/" in path:
                parts = path.strip("/").split("/")
                if len(parts) != 6 or parts[3] != "workspace" or parts[4] != "runs":
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid workspace run route")
                    return
                card_id = parts[2]
                run_id = parts[5]
                self._send_json(get_run_result(self.workbench_paths, card_id, run_id))
                return

            if path.startswith("/api/cards/") and "/attachments/" in path and path.endswith("/content"):
                parts = path.strip("/").split("/")
                if len(parts) != 6 or parts[3] != "attachments":
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid attachment content route")
                    return
                card_id = parts[2]
                attachment_id = parts[4]
                self._proxy_attachment_content(client, card_id=card_id, attachment_id=attachment_id)
                return

            self._send_error_json(HTTPStatus.NOT_FOUND, "Route not found")
        except ValueError as e:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        except FileNotFoundError as e:
            self._send_error_json(HTTPStatus.NOT_FOUND, str(e))
        except Exception as e:  # pragma: no cover - debug-friendly for local tool
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

            if path.startswith("/api/cards/") and path.endswith("/workspace/token-estimate"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid workspace token estimate route")
                    return
                card_id = parts[2]
                model = (payload.get("model") or "").strip() if isinstance(payload.get("model"), str) else None
                card_packet = payload.get("cardPacket")
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
                )
                self._send_json({"ok": True, "estimate": estimate})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/create"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid workspace create route")
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
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid workspace indexes save route")
                    return
                card_id = parts[2]
                indexes = payload.get("indexes")
                if not isinstance(indexes, list):
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Body must contain indexes array")
                    return
                card = client.get("/cards/" + card_id, fields="id,name,url")
                result = save_indexes_for_card(
                    self.workbench_paths,
                    card_id=card_id,
                    card_name=card.get("name") or card_id,
                    card_url=card.get("url") or "",
                    indexes=indexes,
                )
                self._send_json({"ok": True, **result})
                return

            if path.startswith("/api/cards/") and path.endswith("/workspace/run"):
                parts = path.strip("/").split("/")
                if len(parts) != 5:
                    self._send_error_json(HTTPStatus.BAD_REQUEST, "Invalid workspace run route")
                    return
                card_id = parts[2]
                card_packet = get_card_packet(client, card_id=card_id)
                card = card_packet.get("card") or {}
                model = (payload.get("model") or "").strip() if isinstance(payload.get("model"), str) else None
                reasoning_effort = parse_reasoning_effort(payload.get("reasoning_effort"))
                result = run_checklist_for_card(
                    self.workbench_paths,
                    card_id=card_id,
                    card_name=card.get("name") or card_id,
                    card_url=card.get("url") or "",
                    card_packet=card_packet,
                    model=model,
                    reasoning_effort=reasoning_effort,
                )
                self._send_json({"ok": True, **result})
                return

            self._send_error_json(HTTPStatus.NOT_FOUND, "Route not found")
        except ValueError as e:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        except FileNotFoundError as e:
            self._send_error_json(HTTPStatus.NOT_FOUND, str(e))
        except Exception as e:  # pragma: no cover - debug-friendly for local tool
            self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Trello workbench UI server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    if not UI_DIR.exists():
        raise SystemExit(f"UI directory not found: {UI_DIR}")

    cfg = load_config()
    server = ThreadingHTTPServer((args.host, args.port), TrelloWorkbenchHandler)
    server.app_config = cfg  # type: ignore[attr-defined]
    server.workbench_paths = init_workbench_paths(ROOT_DIR)  # type: ignore[attr-defined]

    print(f"Trello workbench: http://{args.host}:{args.port}")
    print("Endpoints:")
    print("  GET /api/boards")
    print("  GET /api/boards/<boardId>/cards?limit=200")
    print("  GET /api/cards/<cardId>/packet")
    print("  GET /api/cards/<cardId>/attachments/<attachmentId>/content")
    print("  GET /api/checklist")
    print("  POST /api/checklist")
    print("  GET /api/cards/<cardId>/workspace")
    print("  POST /api/cards/<cardId>/workspace/token-estimate")
    print("  POST /api/cards/<cardId>/workspace/create")
    print("  POST /api/cards/<cardId>/workspace/indexes")
    print("  POST /api/cards/<cardId>/workspace/run")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
