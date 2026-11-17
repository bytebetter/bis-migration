#!/usr/bin/env python3
"""
Scan a committed Directus flows/operations SQL snapshot for external dependencies
beyond the flow/operation graph itself (collections, folders, URLs, custom ops, …).

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
from collections import Counter, defaultdict
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


def analyze(
    sql_path: Path,
    collections_present: set[str] | None = None,
    folders_present: set[str] | None = None,
) -> dict[str, Any]:
    text = sql_path.read_text(encoding="utf-8")
    flows = parse_inserts(text, "directus_flows")
    ops = parse_inserts(text, "directus_operations")
    flow_ids = {f["id"] for f in flows if f.get("id")}
    op_ids = {o["id"] for o in ops if o.get("id")}

    collections: Counter[str] = Counter()
    flow_collections: Counter[str] = Counter()
    op_collections: Counter[str] = Counter()
    op_types: Counter[str] = Counter()
    request_urls: Counter[str] = Counter()
    hardcoded_urls: Counter[str] = Counter()
    env_keys: Counter[str] = Counter()
    folders: Counter[str] = Counter()
    folder_labels: dict[str, set[str]] = defaultdict(set)
    trigger_flows: Counter[str] = Counter()
    cron: Counter[str] = Counter()
    permissions: Counter[str] = Counter()
    user_created: Counter[str] = Counter()
    roles: Counter[str] = Counter()
    system_api_paths: Counter[str] = Counter()
    environment_data_keys: list[str] = []
    custom_ops: list[dict[str, Any]] = []
    external_uuids: Counter[str] = Counter()
    notes: list[str] = []

    for f in flows:
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
            cron[str(opt["cron"])] += 1

    for o in ops:
        t = o.get("type") or "?"
        op_types[t] += 1
        blob = o.get("options") or ""
        name = o.get("name") or o.get("key") or ""

        for m in ENV_RE.finditer(blob):
            env_keys[m.group(1)] += 1

        for m in FOLDER_BODY_RE.finditer(blob):
            fid = m.group(1).lower()
            folders[fid] += 1
            folder_labels[fid].add(str(name))

        # Exec often compares folder UUID without a JSON "folder" key.
        if t == "exec" and "folder" in blob.lower():
            for m in UUID_RE.finditer(blob):
                fid = m.group(0).lower()
                if fid in flow_ids or fid in op_ids:
                    continue
                folders[fid] += 1
                folder_labels[fid].add(str(name))

        for m in HARDCODED_URL_RE.finditer(blob):
            hardcoded_urls[m.group(0)] += 1

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
                    "id": o.get("id"),
                    "type": t,
                    "name": name,
                    "option_keys": sorted(opt.keys()),
                }
            )

        if t == "item-read" and opt.get("collection") == "environment_data":
            environment_data_keys.append(str(opt.get("key")))

        def walk(obj: Any, path: str = "") -> None:
            if isinstance(obj, dict):
                for k, v in obj.items():
                    p = f"{path}.{k}" if path else k
                    lk = k.lower()
                    if lk in ("role", "roles") or lk.endswith("_role"):
                        roles[str(v)] += 1
                    walk(v, p)
            elif isinstance(obj, list):
                for i, v in enumerate(obj):
                    walk(v, f"{path}[{i}]")
            elif isinstance(obj, str):
                for u in UUID_RE.findall(obj):
                    ul = u.lower()
                    if ul in flow_ids or ul in op_ids:
                        continue
                    if ul in folders:
                        continue
                    external_uuids[ul] += 1

        walk(opt)

    # Folders / metadata already categorized — drop from generic UUID bucket.
    for fid in folders:
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
        for fid in sorted(folders):
            if fid not in folders_present:
                missing_folders.append(fid)

    if hardcoded_urls:
        notes.append(
            "At least one request URL is hardcoded (not via environment_data). "
            "Confirm it matches the target environment before apply."
        )
    if custom_ops:
        notes.append(
            "Custom operation types require matching Directus extensions on dest."
        )
    if environment_data_keys:
        notes.append(
            "Flows read collection environment_data (typically url + access_token). "
            "Ensure that row exists on dest with correct values."
        )
    if folders:
        notes.append(
            "Hardcoded directus_folders UUIDs must exist on dest (or file-move steps fail)."
        )
    if not env_keys:
        notes.append("No Directus $env / process.env key references found in options.")

    report = {
        "snapshot": str(sql_path),
        "counts": {
            "flows": len(flows),
            "operations": len(ops),
            "collections_unique": len([c for c in collections if not str(c).startswith("{{")]),
            "request_ops": op_types.get("request", 0),
            "request_url_patterns": len(request_urls),
            "hardcoded_urls": len(hardcoded_urls),
            "folders": len(folders),
            "env_keys": len(env_keys),
            "roles": len(roles),
            "custom_operation_types": len({c["type"] for c in custom_ops}),
            "custom_operation_instances": len(custom_ops),
            "cron_schedules": len(cron),
            "trigger_flow_targets": len(trigger_flows),
            "environment_data_reads": len(environment_data_keys),
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
        "folders": [
            {
                "id": fid,
                "refs": n,
                "labels": sorted(folder_labels.get(fid) or []),
            }
            for fid, n in folders.most_common()
        ],
        "request_urls": [{"url": u, "refs": n} for u, n in request_urls.most_common()],
        "hardcoded_urls": [{"url": u, "refs": n} for u, n in hardcoded_urls.most_common()],
        "env_keys": [{"key": k, "refs": n} for k, n in env_keys.most_common()],
        "roles": [{"value": k, "refs": n} for k, n in roles.most_common()],
        "system_api_paths": dict(system_api_paths.most_common()),
        "custom_operations": custom_ops,
        "cron": [{"expr": e, "refs": n} for e, n in cron.most_common()],
        "permissions": dict(permissions.most_common()),
        "environment_data_keys": environment_data_keys,
        "user_created": [{"id": u, "refs": n} for u, n in user_created.most_common()],
        "external_uuids_other": [
            {"id": u, "refs": n} for u, n in external_uuids.most_common(50)
        ],
        "trigger_flow_targets_internal": sum(
            1 for fid in trigger_flows if fid in flow_ids
        ),
        "trigger_flow_targets_missing": [
            fid for fid in trigger_flows if fid not in flow_ids
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

    # Heuristic: "many" if lots of non-collection infra deps beyond schema tables
    infra = (
        len(folders)
        + len(hardcoded_urls)
        + len(env_keys)
        + len(roles)
        + len({c["type"] for c in custom_ops})
        + (1 if environment_data_keys else 0)
    )
    many = len(collections) > 40 or infra > 15
    report["verdict"]["external_deps_many"] = many
    report["verdict"]["summary_th"] = (
        f"พบ collection อ้างอิง {report['counts']['collections_unique']} รายการ "
        f"(ส่วนใหญ่เป็นตารางแอป), folder UUID {len(folders)}, "
        f"request URL patterns {len(request_urls)} (hardcoded {len(hardcoded_urls)}), "
        f"custom op types {report['counts']['custom_operation_types']}, "
        f"$env keys {len(env_keys)}, roles {len(roles)}. "
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
    print(f"  folders (UUID):           {c['folders']}")
    print(f"  request ops / URL patterns: {c['request_ops']} / {c['request_url_patterns']}")
    print(f"  hardcoded absolute URLs:  {c['hardcoded_urls']}")
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

    if report["folders"]:
        print()
        print("=== Folders (hardcoded UUID) ===")
        for row in report["folders"]:
            labels = "; ".join(row["labels"][:3])
            print(f"  {row['refs']:4d}  {row['id']}  {labels}")

    if report["hardcoded_urls"]:
        print()
        print("=== Hardcoded absolute URLs ===")
        for row in report["hardcoded_urls"]:
            print(f"  {row['refs']:4d}  {row['url']}")

    if report["request_urls"]:
        print()
        print("=== Request URL patterns ===")
        for row in report["request_urls"]:
            print(f"  {row['refs']:4d}  {row['url']}")

    if report["custom_operations"]:
        print()
        print("=== Custom / extension operations ===")
        for row in report["custom_operations"]:
            print(f"  {row['type']}  {row['name']}  ({row['id']})")

    if report["env_keys"]:
        print()
        print("=== $env keys ===")
        for row in report["env_keys"]:
            print(f"  {row['refs']:4d}  {row['key']}")

    if report["roles"]:
        print()
        print("=== Roles ===")
        for row in report["roles"]:
            print(f"  {row['refs']:4d}  {row['value']}")

    if report["cron"]:
        print()
        print("=== Cron ===")
        for row in report["cron"]:
            print(f"  {row['refs']:4d}  {row['expr']}")

    if report["environment_data_keys"]:
        print()
        print("=== environment_data item keys ===")
        for k in report["environment_data_keys"]:
            print(f"  {k}")

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
