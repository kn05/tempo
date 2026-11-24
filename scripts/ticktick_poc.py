#!/usr/bin/env python3
"""
Phase 0 TickTick Open API v1 PoC Verification Script for `tempo`.

Zero external dependencies (Python 3 stdlib only).

Checks performed:
  1. Projects & Tags probe (`GET /open/v1/project`, `GET /open/v1/tag`).
  2. Inbox accessibility probe (`GET /open/v1/project/inbox/data`, etc.).
  3. (Optional `--run-write-test`) Subtask `parentId` creation + 2-step `complete`
     + parent schedule preservation check.

Usage examples:
  # 1) Read-only probe with Personal API Token (TickTick Web -> Settings -> Account -> API Token)
  TICKTICK_TOKEN="..." python3 scripts/ticktick_poc.py

  # 2) Full write PoC (creates a temporary parent + completed subtask in a project)
  TICKTICK_TOKEN="..." python3 scripts/ticktick_poc.py --run-write-test --project-id <PROJECT_ID>

  # 3) Write PoC with automatic cleanup right after verification
  TICKTICK_TOKEN="..." python3 scripts/ticktick_poc.py --run-write-test --cleanup

  # 4) OAuth2 loopback flow (requires TickTick Developer app credentials)
  TICKTICK_CLIENT_ID="..." TICKTICK_CLIENT_SECRET="..." python3 scripts/ticktick_poc.py --oauth

  # 5) Local offline self-test (verifies date formatting and payload builders)
  python3 scripts/ticktick_poc.py --self-test
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import http.server
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any

API_BASE = "https://api.ticktick.com/open/v1"
OAUTH_AUTHORIZE_URL = "https://ticktick.com/oauth/authorize"
OAUTH_TOKEN_URL = "https://ticktick.com/oauth/token"
DEFAULT_CALLBACK_PORT = 18492
TOKEN_CACHE_PATH = Path(".ticktick_poc_token.json")


def load_dotenv(path: Path | None = None) -> None:
    """Minimal stdlib .env loader (does not overwrite existing environment variables)."""
    candidates = [path] if path else [Path(".env"), Path(__file__).resolve().parent.parent / ".env"]
    for candidate in candidates:
        if not candidate or not candidate.is_file():
            continue
        for raw_line in candidate.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            if key and key not in os.environ:
                os.environ[key] = val
        return


def format_ticktick_dt(value: dt.datetime) -> str:
    """Format an aware datetime as `yyyy-MM-dd'T'HH:mm:ss+0000` (UTC)."""
    utc_dt = value.astimezone(dt.timezone.utc)
    return utc_dt.strftime("%Y-%m-%dT%H:%M:%S+0000")


def build_subtask_payload(
    *,
    parent_title: str,
    project_id: str,
    parent_id: str,
    started_at: dt.datetime,
    ended_at: dt.datetime,
    time_zone: str = "UTC",
) -> dict[str, Any]:
    return {
        "title": f"[{parent_title}] 수행",
        "projectId": project_id,
        "parentId": parent_id,
        "content": "Created by tempo Phase 0 PoC",
        "isAllDay": False,
        "startDate": format_ticktick_dt(started_at),
        "dueDate": format_ticktick_dt(ended_at),
        "timeZone": time_zone,
    }


class TickTickHttpClient:
    def __init__(self, token: str, base_url: str = API_BASE) -> None:
        self.token = token
        self.base_url = base_url.rstrip("/")

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> tuple[int, Any]:
        url = f"{self.base_url}{path}"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        data: bytes | None = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read().decode("utf-8", errors="replace").strip()
                parsed = json.loads(raw) if raw else None
                return resp.status, parsed
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", errors="replace").strip()
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = raw
            return err.code, parsed


def obtain_oauth_token(client_id: str, client_secret: str, port: int) -> str:
    redirect_uri = f"http://127.0.0.1:{port}/callback"
    state = secrets.token_urlsafe(16)
    auth_params = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "tasks:read tasks:write",
            "state": state,
        }
    )
    authorize_url = f"{OAUTH_AUTHORIZE_URL}?{auth_params}"

    result: dict[str, str | None] = {"code": None, "state": None, "error": None}

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return
            qs = urllib.parse.parse_qs(parsed.query)
            result["code"] = qs.get("code", [None])[0]
            result["state"] = qs.get("state", [None])[0]
            result["error"] = qs.get("error", [None])[0]

            body = (
                "<html><body><h2>tempo TickTick PoC</h2>"
                "<p>Authorization received. You can close this tab and return to the terminal.</p>"
                "</body></html>"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = http.server.HTTPServer(("127.0.0.1", port), CallbackHandler)
    print(f"\n[OAuth2] Listening on {redirect_uri}")
    print(f"[OAuth2] Open this URL in your browser if it does not open automatically:\n  {authorize_url}\n")
    try:
        webbrowser.open(authorize_url)
    except Exception:
        pass

    while result["code"] is None and result["error"] is None:
        server.handle_request()
    server.server_close()

    if result["error"]:
        raise RuntimeError(f"OAuth2 authorization error: {result['error']}")
    if result["state"] != state:
        raise RuntimeError("OAuth2 state mismatch — aborting.")
    assert result["code"] is not None

    basic = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    form = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": result["code"],
            "redirect_uri": redirect_uri,
            "scope": "tasks:read tasks:write",
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        OAUTH_TOKEN_URL,
        data=form,
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        token_data = json.loads(resp.read().decode("utf-8"))

    access_token = token_data.get("access_token")
    if not access_token:
        raise RuntimeError(f"No access_token in response: {token_data}")

    TOKEN_CACHE_PATH.write_text(json.dumps(token_data, indent=2), encoding="utf-8")
    os.chmod(TOKEN_CACHE_PATH, 0o600)
    print(f"[OAuth2] Access token cached locally at {TOKEN_CACHE_PATH} (gitignored).")
    return str(access_token)


def resolve_token(args: argparse.Namespace) -> str:
    if args.token:
        return args.token
    if os.environ.get("TICKTICK_TOKEN"):
        return os.environ["TICKTICK_TOKEN"]
    if args.oauth:
        client_id = args.client_id or os.environ.get("TICKTICK_CLIENT_ID")
        client_secret = args.client_secret or os.environ.get("TICKTICK_CLIENT_SECRET")
        if not client_id or not client_secret:
            sys.exit(
                "Error: --oauth requires TICKTICK_CLIENT_ID and TICKTICK_CLIENT_SECRET "
                "(or --client-id / --client-secret)."
            )
        return obtain_oauth_token(client_id, client_secret, args.port)
    if TOKEN_CACHE_PATH.exists():
        cached = json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8"))
        if cached.get("access_token"):
            print(f"[Auth] Using cached token from {TOKEN_CACHE_PATH}")
            return str(cached["access_token"])
    sys.exit(
        "Error: No TickTick token provided.\n"
        "Set TICKTICK_TOKEN (Personal API Token from TickTick Web -> Settings -> Account -> API Token)\n"
        "or pass --token <TOKEN>, or run with --oauth."
    )


def run_read_probes(client: TickTickHttpClient) -> list[dict[str, Any]]:
    print("\n=== 1. Projects Probe (GET /open/v1/project) ===")
    status, projects = client.request("GET", "/project")
    print(f"HTTP {status}")
    if status != 200 or not isinstance(projects, list):
        print("Response:", json.dumps(projects, ensure_ascii=False, indent=2))
        return []

    print(f"Found {len(projects)} project(s):")
    for proj in projects[:15]:
        print(
            f"  - id={proj.get('id')}  name={proj.get('name')!r}  "
            f"closed={proj.get('closed')}  color={proj.get('color')}"
        )

    print("\n=== 2. Tags Probe (GET /open/v1/tag) ===")
    tag_status, tag_body = client.request("GET", "/tag")
    if tag_status == 200:
        count = len(tag_body) if isinstance(tag_body, list) else "n/a"
        print(f"HTTP 200 — /open/v1/tag SUPPORTED (count={count})")
    else:
        print(f"HTTP {tag_status} — /open/v1/tag unavailable or restricted: {tag_body}")

    print("\n=== 3. Inbox Probe ===")
    inbox_status, inbox_body = client.request("GET", "/project/inbox/data")
    if inbox_status == 200 and isinstance(inbox_body, dict):
        inbox_tasks = inbox_body.get("tasks", [])
        inbox_proj = inbox_body.get("project") or {}
        print(
            f"HTTP 200 — GET /project/inbox/data SUPPORTED "
            f"(projectId={inbox_proj.get('id')}, undone_tasks={len(inbox_tasks)})"
        )
    else:
        print(f"HTTP {inbox_status} — GET /project/inbox/data did not return Inbox data: {inbox_body}")

    # Also test task filter endpoint (read-only) to see if Inbox tasks appear with inbox projectId
    filter_status, filter_body = client.request("POST", "/task/filter", {})
    if filter_status == 200 and isinstance(filter_body, list):
        inbox_like = [
            t.get("projectId")
            for t in filter_body
            if isinstance(t, dict) and str(t.get("projectId", "")).startswith("inbox")
        ]
        print(
            f"HTTP 200 — POST /task/filter SUPPORTED "
            f"(returned={len(filter_body)}, inbox_project_ids={sorted(set(inbox_like))})"
        )
    else:
        print(f"HTTP {filter_status} — POST /task/filter: {filter_body}")

    # Also test user preference endpoint (documented in openapi.md)
    pref_status, pref_body = client.request("GET", "/preference")
    if pref_status == 200:
        print(f"HTTP 200 — GET /preference: {json.dumps(pref_body, ensure_ascii=False)}")
    else:
        print(f"HTTP {pref_status} — GET /preference not available")

    return projects


def run_write_poc(
    client: TickTickHttpClient,
    project_id: str,
    cleanup: bool,
    time_zone: str,
) -> int:
    print(f"\n=== 4. Subtask (`parentId`) + 2-Step Complete Write PoC (project={project_id}) ===")
    now = dt.datetime.now(dt.timezone.utc)
    planned_start = (now + dt.timedelta(days=1)).replace(hour=5, minute=0, second=0, microsecond=0)
    planned_due = planned_start + dt.timedelta(hours=1)

    parent_title = f"tempo PoC Parent {now.strftime('%H%M%S')}"
    parent_payload = {
        "title": parent_title,
        "projectId": project_id,
        "content": "Temporary parent task created by tempo Phase 0 PoC",
        "isAllDay": False,
        "startDate": format_ticktick_dt(planned_start),
        "dueDate": format_ticktick_dt(planned_due),
        "timeZone": time_zone,
    }
    p_status, parent = client.request("POST", "/task", parent_payload)
    if p_status not in (200, 201) or not isinstance(parent, dict) or not parent.get("id"):
        print(f"[FAIL] Could not create parent task (HTTP {p_status}): {parent}")
        return 1
    parent_id = str(parent["id"])
    print(f"[OK] Created parent task: id={parent_id}, startDate={parent.get('startDate')}, dueDate={parent.get('dueDate')}")

    child_start = now - dt.timedelta(minutes=25)
    child_payload = build_subtask_payload(
        parent_title=parent_title,
        project_id=project_id,
        parent_id=parent_id,
        started_at=child_start,
        ended_at=now,
        time_zone=time_zone,
    )
    c_status, child = client.request("POST", "/task", child_payload)
    if c_status not in (200, 201) or not isinstance(child, dict) or not child.get("id"):
        print(f"[FAIL] Could not create subtask (HTTP {c_status}): {child}")
        return 1
    child_id = str(child["id"])
    returned_parent_id = child.get("parentId")
    print(f"[INFO] Created child task: id={child_id}, returned parentId={returned_parent_id!r}")

    # Re-fetch child to confirm persistence
    fetch_c_status, fetched_child = client.request("GET", f"/project/{project_id}/task/{child_id}")
    persisted_parent_id = fetched_child.get("parentId") if isinstance(fetched_child, dict) else None
    print(f"[INFO] Re-fetched child (HTTP {fetch_c_status}): persisted parentId={persisted_parent_id!r}")

    # Step 2: Complete the child task
    comp_status, comp_body = client.request("POST", f"/project/{project_id}/task/{child_id}/complete")
    print(f"[INFO] Complete child task: HTTP {comp_status} {comp_body or ''}")

    # Re-fetch parent to verify its status and planned schedule were NOT touched
    fetch_p_status, fetched_parent = client.request("GET", f"/project/{project_id}/task/{parent_id}")
    parent_untouched = False
    if fetch_p_status == 200 and isinstance(fetched_parent, dict):
        parent_untouched = (
            fetched_parent.get("status", 0) == 0
            and fetched_parent.get("startDate") == parent.get("startDate")
            and fetched_parent.get("dueDate") == parent.get("dueDate")
        )
        print(
            f"[INFO] Parent re-fetch: status={fetched_parent.get('status')} "
            f"startDate={fetched_parent.get('startDate')} dueDate={fetched_parent.get('dueDate')}"
        )

    parent_id_supported = (returned_parent_id == parent_id) or (persisted_parent_id == parent_id)

    print("\n=== PoC Verdict ===")
    print(f"  parentId preserved : {'PASS' if parent_id_supported else 'FAIL (use Fallback TimeLog list)'}")
    print(f"  2-step complete    : {'PASS' if comp_status in (200, 204) else 'FAIL'}")
    print(f"  Parent untouched   : {'PASS' if parent_untouched else 'CHECK MANUALLY'}")

    if cleanup:
        print("\n[Cleanup] Deleting temporary PoC tasks...")
        for label, tid in (("child", child_id), ("parent", parent_id)):
            d_status, d_body = client.request("DELETE", f"/project/{project_id}/task/{tid}")
            print(f"  DELETE {label} ({tid}): HTTP {d_status} {d_body or ''}")
    else:
        print("\n[Next Step] Open TickTick Calendar Timeline to verify the completed subtask appears visually.")
        print(
            "When finished inspecting, delete the test tasks with:\n"
            f"  TICKTICK_TOKEN=\"...\" python3 scripts/ticktick_poc.py "
            f"--delete-task {project_id}:{child_id} --delete-task {project_id}:{parent_id}"
        )

    return 0 if (parent_id_supported and comp_status in (200, 204)) else 2


def run_self_test() -> int:
    sample_start = dt.datetime(2026, 11, 24, 9, 0, 0, tzinfo=dt.timezone.utc)
    sample_end = dt.datetime(2026, 11, 24, 9, 30, 0, tzinfo=dt.timezone.utc)
    assert format_ticktick_dt(sample_start) == "2026-11-24T09:00:00+0000"
    payload = build_subtask_payload(
        parent_title="Write SPEC",
        project_id="proj-123",
        parent_id="task-456",
        started_at=sample_start,
        ended_at=sample_end,
        time_zone="Asia/Seoul",
    )
    assert payload["title"] == "[Write SPEC] 수행"
    assert payload["projectId"] == "proj-123"
    assert payload["parentId"] == "task-456"
    assert payload["startDate"] == "2026-11-24T09:00:00+0000"
    assert payload["dueDate"] == "2026-11-24T09:30:00+0000"
    assert payload["isAllDay"] is False
    print("[SELF-TEST OK] Date formatting and subtask payload assertions passed.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="tempo Phase 0 TickTick Open API v1 PoC tool")
    parser.add_argument("--token", help="TickTick Bearer access token or Personal API token")
    parser.add_argument("--oauth", action="store_true", help="Authenticate via OAuth2 loopback flow")
    parser.add_argument("--client-id", help="TickTick OAuth2 client_id")
    parser.add_argument("--client-secret", help="TickTick OAuth2 client_secret")
    parser.add_argument("--port", type=int, default=DEFAULT_CALLBACK_PORT, help="Local OAuth2 callback port")
    parser.add_argument("--run-write-test", action="store_true", help="Create temporary parent + completed subtask to verify parentId")
    parser.add_argument("--project-id", help="Target projectId for --run-write-test (defaults to first open project)")
    parser.add_argument("--time-zone", default="Asia/Seoul", help="IANA timezone for PoC tasks (default: Asia/Seoul)")
    parser.add_argument("--cleanup", action="store_true", help="Delete temporary PoC tasks right after testing")
    parser.add_argument(
        "--delete-task",
        action="append",
        default=[],
        metavar="PROJECT_ID:TASK_ID",
        help="Delete specific task(s) left over from a previous PoC run",
    )
    parser.add_argument("--self-test", action="store_true", help="Run offline self-tests without calling TickTick API")
    return parser.parse_args()


def main() -> int:
    load_dotenv()
    args = parse_args()
    if args.self_test:
        return run_self_test()

    token = resolve_token(args)
    client = TickTickHttpClient(token)

    if args.delete_task:
        for spec in args.delete_task:
            if ":" not in spec:
                sys.exit(f"Invalid --delete-task value {spec!r}; expected PROJECT_ID:TASK_ID")
            pid, tid = spec.split(":", 1)
            status, body = client.request("DELETE", f"/project/{pid}/task/{tid}")
            print(f"DELETE {pid}/{tid} -> HTTP {status} {body or ''}")
        return 0

    projects = run_read_probes(client)

    if args.run_write_test:
        target_project = args.project_id
        if not target_project:
            open_projects = [p for p in projects if not p.get("closed")]
            if not open_projects:
                sys.exit("Error: No open project found. Create a list in TickTick or pass --project-id.")
            target_project = str(open_projects[0]["id"])
            print(f"[INFO] Auto-selected first open project: {open_projects[0].get('name')!r} ({target_project})")
        return run_write_poc(client, target_project, args.cleanup, args.time_zone)

    print("\nRead-only probes complete. Pass --run-write-test to verify subtask `parentId` + 2-step completion.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
