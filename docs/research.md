# Research notes

Collected 2026-11-24 as input for the spec. Facts only; decisions belong in the spec.

## TickTick Open API (v1)

Source: <https://developer.ticktick.com/docs/openapi.md>, read in full.

### Auth

- Personal API token: web app, Settings, Account, API Token. Sent as a Bearer token. Scope
  and expiry not documented.
- OAuth2 authorization code flow. Authorize at `https://ticktick.com/oauth/authorize`, token
  at `POST https://ticktick.com/oauth/token` (client credentials in Basic auth). Scopes
  `tasks:read`, `tasks:write`. Token lifetime and refresh tokens are not documented.
- Revoke: `POST /oauth/revoke`.

### Endpoints relevant to Tempo

All under `https://api.ticktick.com/open/v1/`.

- Projects: list, get, get with undone tasks and columns, create, update, delete. Project
  groups and columns also exist.
- Tasks: get, create, update (POST), delete, complete, batch create or update (50 each),
  move, filter (max 200), search by keyword, list completed in a range (max 200), list undone
  in a range (max 14 days).
- Focus records: get one, list in a range (capped at 30 days), create, delete. No update.
  `type` 0 is Pomodoro, 1 is Timing. Create takes `taskId`, `note`, `startTime`, `endTime`,
  `pauseDuration`, `duration`, `relationType`.
- Tags: list and create only. No rename or delete.
- Habits: list, get, create, update, sections, check-in create or update, list check-ins.
- Preference: returns the user's time zone.
- Task comments: list, add, delete.

### Task fields

`id`, `projectId`, `title`, `content`, `desc`, `startDate`, `dueDate`, `timeZone`,
`isAllDay`, `status` (-1 abandoned, 0 normal, 2 completed), `completedTime`, `priority`
(0, 1, 3, 5), `tags` (names), `items` (checklist), `reminders`, `repeatFlag` (RRULE),
`sortOrder`, `kind`, `parentId`, `focusSummaries`. `etag` appears in responses but is not in
the field table. No documented modified time.

### Constraints

- No webhooks or change feed; changes must be polled.
- No documented rate limits.
- Dates use `yyyy-MM-dd'T'HH:mm:ssZ`.
- A third-party client reports that the Inbox is not exposed as a project in v1. Not
  verified against the official doc.
- dida365.com (China region) is not mentioned.
