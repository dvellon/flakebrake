# FlakeBrake — submission-form answers (copy-paste ready)

Polished answers for the competition submission form. Each narrative field has a
**Default** (concise, recommended) and a **Reserve** (slightly longer, if the
form allows more room). Replace the `⟨…⟩` tokens before submitting. Do not add
personal email addresses or credentials anywhere on the form.

---

## Project name

FlakeBrake

## Tagline / one-liner

A commitment firewall for humans and agents — a human-governed TrueForge agent
that proves the one promise it keeps.

---

## What does your project do?

**Default**

FlakeBrake is a commitment firewall for humans and agents: it sits behind the
consequential MCP boundaries and checks capacity, authorization, denied-effect
equivalence, execution identity, factory results, and replay before another
agent or a human relies on the consequential outcome. Specialists recommend;
before a recommendation can become a consequential effect, the root's
change-control call and FlakeBrake's stores independently re-evaluate the
exact action against current authoritative state. A rush order
hits a synthetic microfactory whose protected, important, and best-effort work
already consumes finite human-review, agent-work, and production-cell capacity.
Instead of letting the agent say yes, FlakeBrake evaluates the complete
versioned portfolio, returns REPLAN, and proposes the smallest safe change
(one best-effort order, quantity 10 → 8, protected work untouched). The owner
approves the exact modification and the fresh promise, denies a 09:10–09:40
reservation, watches the equivalent action arrive through a different MCP
adapter and get blocked mechanically by the active denial, and approves the
distinct 09:40–10:10 alternative. Exactly one fenced mutation executes, one
receipt is stored, the factory is read back independently, actual consumption
is recorded, and only then does the mission report verified success. Refreshing
the browser replays durable state without repeating any owner call or effect.

**Reserve**

FlakeBrake is a commitment firewall for humans and agents: it makes promise
acceptance an admission decision instead of a model assertion, and it will not
let an unsupported, stale, conflicting, duplicated, or unverified consequential
claim cross an MCP boundary. A deterministic kernel evaluates every new commitment against the
complete, versioned obligation portfolio and declared multi-resource capacity;
an immutable SQLite ledger records admissions, owner decisions, typed denials,
grants, fenced attempts, receipts, and actual-consumption facts. In the
three-minute hero demo, a rush order is infeasible as proposed (REPLAN), a
bounded replan trims one best-effort order from quantity 10 to 8 while
protected work stays untouchable, and the owner makes exactly four decisions:
approve the modification, accept the fresh capacity-safe promise, deny the
primary 09:10–09:40 reservation, and approve the distinct 09:40–10:10
alternative. In between, the planner deliberately retries the denied effect
through a different tool adapter — and typed effect normalization blocks it
mechanically, with no extra owner call and no mutation. Execution is
exactly-once: one allowance claim, one fenced attempt, one synthetic mutation,
one receipt. Success is only reported after an independent factory read-back
and terminal verification, and a browser refresh replays the durable record
without duplicating a single decision or effect. An Operator Proof Center
presents the whole causal chain — direct plan, safe winner, owner boundary,
durable outcome — straight from the record.

## How did you use TrueForge?

**Default**

The mission runs inside the pinned TrueForge 0.1.4 server through the 0.1.3
SDK. TrueForge owns the durable session and turn graph, the root
obligation-commander agent, three dynamic subagents (portfolio, capacity, and
assurance roles), four Streamable HTTP MCP connectors, sandbox execution for
the assurance subagent's generated analysis code, native approval pauses on
the four consequential change-control tools, and reconnect/replay after
refresh or restart. The credential-free judge profile registers a bounded
local deterministic model provider with the real TrueForge server, so judges
exercise genuine sessions, turns, subagents, MCP calls, sandbox runs, approval
events, and reconnect behavior with zero credentials. The judge UI surfaces
the harness live: 4/4 services reached, 3 subagent threads evidenced, native
approval gate with 4 owner calls, and durable session replay.

**Reserve**

TrueForge is the orchestration substrate, not a wrapper: every load-bearing
element of the demo is a TrueForge primitive exercised through its public
interfaces. The root agent (`flakebrake-root-obligation-commander`) is the only
role that talks to the owner; it spawns exactly three dynamic subagents —
portfolio and order analyst, capacity and schedule analyst, and assurance and
simulation engineer — which investigate through four MCP services
(factory-orders, factory-capacity, factory-simulator, factory-change-control).
The assurance subagent runs generated analysis code in a TrueForge sandbox
(downloads disabled) and recomputes demand, ranking, and protected-order
preservation through MCP clients; generated code is never allowed to make
owner decisions or perform consequential mutations. All four consequential
change-control tools are approval-gated, so TrueForge natively pauses the turn
for each human decision. Mission, session, turn graph, approvals, tool
results, and terminal projection are durable; refresh and restart reconnect to
the same session and replay it rather than re-running it. The deterministic
judge profile swaps only the model provider for a bounded local endpoint so
the whole thing runs credential-free and reproducibly; separately, the repo
carries credential-gated tests that exercise an OpenAI model provider and a
Daytona sandbox provider through the same boundaries.

## How did you use Qodo?

**Default**

Every implementation PR was reviewed by the GitHub Qodo application, then
remediated with focused regression tests, re-reviewed at the exact head, and
merged only after separate human adjudication. Qodo's findings materially
improved the safety core: a High/Security live-owner bypass path and a
High/Correctness non-atomic acceptance/grant commit on the M4 PR, a
test-reliability gap where a SQLite contention test reported readiness before
contention was proven, and monotonic-polling, durable failed-mission recovery,
and malformed-request containment on the judge-UI PR. The full public trail —
initial findings, remediation rounds, exact-head completions, and final human
adjudications — is linked from the README's "Qodo Code Review Evidence"
section (PRs #5, #6, #7, with earlier and later rounds in #2–#4, #8, #9, #14).

**Reserve**

Qodo ran on every implementation PR as an independent reviewer, and the
workflow that emerged was: initial Qodo review → a focused regression test per
finding → fix → re-review at the exact head → separate human adjudication →
merge. Its highest-value findings sat in the seams between components:
on PR #5 (M4 TrueForge orchestration) it flagged a High/Security live-owner
bypass, a High/Correctness non-atomic acceptance/grant transaction, and a
High/Reliability rollback that could overwrite concurrent writes; on PR #6 it
caught the SQLite contention test reporting readiness before contention was
actually established — a test that would otherwise have passed vacuously; on
PR #7 (judge UI) it drove monotonic request handling, durable failed-mission
recovery, and malformed-target containment. Each finding's remediation landed
with its own regression test before re-review. The complete public audit trail
is preserved in the merged PRs and linked from the README; it is presented as
evidence of the review process, not as a substitute for testing or human
approval.

---

## Form fields

| Field | Value |
| --- | --- |
| Team name | `⟨TEAM NAME⟩` — if submitting alone, enter `SOLO` (or your handle) per the form's guidance |
| GitHub URL | `https://github.com/dvellon/flakebrake` |
| Deployed URL (optional) | `⟨PAGES URL — e.g. https://dvellon.github.io/flakebrake/ once Pages is enabled⟩` |
| YouTube URL (required) | https://www.youtube.com/watch?v=E00_3udo804 |
| Blog URL (optional) | `⟨PAGES URL⟩/blog.html` (or the GitHub blob URL for `docs/blog.html`) |

## Tracks — select all four

- [x] Best Use of TrueForge
- [x] Best Code Quality
- [x] Best UI
- [x] Best Blog Post

## Pre-submit checklist

- [ ] Replace every `⟨…⟩` token above.
- [ ] Confirm the YouTube video is public/unlisted and under three minutes.
- [ ] Confirm the repository is visible to judges before the deadline.
- [ ] No personal email addresses, credentials, or private paths in any field.
