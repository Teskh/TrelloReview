from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

try:
    import tiktoken  # type: ignore
except Exception:  # pragma: no cover - optional dependency for local helper
    tiktoken = None


def build_review_system_prompt() -> str:
    return (
        "You are a meticulous document review assistant. "
        "Evaluate checklist items using only the provided evidence segments plus the provided Trello card description/comments context. "
        "Return exactly one result for every checklist item, in the same order, with the same item_number and item_id. "
        "Every conclusion must cite one or more evidence anchors. "
        "Citations must reference source_key and anchor_id exactly as provided. "
        "Treat card description and comments as contextual guidance; use indexed attachment evidence as the primary source for documentary claims whenever possible. "
        "If evidence is insufficient, ambiguous, or the document is image/scanned-only without usable text, "
        "return status='needs_review' and explain what is missing. "
        "Do not invent citations. Use verbatim quotes copied from the cited segment text when available. "
        "For image-only/scanned pages without text, set quote to an empty string and cite the page anchor."
    )


def _card_comment_context(card_packet: Dict[str, Any]) -> List[Dict[str, Any]]:
    comments: List[Dict[str, Any]] = []
    for row in card_packet.get("comments") or []:
        if not isinstance(row, dict):
            continue
        comments.append(
            {
                "date": row.get("date") or None,
                "author": row.get("author") or "",
                "text": str(row.get("text") or ""),
                "action_id": row.get("actionId") or None,
            }
        )
    return comments


def build_review_user_payload(
    *,
    checklist: Dict[str, Any],
    evidence: List[Dict[str, Any]],
    card_id: str,
    card_name: str,
    card_url: str,
    card_packet: Dict[str, Any],
) -> Dict[str, Any]:
    card_core = card_packet.get("card") if isinstance(card_packet, dict) else {}
    if not isinstance(card_core, dict):
        card_core = {}
    description = str(card_core.get("desc") or "")
    comments = _card_comment_context(card_packet if isinstance(card_packet, dict) else {})
    return {
        "task": "Evaluate checklist against Trello context and indexed evidence, and return structured results with citations.",
        "card": {
            "id": card_id,
            "name": card_name,
            "url": card_url,
            "description": description,
            "comments": comments,
            "metadata": {
                "labels": [l.get("name") or l.get("color") for l in (card_core.get("labels") or []) if isinstance(l, dict)],
                "members": [
                    m.get("fullName") or m.get("username")
                    for m in (card_packet.get("members") or [])
                    if isinstance(m, dict) and (m.get("fullName") or m.get("username"))
                ],
                "trello_attachment_count": len(card_packet.get("attachments") or []),
                "comment_count": len(comments),
            },
        },
        "checklist": checklist,
        "checklist_numbered_items": [
            {
                "item_number": i,
                "item_id": item.get("id"),
                "title": item.get("title"),
                "description": item.get("description"),
                "pass_criteria": item.get("pass_criteria"),
                "fail_criteria": item.get("fail_criteria"),
            }
            for i, item in enumerate(checklist.get("items") or [], start=1)
            if isinstance(item, dict)
        ],
        "citation_rules": {
            "must_cite_every_item": True,
            "cite_only_provided_source_key_and_anchor_id": True,
            "prefer_exact_quote": True,
            "for_image_or_scanned_pdf_without_text": "Use page anchor citation and empty quote, then mark needs_review unless other evidence resolves the item.",
        },
        "evidence_documents": evidence,
    }


def _get_tiktoken_encoder(model_name: str) -> Tuple[Any, str, bool]:
    if tiktoken is None:
        raise RuntimeError("tiktoken is not installed. Install it with: pip install tiktoken")
    try:
        return tiktoken.encoding_for_model(model_name), model_name, True
    except Exception:
        pass
    for enc_name in ("o200k_base", "cl100k_base"):
        try:
            return tiktoken.get_encoding(enc_name), enc_name, False
        except Exception:
            continue
    raise RuntimeError("Unable to initialize a tiktoken encoder")


def estimate_review_input_tokens(
    *,
    checklist: Dict[str, Any],
    evidence: List[Dict[str, Any]],
    card_id: str,
    card_name: str,
    card_url: str,
    card_packet: Dict[str, Any],
    model: Optional[str] = None,
    workspace_exists: bool = True,
) -> Dict[str, Any]:
    model_name = (model or os.getenv("OPENAI_MODEL") or "gpt-5.2").strip()
    system_prompt = build_review_system_prompt()
    user_payload = build_review_user_payload(
        checklist=checklist,
        evidence=evidence,
        card_id=card_id,
        card_name=card_name,
        card_url=card_url,
        card_packet=card_packet,
    )
    user_payload_json = json.dumps(user_payload, ensure_ascii=False)

    evidence_segment_count = 0
    for doc in evidence:
        if isinstance(doc, dict):
            evidence_segment_count += len(doc.get("segments") or [])

    card_core = card_packet.get("card") if isinstance(card_packet, dict) else {}
    if not isinstance(card_core, dict):
        card_core = {}
    description = str(card_core.get("desc") or "")
    comments = [c for c in (card_packet.get("comments") or []) if isinstance(c, dict)]
    comments_text_chars = 0
    for c in comments:
        comments_text_chars += len(str(c.get("text") or ""))

    response: Dict[str, Any] = {
        "available": False,
        "model": model_name,
        "workspace_exists": workspace_exists,
        "run_ready": bool(evidence),
        "payload_stats": {
            "checklist_items": len(checklist.get("items") or []),
            "evidence_documents": len(evidence),
            "evidence_segments": evidence_segment_count,
            "trello_attachments_on_card": len(card_packet.get("attachments") or []),
            "comments_count": len(comments),
            "comments_text_chars": comments_text_chars,
            "card_description_chars": len(description),
        },
        "components": {
            "system_prompt_chars": len(system_prompt),
            "user_payload_chars": len(user_payload_json),
            "user_payload_bytes_utf8": len(user_payload_json.encode("utf-8")),
        },
        "notes": [],
    }
    if not workspace_exists:
        response["notes"].append(
            "Workspace not created; indexed evidence is unavailable, so attachment-derived tokens are not included yet."
        )
    elif not evidence:
        response["notes"].append("No indexed evidence found; attachment-derived tokens are not included yet.")

    try:
        encoder, encoding_name, exact_model_encoding = _get_tiktoken_encoder(model_name)
        system_tokens = len(encoder.encode(system_prompt))
        user_tokens = len(encoder.encode(user_payload_json))
    except Exception as e:
        response["error"] = str(e)
        return response

    response["available"] = True
    response["tiktoken"] = {
        "encoding": encoding_name,
        "exact_model_encoding": exact_model_encoding,
    }
    response["counts"] = {
        "system_prompt_tokens": system_tokens,
        "user_payload_tokens": user_tokens,
        "total_input_tokens": system_tokens + user_tokens,
    }
    response["notes"].append(
        "Estimate counts the system prompt and JSON user payload content sent to the LLM. It excludes HTTP/API envelope overhead and output tokens."
    )
    return response
