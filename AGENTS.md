# Project-wide agent instructions

This project supports work for a job role. These instructions apply to every agent working in this project, including the primary agent and any delegated agents.

## Language and service conventions

- Use TypeScript for application and service code. Enable `strict` when creating the TypeScript configuration; validate external inputs at runtime and avoid untyped `any` boundaries.
- Follow official Vercel guidance for service architecture, runtime configuration, and persistence. Verify current documentation and product availability before relying on platform-specific features or limits.
- Keep business logic separate from HTTP handlers and infrastructure adapters. Persist durable state outside function memory and local files; design retryable mutations and webhook handling to be idempotent.
- Choose service boundaries based on actual application needs. A single framework can own a simple application; use Vercel Services for independently built components that should deploy together, or separate projects when release cycles must be independent.
- Storage: Neon Postgres with Drizzle ORM and the `pg` driver; local development can use Docker Postgres. HTTP uses Hono on Node.js with an injected OrderService interface; orchestration is a separate layer.
- Use npm and the committed lockfile. Run `npm run check` for TypeScript, storage migration tests, and the build. Generate schema migrations with `npm run db:generate`; apply them explicitly with `npm run db:migrate`, never during application startup or builds.

## Project skills

Official skills from `https://github.com/vercel/vercel-plugin`, installed in `.agents/skills/`:

- `create-a-backend`: use for backend architecture and workload/product selection.
- `vercel-services`: use for service configuration, routing, bindings, and local development.
- `vercel-functions`: use for function runtimes, execution constraints, and server-side performance.
- `vercel-storage`: use for persistence and storage integration choices.

Read the relevant skill's `SKILL.md` before performing that work. These are local snapshots of upstream guidance; consult current official documentation when behavior is version-sensitive. Referenced skills that are not installed should be added only when the task needs them.

## Required running activity log

- Keep `AGENT_LOG.md` in the project root as a shared, chronological, append-only log of agent activity.
- At the start of each task, record the timestamp (with timezone), agent identity, the user's request, and the intended next action.
- Record every meaningful action as work proceeds: inspections, commands and tool calls, file changes, checks and their results, decisions, failures, blockers, and external actions. Closely related read-only actions may be grouped, but do not omit failed attempts.
- Include concise decision summaries, assumptions, and rationale useful to a human reviewing the work. Do not record private internal thoughts, hidden chain-of-thought, secrets, credentials, or unnecessary personal information.
- At completion or handoff, record the outcome, validation performed, and any outstanding work or limitations.
- Identify each entry's author so activity from multiple agents is distinguishable. When delegating, explicitly remind the delegated agent to follow these instructions and update the same log.
- Preserve other agents' entries. Use append operations and coordinate concurrent writes; never replace the log with a stale copy. Correct prior entries with a new dated entry.
- Logging is part of the task, not an optional final report. Log changes themselves do not require recursive log entries.

Suggested entry format:

```markdown
### YYYY-MM-DD HH:MM:SS ±HH:MM — Agent identity — Task or action
- Request / intent:
- Actions and results:
- Decision summary / rationale:
- Validation / next steps:
```
