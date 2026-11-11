#!/usr/bin/env node
// SessionStart hook: what this prints is added to the session's context.
import * as store from './store.mjs'

const threadId = process.env.T3CODE_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || ''
const mine = threadId ? store.taskForSession(threadId) : null
const open = store.listTasks({ includeSettled: false })

console.log(`# T3 Tasks
The user keeps a to-do list one level above sessions: each task lists the sessions working towards shipping it. You keep it current with the t3-tasks tools (task_list, task_get, task_link, task_create, task_update, task_check, task_add_criteria, task_suggest).

- When real work starts and this session has no task: link it to the open task it serves (task_link). If none matches, do not create one yourself: suggest it (task_suggest) and say so in one line of your reply. Create a task (task_create) only when the user asks you to.
- A task is a ticket: a description and acceptance criteria. Read them (task_get) before you work. Check each criterion off (task_check) only when it is met and verified. done is refused while one is open.
- Keep the status true as you go, with a one-line note (task_update): in_progress when you start, blocked when you wait on the user or something external, done when the work is shipped or verified.
- Never set settled, and never touch a settled task. Settling is the user's call.
- If this session drifts into work that is not part of its task, or you find separable work branching out, call task_suggest and say so in one line of your reply. Do not create that task yourself and do not switch tasks unasked.
- A subagent or delegated child leaves the task list alone.

This session's task: ${mine ? `#${mine.id} "${mine.title}" (${mine.status})` : 'none yet'}
Open tasks: ${open.length ? open.map((t) => `#${t.id} "${t.title}" (${t.status})`).join('; ') : 'none'}`)
