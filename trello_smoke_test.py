#!/usr/bin/env python3
"""Minimal Trello API smoke test + sample board export.

Usage:
  python trello_smoke_test.py
  python trello_smoke_test.py --board-id <BOARD_ID> --limit 3

Reads credentials from a local .env file in the same directory:
  API_KEY=...
  TOKEN=...
  SECRET=...   # optional for this script, not used
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

BASE_URL = "https://api.trello.com/1"


def load_dotenv(dotenv_path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not dotenv_path.exists():
        return values

    for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if not key:
            continue
        values[key] = value
    return values


class TrelloClient:
    def __init__(self, api_key: str, token: str, timeout: int = 30) -> None:
        self.api_key = api_key
        self.token = token
        self.timeout = timeout

    def get(self, path: str, **params: Any) -> Any:
        query = {
            "key": self.api_key,
            "token": self.token,
        }
        for k, v in params.items():
            if v is None:
                continue
            query[k] = v

        url = f"{BASE_URL}{path}?{urlencode(query, doseq=True)}"
        try:
            with urlopen(url, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {e.code} for {path}: {body}") from e
        except URLError as e:
            raise RuntimeError(f"Network error for {path}: {e}") from e


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip()).strip("-").lower()
    return slug[:60] or "card"


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def auth_smoke_test(client: TrelloClient) -> Dict[str, Any]:
    me = client.get("/members/me", fields="id,fullName,username")
    boards = client.get(
        "/members/me/boards",
        fields="id,name,url,closed,dateLastActivity",
        filter="open",
    )
    return {"me": me, "boards": boards}


def export_board_sample(
    client: TrelloClient,
    board_id: str,
    out_dir: Path,
    limit: int,
    sleep_ms: int = 0,
) -> Dict[str, Any]:
    board = client.get("/boards/" + board_id, fields="id,name,desc,url,closed,dateLastActivity")
    cards = client.get(
        "/boards/" + board_id + "/cards",
        fields="id,name,desc,idList,idMembers,labels,dateLastActivity,url,closed",
        filter="open",
    )

    board_dir = out_dir / f"board_{board_id}"
    save_json(board_dir / "board.json", board)
    save_json(board_dir / "cards_index.json", cards)

    exported_cards: List[Dict[str, Any]] = []
    for idx, card in enumerate(cards[:limit], start=1):
        card_id = card["id"]
        if sleep_ms:
            time.sleep(sleep_ms / 1000.0)

        card_core = client.get(
            "/cards/" + card_id,
            fields="id,name,desc,idList,idMembers,labels,dateLastActivity,url,closed,due,start",
        )
        comments = client.get(
            "/cards/" + card_id + "/actions",
            filter="commentCard",
            limit=200,
            fields="data,date,type,idMemberCreator",
        )
        attachments = client.get(
            "/cards/" + card_id + "/attachments",
            fields="id,name,url,bytes,date,mimeType,idMember",
        )
        checklists = client.get("/cards/" + card_id + "/checklists")
        members = client.get("/cards/" + card_id + "/members", fields="id,fullName,username")

        packet = {
            "card": card_core,
            "members": members,
            "comments": comments,
            "attachments": attachments,
            "checklists": checklists,
        }

        filename = f"{idx:02d}_{card_id}_{slugify(card_core.get('name', 'card'))}.json"
        save_json(board_dir / "cards" / filename, packet)
        exported_cards.append(
            {
                "id": card_id,
                "name": card_core.get("name"),
                "comments": len(comments) if isinstance(comments, list) else None,
                "attachments": len(attachments) if isinstance(attachments, list) else None,
                "checklists": len(checklists) if isinstance(checklists, list) else None,
                "file": str((board_dir / "cards" / filename).relative_to(out_dir)),
            }
        )

    summary = {
        "board": {"id": board.get("id"), "name": board.get("name")},
        "total_open_cards": len(cards) if isinstance(cards, list) else None,
        "exported_card_count": len(exported_cards),
        "cards": exported_cards,
    }
    save_json(board_dir / "sample_export_summary.json", summary)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Trello API smoke test and sample exporter")
    parser.add_argument("--board-id", help="Board ID to export sample card packets from")
    parser.add_argument("--limit", type=int, default=3, help="How many cards to export (default: 3)")
    parser.add_argument("--out", default="output", help="Output folder for exported JSON (default: output)")
    parser.add_argument(
        "--sleep-ms",
        type=int,
        default=0,
        help="Optional delay between per-card requests in milliseconds",
    )
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    env_file = script_dir / ".env"
    env = load_dotenv(env_file)

    api_key = env.get("API_KEY") or os.getenv("API_KEY")
    token = env.get("TOKEN") or os.getenv("TOKEN")

    if not api_key or not token:
        print("Missing API_KEY and/or TOKEN.", file=sys.stderr)
        print(f"Expected them in {env_file} or environment variables.", file=sys.stderr)
        return 1

    if "[" in api_key or "]" in api_key or "[" in token or "]" in token:
        print("Your .env appears to contain placeholders like [token]. Replace with real values.", file=sys.stderr)
        return 1

    client = TrelloClient(api_key=api_key, token=token)

    try:
        smoke = auth_smoke_test(client)
    except RuntimeError as e:
        print(f"Auth smoke test failed: {e}", file=sys.stderr)
        return 2

    me = smoke["me"]
    boards = smoke["boards"]
    print(f"Authenticated as: {me.get('fullName')} (@{me.get('username')})")
    print(f"Open boards visible: {len(boards)}")
    for b in boards[:20]:
        print(f"- {b.get('name')} | id={b.get('id')} | {b.get('url')}")

    if not args.board_id:
        print("\nPass --board-id <id> to export sample card data.")
        return 0

    out_dir = (script_dir / args.out).resolve()
    try:
        summary = export_board_sample(
            client=client,
            board_id=args.board_id,
            out_dir=out_dir,
            limit=max(args.limit, 1),
            sleep_ms=max(args.sleep_ms, 0),
        )
    except RuntimeError as e:
        print(f"Board export failed: {e}", file=sys.stderr)
        return 3

    print("\nSample export complete")
    print(f"Board: {summary['board']['name']} ({summary['board']['id']})")
    print(f"Exported cards: {summary['exported_card_count']} / {summary['total_open_cards']} open")
    print(f"Output: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
