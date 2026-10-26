# ECC skills (third party)

The `ecc-*` skills come from Everything Claude Code (github.com/affaan-m/ECC), MIT licence
(see `ECC-LICENSE`), copied at commit `25278e7d7b6cf6e6a4e7a6c8e10f14ff22f0eb5b` on 2026-10-26.
Each skill's `name` was prefixed with `ecc-` so none clashes with a built-in or project skill;
the text is otherwise unchanged.

They were reviewed before adding: Markdown only (no scripts or hooks), no fetch-and-run
commands, no instructions to send data anywhere. Treat them as part of the agent's trust
boundary: review any update the same way, and pin a new commit here when refreshing them.

General guidance only. Where one disagrees with `CLAUDE.md` or the `utilityoptamizer-` skill
(for example commit message style, or migrations that would edit history), this repository's
rules win.

Installed: api-design, codebase-onboarding, cost-aware-llm-pipeline, database-migrations,
deployment-patterns, docker-patterns, e2e-testing, energy-procurement, error-handling,
frontend-a11y, git-workflow, github-ops, nestjs-patterns, postgres-patterns, prisma-patterns,
prompt-caching-strategy, react-patterns, redis-patterns, security-review, tdd-workflow,
verification-loop.

Left out on purpose: lead-intelligence (built on scraping personal LinkedIn/X profiles, which
the lead-research rules in `docs/prompts/lead-research-agent.md` forbid), and stack skills this
repo doesn't use (Next.js 16/Turbopack, Express-style backend patterns, Vitest component tests).
