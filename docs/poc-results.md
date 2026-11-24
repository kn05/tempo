# Phase 0 TickTick Open API v1 PoC Results

- **Verified Date:** 2026-11-24
- **Auth Method Tested:** Personal API Token (`TICKTICK_TOKEN` via Bearer header)
- **Tool:** [`scripts/ticktick_poc.py`](../scripts/ticktick_poc.py)

## Verification Summary

| Check | Endpoint | Result | Notes |
| --- | --- | --- | --- |
| List projects | `GET /open/v1/project` | **PASS (HTTP 200)** | Returns user lists (`id`, `name`, `color`, `sortOrder`, `viewMode`, `kind`). Optional fields like `closed` and `color` are omitted when unset. |
| List tags | `GET /open/v1/tag` | **PASS (HTTP 200)** | Returns user tags (`name`, `label`, `sortOrder`, `type`). Can cache TickTick tags directly without scanning tasks. |
| Inbox access | `GET /open/v1/project/inbox/data` | **PASS (HTTP 200)** | Returns `{"tasks": [...], "columns": [...]}` without a `project` object. |
| Task filter | `POST /open/v1/task/filter` | **PASS (HTTP 200)** | Returns up to 200 tasks including `parentId`, `status`, `completedTime`, `modifiedTime`, `createdTime`, `etag`. |
| User preference | `GET /open/v1/preference` | **HTTP 405** | Not supported via `GET`; rely on system local IANA timezone instead. |
| Subtask (`parentId`) creation | `POST /open/v1/task` | **PASS (HTTP 200)** | `parentId` is accepted on creation and persisted on `GET /open/v1/project/{pid}/task/{tid}`. |
| 2-Step completion | `POST /open/v1/project/{pid}/task/{tid}/complete` | **PASS (HTTP 200)** | Completes the newly created subtask cleanly. |
| Parent schedule untouched | `GET /open/v1/project/{pid}/task/{parentId}` | **PASS** | Parent `status` remains `0` and original `startDate`/`dueDate` remain completely unchanged. |
| Task cleanup | `DELETE /open/v1/project/{pid}/task/{tid}` | **PASS (HTTP 200)** | Temporary PoC tasks deleted cleanly. |

## Architecture Decisions Confirmed

1. **Primary Sync Strategy = Subtask (`parentId`) Mode:**
   TickTick Open API v1 natively preserves `parentId` on `POST /open/v1/task` and supports 2-step completion without modifying the parent task's planned schedule. The `TimeLog` list fallback mode remains as an optional setting/fallback rather than a mandatory workaround.
2. **Direct Tag & Inbox Caching:**
   - Pull projects via `GET /open/v1/project` + synthetic local `inbox` project row synced via `GET /open/v1/project/inbox/data`.
   - Pull TickTick tags directly via `GET /open/v1/tag` (preserving `label` for display and `name` as normalized key).
3. **Timestamp Format:**
   Requests accept `yyyy-MM-dd'T'HH:mm:ss+0000`; responses return millisecond precision (`yyyy-MM-dd'T'HH:mm:ss.000+0000`).
4. **Timezone Handling:**
   Since `GET /open/v1/preference` returned HTTP 405, `tempo` should supply the local OS IANA timezone (e.g. `Asia/Seoul`) or a user-configured setting when creating tasks.
