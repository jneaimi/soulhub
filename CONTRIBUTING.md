# Contributing to Soul Hub

Thanks for your interest in contributing to Soul Hub. This guide covers how to set up a development environment, submit changes, and follow project conventions.

## Getting Started

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Create a vault: `mkdir -p ~/vault`
4. Start the dev server: `npm run dev`
5. Open [http://localhost:5173](http://localhost:5173)

See [INSTALL.md](INSTALL.md) for detailed prerequisites.

## Development Workflow

### Branch Naming

```
feat/short-description    # New features
fix/short-description     # Bug fixes
docs/short-description    # Documentation
refactor/short-description # Refactoring
```

### Commit Messages

Use imperative mood, under 72 characters:

```
feat: add webhook trigger for pipelines

- Support POST /api/pipelines/trigger with JSON payload
- Validate webhook secret via timing-safe comparison
- Record triggered runs in history

Co-Authored-By: Your Name <you@example.com>
```

### Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include a summary of what changed and why
- Add a test plan (how to verify the change works)
- Screenshots for UI changes

## Project Structure

```
src/
├── routes/              # SvelteKit pages + API endpoints
│   ├── +page.svelte     # Home page
│   ├── api/             # All API routes
│   ├── pipelines/       # Pipeline UI
│   ├── vault/           # Vault UI
│   └── project/[name]/  # Project detail page
├── lib/
│   ├── pipeline/        # Pipeline engine (parser, runner, scheduler)
│   ├── vault/           # Vault engine (indexer, search, graph, governance)
│   ├── pty/             # Terminal sessions (node-pty)
│   ├── components/      # Shared Svelte components
│   └── config.ts        # App configuration
pipelines/
├── _builder/            # Builder system (templates, components)
└── <user-pipelines>/    # User-created pipelines
catalog/                 # Shared blocks and agents
```

## Conventions

### Frontend

- **Svelte 5** with runes (`$state`, `$derived`, `$effect`, `$props`)
- **Tailwind CSS v4** with `hub-*` custom theme colors
- Immutable state updates (no `array.push()` — use spread)
- Centered column layout (`max-w-3xl`) for page content

### Backend

- SvelteKit API routes with proper error responses (`json({ error }, { status })`)
- Use `execFile` (not `exec`) for shell commands — prevents injection
- Validate paths against `ALLOWED_ROOTS` before file access
- Non-blocking vault writes — pipeline/session capture must never break the primary operation

### Pipelines

- Pipeline blocks follow the I/O contract in `pipelines/_builder/CONTRACTS.md`
- Python scripts use PEP 723 inline deps with `uv run`
- All outputs go to `output/` inside the pipeline directory
- Vault auto-captures outputs — no manual vault writes needed for standard output

## Adding a New API Endpoint

1. Create `src/routes/api/your-endpoint/+server.ts`
2. Export `GET`, `POST`, etc. as `RequestHandler`
3. Validate inputs, return `json()` responses
4. Add path security checks if accessing the filesystem

## Adding a New Page

1. Create `src/routes/your-page/+page.svelte`
2. Follow the centered column pattern (`max-w-3xl mx-auto`)
3. Include the logo in the header: `<img src="/logo.png" alt="Soul Hub" class="w-6 h-6" />`
4. Use `hub-*` theme colors (bg-hub-bg, text-hub-text, etc.)

## Adding a Pipeline Block

1. Copy from `pipelines/_builder/templates/script-block/` or `agent-block/`
2. Fill in BLOCK.md manifest (name, type, inputs, outputs)
3. Implement `run.py` following the I/O contract
4. Test with a pipeline that uses the block

## Code Style

- No unnecessary comments on unchanged code
- No speculative abstractions — build what's needed
- Prefer editing existing files over creating new ones
- Keep error handling at system boundaries, not internal code

## Install Completeness Checklist (ADR-020)

Every PR that introduces **persistent infrastructure** — anything outside the running process, including a directory, a script, a scheduled job, a runtime file invariant, or a config field — must tick the items below before being merged. The checklist exists because ADR-019 shipped real infrastructure (a vault git repo, a daily backup script, a scheduler task) without wiring any of it into the install path. A new machine running `npm run setup` would silently get zero version history. ADR-020 is the retroactive fix and this checklist is the discipline that prevents the same class of bug for future ADRs.

| Check | Required if your PR introduces… |
|------|--------------------------------|
| Script lives in `scripts/` (not `~/.claude/scripts/` or any other out-of-repo location) | a new shell / node / python script |
| Bootstrap step added to `scripts/bootstrap.sh` | a new directory, file, or system-state assumption |
| Seed added to `settings.example.json` | a new scheduler task, channel, route, or default config field |
| Check added to `scripts/doctor.mjs` | a new runtime invariant (file exists, repo is git-tracked, env var present) |
| Step documented in the "What `npm run setup` Does" section of `INSTALL.md` | any user-visible install change |
| Re-running `bash scripts/bootstrap.sh` against an existing install is a no-op | every bootstrap step (idempotency is non-negotiable) |

For ADRs filed in the vault (`~/vault/projects/soul-hub-whatsapp/adr-NNN-*.md`), the checklist is a precondition for `status: shipped`.

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- OS and Node.js version

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
