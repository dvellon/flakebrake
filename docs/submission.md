# FlakeBrake submission write-up

## Title

FlakeBrake — obligation admission control for autonomous agents

## One-line description

FlakeBrake prevents an agent from accepting a promise until the complete,
versioned portfolio can keep it—and proves the one approved effect happened
before reporting success.

## The problem

Autonomous agents often reason about the next task in isolation. In real
operations, a new promise competes with accepted obligations for human review,
agent work, time, and physical capacity. A fluent plan is not proof that the
portfolio remains feasible, that the owner authorized the exact effect, or that
execution produced the expected state.

## The solution

FlakeBrake combines a deterministic admission kernel, immutable SQLite ledger,
typed authorization and denial semantics, exact-once synthetic execution,
independent read-back, and a TrueForge-orchestrated mission. Its judge UI makes
the causal chain visible: direct overload, bounded replan, explicit owner
choices, denial-resistant alternate handling, one mutation and receipt, actual
consumption, and terminal verification.

## Three-minute experience

A rush microfactory order first returns `REPLAN`. FlakeBrake compares complete
candidate portfolios and recommends changing a best-effort order from quantity
10 to 8 while preserving protected work. The owner approves the modification
and fresh promise, denies a 09:10–09:40 reservation, sees an equivalent alternate
adapter blocked mechanically, and approves the distinct 09:40–10:10 option.
Exactly one synthetic mutation occurs. Independent read-back and actuals 6/30
are recorded before TrueForge reports verified completion. Refresh proves
durable replay without repeated approvals or effects.

## How TrueForge is used

TrueForge 0.1.4 supplies the root-agent loop, three visible subagents, sandboxed
assurance work, four MCP connectors, approval pauses, persisted sessions and
turns, and reconnect/restart behavior. The default demo uses those real local
interfaces with a deterministic provider and requires no credentials. Optional
OpenAI and Daytona execution uses an external M0 configuration.

## Safety and engineering highlights

- Complete versioned Promise Basis for every admission.
- Atomic promise acceptance and grant issuance.
- Typed effect equivalence across renamed actions and alternate adapters.
- Durable denials, shared allowance fencing, and exact-once attempts.
- Database-incarnation binding and verified-handle operations.
- One controlled synthetic mutation followed by independent read-back.
- Loopback-only UI with strict request validation, stale-response rejection,
  bounded shutdown, and durable reconnect projection.
- Public Qodo review trails across the M4, concurrency-hotfix, and M5 PRs.

## Technology

TypeScript, Node.js 22, SQLite, TrueForge 0.1.4, TrueForge SDK 0.1.3, Model
Context Protocol Streamable HTTP/stdio, Selenium WebDriver, and a framework-free
accessible browser UI.

## Try it

```bash
npm ci
npm run m5:ui
```

Open `http://127.0.0.1:4173`. No OpenAI or Daytona credentials are required.

## Evidence and links

- Repository guide and review evidence: [README](../README.md)
- Architecture: [architecture.md](architecture.md)
- Timed demo: [demo-script.md](demo-script.md)
- Normative scope: [PRODUCT_SPEC_v0.1.md](PRODUCT_SPEC_v0.1.md)
- M4 review: [PR #5](https://github.com/dvellon/flakebrake/pull/5)
- SQLite concurrency review: [PR #6](https://github.com/dvellon/flakebrake/pull/6)
- Judge UI review: [PR #7](https://github.com/dvellon/flakebrake/pull/7)

## AI-assistance disclosure

OpenAI Codex assisted with implementation, tests, documentation, and review
orchestration. The human owner defined and froze the product and safety
requirements, evaluated evidence, and authorized merges. The GitHub Qodo
application independently reviewed PRs; findings were addressed with focused
regressions before separate human adjudication.

## License

MIT, copyright © 2026 dvellon. Dependencies retain their own licenses.
