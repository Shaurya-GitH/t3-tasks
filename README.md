# T3 Tasks

A to-do list for [T3 Code](https://github.com/pingdotgg/t3code). Tasks sit one level above sessions: each task is a ticket with a description, acceptance criteria and the sessions working towards shipping it. The agents keep it current; you settle.

This repository is the task service and the agent side. The board itself is native in T3 Code, in the `tasks` branch of the fork [Shaurya-GitH/t3code](https://github.com/Shaurya-GitH/t3code/tree/tasks) (T3 Code has no plugin API for its own UI).

## How it works

```
T3 Code session ──(MCP tools, stdio)─────┐
                                         ├── src/store.mjs ── ~/.t3-tasks/tasks.db (SQLite)
T3 Code Tasks board / other apps ─(HTTP)─┘
```

- **Agents** get the `task_*` tools and, at session start, the rules and the open tasks. They link their session to a task, read the ticket, check acceptance criteria off as they verify them, move the status (`todo`, `in_progress`, `blocked`, `staging`, `done`) and leave a one-line note.
- **Acceptance criteria gate done.** An agent cannot set `done` while a criterion is open, and cannot reword or remove criteria.
- **Only you settle.** An agent cannot set `settled` and cannot change a settled task. Both rules are enforced in the store, not left to the prompt.
- **You create tasks.** An agent never creates a task on its own. When work has no task, or a session branches into separate work, the agent asks in the chat whether to create one, and creates it only after you say yes.

## Install

Needs Node 22.13 or newer. No dependencies.

```sh
git clone https://github.com/Shaurya-GitH/t3-tasks ~/dev/t3-tasks
claude plugin marketplace add ~/dev/t3-tasks
claude plugin install t3-tasks@t3-tasks
```

New sessions pick it up. The service starts with the first session; `npm start` starts it by hand.

### Upgrade to 0.3.0

Apply the update in this order:

1. Install the T3 Code app release with the Staging column.
2. Update `~/dev/t3-tasks` to 0.3.0.
3. Stop the existing T3 Tasks HTTP service on port 4777 through the terminal or process manager that started it. Start it again from the updated checkout with `cd ~/dev/t3-tasks && npm start`.
4. Update the installed Claude plugin to 0.3.0 and start a new session.

Updating the plugin does not restart the HTTP service. A new session leaves an existing service running when its health check succeeds. The 0.2.0 service rejects moves to `staging`.

## Connect another app

Everything the board does goes through the HTTP API on `127.0.0.1:4777`, so a sync script for ClickUp, Linear, GitHub Issues and so on needs nothing else.

| Call | Does |
| --- | --- |
| `GET /api/tasks` | All tasks (with sessions, criteria and history) |
| `POST /api/tasks` `{title, notes?, status?, acceptance_criteria?, source?, external_id?}` | Create a task. With `source` + `external_id` it is an upsert: sending the same item again updates it |
| `PATCH /api/tasks/:id` `{title?, notes?, status?, status_note?, position?}` | Change a task |
| `POST /api/tasks/:id/criteria` `{text}` · `PATCH /api/criteria/:id` `{text?, done?}` · `DELETE /api/criteria/:id` | Acceptance criteria |
| `DELETE /api/sessions/:thread_id` | Unlink a session from its task |
| `DELETE /api/tasks/:id` | Delete a task |

```sh
curl -X POST 127.0.0.1:4777/api/tasks -H 'content-type: application/json' \
  -d '{"title":"Fix checkout bug","source":"clickup","external_id":"86abc"}'
```

The API listens on loopback only. Browser pages may call it only from the T3 Code desktop app or an origin listed in `T3_TASKS_ORIGINS`. It has no token: add one before you expose it beyond this machine.

## Settings

`T3_TASKS_PORT` (default 4777; the board in the fork expects 4777), `T3_TASKS_HOME` (default `~/.t3-tasks`), `T3_TASKS_ORIGINS` (extra page origins allowed to call the API, comma separated).

## Test

```sh
npm test
```
