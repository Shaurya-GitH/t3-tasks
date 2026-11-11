# T3 Tasks

A to-do list for [T3 Code](https://github.com/pingdotgg/t3code). Tasks sit one level above sessions: each task lists the sessions working towards shipping it. The agents keep the list current; you settle.

T3 Code has no plugin API for its own UI, so this is a companion, not a fork: a Claude Code plugin (which T3 Code sessions load) plus a small local page you keep open in T3 Code's preview panel.

## How it works

```
T3 Code session ──(MCP tools, stdio)──┐
                                      ├── src/store.mjs ── ~/.t3-tasks/tasks.db (SQLite)
Task page / other apps ──(HTTP API)───┘
```

- **Agents** get five tools (`task_list`, `task_link`, `task_create`, `task_update`, `task_suggest`) and, at session start, the rules and the open tasks. They link their session to a task, move its status (`todo`, `in_progress`, `blocked`, `done`) and leave a one-line note.
- **Only you settle.** An agent cannot set `settled` and cannot change a settled task. This is enforced in the store, not left to the prompt.
- **Suggestions.** When a session drifts from its task or finds work that branches out, the agent calls `task_suggest`. It shows at the top of the page with Add / Dismiss.
- **The page** is at <http://127.0.0.1:4777>. Open it in T3 Code's preview panel. It refreshes every 3 seconds. Session chips link to the thread.

## Install

Needs Node 22.13 or newer. No dependencies.

```sh
git clone https://github.com/Shaurya-GitH/t3-tasks ~/dev/t3-tasks
claude plugin marketplace add ~/dev/t3-tasks
claude plugin install t3-tasks@t3-tasks
```

New sessions pick it up. The page server starts with the first session; `npm start` starts it by hand.

## Connect another app

Everything the page does goes through the HTTP API on `127.0.0.1:4777`, so a sync script for ClickUp, Linear, GitHub Issues and so on needs nothing else.

| Call | Does |
| --- | --- |
| `GET /api/tasks` | All tasks (with sessions) and open suggestions |
| `POST /api/tasks` `{title, notes?, source?, external_id?}` | Create a task. With `source` + `external_id` it is an upsert: sending the same item again updates it |
| `PATCH /api/tasks/:id` `{title?, notes?, status?, status_note?}` | Change a task |
| `DELETE /api/tasks/:id` | Delete a task |
| `POST /api/suggestions/:id/accept` · `DELETE /api/suggestions/:id` | Accept or dismiss a suggestion |

```sh
curl -X POST 127.0.0.1:4777/api/tasks -H 'content-type: application/json' \
  -d '{"title":"Fix checkout bug","source":"clickup","external_id":"86abc"}'
```

The API listens on loopback only and refuses requests from other websites. It has no token: add one before you expose it beyond this machine.

## Settings

`T3_TASKS_PORT` (default 4777), `T3_TASKS_HOME` (default `~/.t3-tasks`).

## Test

```sh
npm test
```
