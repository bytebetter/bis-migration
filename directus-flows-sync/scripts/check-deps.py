#!/usr/bin/env python3
"""
Scan a committed Directus flows/operations SQL snapshot for external dependencies
beyond the flow/operation graph itself (collections, folders, URLs, custom ops, …).

Findings that need action (hardcoded URLs, folders, custom ops, $env, roles, …)
include flow name + operation name/id.

Usage:
  ./scripts/check-deps.py [exports/directus_flows_operations.sql]
  ./scripts/check-deps.py --json
  ./scripts/check-deps.py --collections-file /tmp/cols.txt --folders-file /tmp/folders.txt

Exit codes:
  0  always (report only), unless --strict and dest probes report missing objects → 1
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.I,
)
ENV_RE = re.compile(
    r"(?:\{\{\s*\$?env\.|\$env\.|process\.env\.|\$env\[['\"])([A-Za-z_][A-Za-z0-9_]*)",
    re.I,
)
HARDCODED_URL_RE = re.compile(r"https?://[^\s'\"\\]+", re.I)
# Match both raw JSON and SQL/JSON-escaped bodies: "folder": "uuid" or \"folder\": \"uuid\"
FOLDER_BODY_RE = re.compile(
    r'(?:\\?["\'])folder(?:\\?["\'])\s*:\s*(?:\\?["\'])('
    + UUID_RE.pattern
    + r')(?:\\?["\'])',
    re.I,
)

# Operation types shipped with Directus core flows (not extension packages).
CORE_OP_TYPES = {
    "condition",
    "exec",
    "item-create",
    "item-delete",
    "item-read",
    "item-update",
    "json-web-token",
    "log",
    "mail",
    "notification",
    "request",
    "sleep",
    "transform",
    "trigger",
}


def sql_values(s: str) -> list[Any]:
    out: list[Any] = []
    i = 0
    n = len(s)
    while i < n:
        while i < n and s[i] in " \t\n\r,":
            i += 1
        if i >= n:
            break
        if s.startswith("NULL", i) and (i + 4 >= n or s[i + 4] in ",)"):
            out.append(None)
            i += 4
            continue
        if s[i] == "'":
            i += 1
            buf: list[str] = []
            while i < n:
                if s[i] == "'":
                    if i + 1 < n and s[i + 1] == "'":
                        buf.append("'")
                        i += 2
                        continue
                    i += 1
                    break
                buf.append(s[i])
                i += 1
            out.append("".join(buf))
            continue
        j = i
        while j < n and s[j] not in ",)":
            j += 1
        out.append(s[i:j].strip())
        i = j
    return out


def parse_inserts(text: str, table: str) -> list[dict[str, Any]]:
    pat = re.compile(
        rf"INSERT INTO (?:public\.)?{re.escape(table)} \(([^)]+)\) VALUES \((.*)\);\s*$",
        re.M,
    )
    rows: list[dict[str, Any]] = []
    for m in pat.finditer(text):
        cols = [c.strip() for c in m.group(1).split(",")]
        vals = sql_values(m.group(2))
        rows.append(dict(zip(cols, vals)))
    return rows


def load_lines(path: Path | None) -> set[str] | None:
    if path is None:
        return None
    if not path.is_file():
        raise SystemExit(f"ERROR: file not found: {path}")
    return {ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()}


def _loc(
    *,
    flow_id: str | None,
    flow_name: str | None,
    op_id: str | None = None,
    op_name: str | None = None,
    op_type: str | None = None,
    op_key: str | None = None,
) -> dict[str, Any]:
    return {
        "flow_id": flow_id,
        "flow_name": flow_name or (flow_id or "?"),
        "op_id": op_id,
        "op_name": op_name,
        "op_type": op_type,
        "op_key": op_key,
    }


def _fmt_loc(row: dict[str, Any]) -> str:
    flow = row.get("flow_name") or row.get("flow_id") or "?"
    parts = [f"flow={flow}"]
    if row.get("op_name") or row.get("op_id"):
        op = row.get("op_name") or row.get("op_key") or row.get("op_id")
        parts.append(f"op={op}")
    if row.get("op_id"):
        parts.append(f"op_id={row['op_id']}")
    if row.get("op_type"):
        parts.append(f"type={row['op_type']}")
    return "  |  ".join(parts)


def analyze(
    sql_path: Path,
    collections_present: set[str] | None = None,
    folders_present: set[str] | None = None,
) -> dict[str, Any]:
    text = sql_path.read_text(encoding="utf-8")
    flows = parse_inserts(text, "directus_flows")
    ops = parse_inserts(text, "directus_operations")
    flow_by_id = {f["id"]: f for f in flows if f.get("id")}
    flow_ids = set(flow_by_id)
    op_ids = {o["id"] for o in ops if o.get("id")}

    def flow_name(fid: str | None) -> str | None:
        if not fid:
            return None
        f = flow_by_id.get(fid)
        return (f.get("name") if f else None) or fid

    collections: Counter[str] = Counter()
    flow_collections: Counter[str] = Counter()
    op_collections: Counter[str] = Counter()
    op_types: Counter[str] = Counter()
    request_urls: Counter[str] = Counter()
    permissions: Counter[str] = Counter()
    user_created: Counter[str] = Counter()
    system_api_paths: Counter[str] = Counter()
    trigger_flows: Counter[str] = Counter()
    external_uuids: Counter[str] = Counter()
    notes: list[str] = []

    # Occurrence-level findings (with flow context)
    hardcoded_url_hits: list[dict[str, Any]] = []
    folder_hits: list[dict[str, Any]] = []
    env_key_hits: list[dict[str, Any]] = []
    role_hits: list[dict[str, Any]] = []
    custom_ops: list[dict[str, Any]] = []
    environment_data_hits: list[dict[str, Any]] = []
    cron_hits: list[dict[str, Any]] = []
    request_url_hits: list[dict[str, Any]] = []

    for f in flows:
        fid = f.get("id")
        fname = f.get("name") or fid
        if f.get("user_created"):
            user_created[str(f["user_created"])] += 1
        try:
            opt = json.loads(f.get("options") or "{}")
        except json.JSONDecodeError:
            continue
        if not isinstance(opt, dict):
            continue
        for c in opt.get("collections") or []:
            flow_collections[str(c)] += 1
            collections[str(c)] += 1
        if opt.get("cron"):
            cron_hits.append(
                {
                    **_loc(flow_id=fid, flow_name=fname),
                    "expr": str(opt["cron"]),
                }
            )

    for o in ops:
        t = o.get("type") or "?"
        op_types[t] += 1
        blob = o.get("options") or ""
        name = o.get("name") or o.get("key") or ""
        oid = o.get("id")
        okey = o.get("key")
        fid = o.get("flow")
        fname = flow_name(fid)
        loc = _loc(
            flow_id=fid,
            flow_name=fname,
            op_id=oid,
            op_name=str(name) if name else None,
            op_type=t,
            op_key=str(okey) if okey else None,
        )

        for m in ENV_RE.finditer(blob):
            env_key_hits.append({**loc, "key": m.group(1)})

        seen_folders: set[str] = set()
        for m in FOLDER_BODY_RE.finditer(blob):
            folder_id = m.group(1).lower()
            seen_folders.add(folder_id)
            folder_hits.append({**loc, "folder_id": folder_id})

        # Exec often compares folder UUID without a JSON "folder" key.
        if t == "exec" and "folder" in blob.lower():
            for m in UUID_RE.finditer(blob):
                folder_id = m.group(0).lower()
                if folder_id in flow_ids or folder_id in op_ids:
                    continue
                if folder_id in seen_folders:
                    continue
                seen_folders.add(folder_id)
                folder_hits.append({**loc, "folder_id": folder_id})

        for m in HARDCODED_URL_RE.finditer(blob):
            hardcoded_url_hits.append({**loc, "url": m.group(0)})

        try:
            opt = json.loads(blob or "{}")
        except json.JSONDecodeError:
            continue
        if not isinstance(opt, dict):
            continue

        if t.startswith("item-") and opt.get("collection"):
            c = str(opt["collection"])
            op_collections[c] += 1
            collections[c] += 1

        if t == "request":
            url = str(opt.get("url") or "<missing>")
            request_urls[url] += 1
            request_url_hits.append({**loc, "url": url})
            if "/users" in url:
                system_api_paths["users"] += 1
            if "/files" in url:
                system_api_paths["files"] += 1
            if "/notifications" in url:
                system_api_paths["notifications"] += 1
            if "/revisions" in url:
                system_api_paths["revisions"] += 1
            if "webhook" in url.lower() or "webhook" in str(name).lower():
                system_api_paths["webhook-labeled-request"] += 1

        if t == "trigger" and opt.get("flow"):
            trigger_flows[str(opt["flow"])] += 1

        if opt.get("permissions") is not None:
            permissions[str(opt["permissions"])] += 1

        if t not in CORE_OP_TYPES:
            custom_ops.append(
                {
                    **loc,
                    "option_keys": sorted(opt.keys()),
                }
            )

        if t == "item-read" and opt.get("collection") == "environment_data":
            environment_data_hits.append({**loc, "key": str(opt.get("key"))})

        def walk(obj: Any, path: str = "") -> None:
            if isinstance(obj, dict):
                for k, v in obj.items():
                    p = f"{path}.{k}" if path else k
                    lk = k.lower()
                    if lk in ("role", "roles") or lk.endswith("_role"):
                        role_hits.append({**loc, "path": p, "value": v})
                    walk(v, p)
            elif isinstance(obj, list):
                for i, v in enumerate(obj):
                    walk(v, f"{path}[{i}]")
            elif isinstance(obj, str):
                for u in UUID_RE.findall(obj):
                    ul = u.lower()
                    if ul in flow_ids or ul in op_ids:
                        continue
                    if ul in seen_folders:
                        continue
                    external_uuids[ul] += 1

        walk(opt)

    folder_ids = {h["folder_id"] for h in folder_hits}
    for fid in folder_ids:
        external_uuids.pop(fid, None)
    for uid in user_created:
        external_uuids.pop(uid.lower(), None)

    missing_collections: list[str] = []
    missing_folders: list[str] = []
    if collections_present is not None:
        for c in sorted(collections):
            if c.startswith("{{"):
                continue
            if c not in collections_present:
                missing_collections.append(c)
    if folders_present is not None:
        for folder_id in sorted(folder_ids):
            if folder_id not in folders_present:
                missing_folders.append(folder_id)

    if hardcoded_url_hits:
        notes.append(
            "At least one request URL is hardcoded (not via environment_data). "
            "Confirm it matches the target environment before apply."
        )
    if custom_ops:
        notes.append(
            "Custom operation types require matching Directus extensions on dest."
        )
    if environment_data_hits:
        notes.append(
            "Flows read collection environment_data (typically url + access_token). "
            "Ensure that row exists on dest with correct values."
        )
    if folder_hits:
        notes.append(
            "Hardcoded directus_folders UUIDs must exist on dest (or file-move steps fail)."
        )
    if not env_key_hits:
        notes.append("No Directus $env / process.env key references found in options.")

    # Aggregate helpers for summary counts
    hardcoded_urls_unique = sorted({h["url"] for h in hardcoded_url_hits})
    folders_unique = sorted(folder_ids)
    env_keys_unique = sorted({h["key"] for h in env_key_hits})
    roles_unique = sorted({str(h["value"]) for h in role_hits})

    report = {
        "snapshot": str(sql_path),
        "counts": {
            "flows": len(flows),
            "operations": len(ops),
            "collections_unique": len(
                [c for c in collections if not str(c).startswith("{{")]
            ),
            "request_ops": op_types.get("request", 0),
            "request_url_patterns": len(request_urls),
            "hardcoded_urls": len(hardcoded_urls_unique),
            "hardcoded_url_hits": len(hardcoded_url_hits),
            "folders": len(folders_unique),
            "folder_hits": len(folder_hits),
            "env_keys": len(env_keys_unique),
            "roles": len(roles_unique),
            "custom_operation_types": len({c["op_type"] for c in custom_ops}),
            "custom_operation_instances": len(custom_ops),
            "cron_schedules": len({h["expr"] for h in cron_hits}),
            "trigger_flow_targets": len(trigger_flows),
            "environment_data_reads": len(environment_data_hits),
            "user_created_unique": len(user_created),
            "external_uuids_other": len(external_uuids),
        },
        "operation_types": dict(op_types.most_common()),
        "collections": [
            {
                "name": c,
                "refs": n,
                "as_flow_trigger": flow_collections[c],
                "as_operation": op_collections[c],
            }
            for c, n in collections.most_common()
            if not str(c).startswith("{{")
        ],
        "dynamic_collections": [c for c in collections if str(c).startswith("{{")],
        "folders": folder_hits,
        "hardcoded_urls": hardcoded_url_hits,
        "request_urls": request_url_hits,
        "request_url_patterns": [
            {"url": u, "refs": n} for u, n in request_urls.most_common()
        ],
        "env_keys": env_key_hits,
        "roles": role_hits,
        "system_api_paths": dict(system_api_paths.most_common()),
        "custom_operations": custom_ops,
        "cron": cron_hits,
        "permissions": dict(permissions.most_common()),
        "environment_data": environment_data_hits,
        "user_created": [{"id": u, "refs": n} for u, n in user_created.most_common()],
        "external_uuids_other": [
            {"id": u, "refs": n} for u, n in external_uuids.most_common(50)
        ],
        "trigger_flow_targets_internal": sum(
            1 for tid in trigger_flows if tid in flow_ids
        ),
        "trigger_flow_targets_missing": [
            tid for tid in trigger_flows if tid not in flow_ids
        ],
        "dest_probe": {
            "collections_checked": collections_present is not None,
            "folders_checked": folders_present is not None,
            "missing_collections": missing_collections,
            "missing_folders": missing_folders,
        },
        "notes": notes,
        "verdict": {
            "external_deps_many": False,
            "summary_th": "",
        },
    }

    infra = (
        len(folders_unique)
        + len(hardcoded_urls_unique)
        + len(env_keys_unique)
        + len(roles_unique)
        + len({c["op_type"] for c in custom_ops})
        + (1 if environment_data_hits else 0)
    )
    many = len(collections) > 40 or infra > 15
    report["verdict"]["external_deps_many"] = many
    report["verdict"]["summary_th"] = (
        f"พบ collection อ้างอิง {report['counts']['collections_unique']} รายการ "
        f"(ส่วนใหญ่เป็นตารางแอป), folder UUID {len(folders_unique)}, "
        f"request URL patterns {len(request_urls)} "
        f"(hardcoded {len(hardcoded_urls_unique)}), "
        f"custom op types {report['counts']['custom_operation_types']}, "
        f"$env keys {len(env_keys_unique)}, roles {len(roles_unique)}. "
        + (
            "ปริมาณ infra ภายนอกไม่มาก — ตรวจ folder + environment_data + extension เป็นหลัก."
            if not many
            else "มี dependency ภายนอกค่อนข้างเยอะ — ตรวจรายการด้านบนก่อน apply."
        )
    )
    return report


def print_human(report: dict[str, Any]) -> None:
    c = report["counts"]
    print(f"Snapshot: {report['snapshot']}")
    print(f"Flows: {c['flows']}  Operations: {c['operations']}")
    print()
    print("=== Summary (external refs beyond flow/op graph) ===")
    print(f"  collections (unique):     {c['collections_unique']}")
    print(f"  folders (UUID):           {c['folders']}  (hits={c['folder_hits']})")
    print(
        f"  request ops / URL patterns: {c['request_ops']} / {c['request_url_patterns']}"
    )
    print(
        f"  hardcoded absolute URLs:  {c['hardcoded_urls']}  "
        f"(hits={c['hardcoded_url_hits']})"
    )
    print(f"  $env keys:                {c['env_keys']}")
    print(f"  roles:                    {c['roles']}")
    print(
        f"  custom op types / instances: "
        f"{c['custom_operation_types']} / {c['custom_operation_instances']}"
    )
    print(f"  environment_data reads:   {c['environment_data_reads']}")
    print(f"  cron schedules:           {c['cron_schedules']}")
    print(f"  user_created (metadata):  {c['user_created_unique']}")
    print()
    print(report["verdict"]["summary_th"])
    print()

    print("=== Operation types ===")
    for t, n in report["operation_types"].items():
        mark = "  [extension?]" if t not in CORE_OP_TYPES else ""
        print(f"  {n:4d}  {t}{mark}")

    print()
    print("=== Collections ===")
    for row in report["collections"]:
        print(
            f"  {row['refs']:4d}  {row['name']}"
            f"  (trigger={row['as_flow_trigger']}, ops={row['as_operation']})"
        )
    if report["dynamic_collections"]:
        print("  dynamic:", ", ".join(report["dynamic_collections"]))

    if report["hardcoded_urls"]:
        print()
        print("=== Hardcoded absolute URLs (actionable) ===")
        for row in report["hardcoded_urls"]:
            print(f"  URL: {row['url']}")
            print(f"       {_fmt_loc(row)}")

    if report["folders"]:
        print()
        print("=== Folders (hardcoded UUID) ===")
        for row in report["folders"]:
            print(f"  folder={row['folder_id']}")
            print(f"       {_fmt_loc(row)}")

    if report["custom_operations"]:
        print()
        print("=== Custom / extension operations ===")
        for row in report["custom_operations"]:
            print(f"  type={row['op_type']}")
            print(f"       {_fmt_loc(row)}")

    if report["env_keys"]:
        print()
        print("=== $env keys ===")
        for row in report["env_keys"]:
            print(f"  key={row['key']}")
            print(f"       {_fmt_loc(row)}")

    if report["roles"]:
        print()
        print("=== Roles ===")
        for row in report["roles"]:
            print(f"  value={row['value']}  path={row.get('path')}")
            print(f"       {_fmt_loc(row)}")

    if report["cron"]:
        print()
        print("=== Cron ===")
        for row in report["cron"]:
            print(f"  expr={row['expr']}")
            print(f"       {_fmt_loc(row)}")

    if report["environment_data"]:
        print()
        print("=== environment_data reads ===")
        for row in report["environment_data"]:
            print(f"  key={row['key']}")
            print(f"       {_fmt_loc(row)}")

    if report["request_url_patterns"]:
        print()
        print("=== Request URL patterns (aggregate) ===")
        for row in report["request_url_patterns"]:
            print(f"  {row['refs']:4d}  {row['url']}")

    if report["system_api_paths"]:
        print()
        print("=== System API path hits (request ops) ===")
        for k, n in report["system_api_paths"].items():
            print(f"  {n:4d}  {k}")

    probe = report["dest_probe"]
    if probe["collections_checked"] or probe["folders_checked"]:
        print()
        print("=== Dest probe ===")
        if probe["collections_checked"]:
            miss = probe["missing_collections"]
            print(
                f"  missing collections: {len(miss)}"
                + (f" → {', '.join(miss)}" if miss else " (none)")
            )
        if probe["folders_checked"]:
            miss = probe["missing_folders"]
            print(
                f"  missing folders: {len(miss)}"
                + (f" → {', '.join(miss)}" if miss else " (none)")
            )

    if report["notes"]:
        print()
        print("=== Notes ===")
        for n in report["notes"]:
            print(f"  • {n}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Scan Directus flows snapshot for external deps")
    ap.add_argument(
        "sql",
        nargs="?",
        default=None,
        help="Path to directus_flows_operations.sql (default: ../exports/...)",
    )
    ap.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    ap.add_argument(
        "--collections-file",
        type=Path,
        help="One collection name per line (from dest) to flag missing collections",
    )
    ap.add_argument(
        "--folders-file",
        type=Path,
        help="One folder UUID per line (from dest) to flag missing folders",
    )
    ap.add_argument(
        "--strict",
        action="store_true",
        help="Exit 1 if dest probe reports missing collections/folders",
    )
    args = ap.parse_args()

    if args.sql:
        sql_path = Path(args.sql)
    else:
        sql_path = (
            Path(__file__).resolve().parent.parent
            / "exports"
            / "directus_flows_operations.sql"
        )

    if not sql_path.is_file():
        print(f"ERROR: snapshot SQL not found: {sql_path}", file=sys.stderr)
        return 2

    report = analyze(
        sql_path,
        collections_present=load_lines(args.collections_file),
        folders_present=load_lines(args.folders_file),
    )

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)

    if args.strict:
        probe = report["dest_probe"]
        if probe["missing_collections"] or probe["missing_folders"]:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
