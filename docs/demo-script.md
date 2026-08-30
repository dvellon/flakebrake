# Three-minute FlakeBrake demo script

This script uses deterministic judge mode. Start with `npm run m5:ui`, open the
loopback URL, and keep the browser at desktop width. No OpenAI or Daytona
credentials are needed.

## 0:00–0:25 — Problem and impact

**Say:** “Agents can make locally plausible promises that the complete system
cannot keep. FlakeBrake makes promise acceptance a versioned admission decision,
not a model assertion.”

**Show:** The portfolio contains protected, important, and best-effort accepted
orders. Point to human review, agent work, and production-cell capacity.

## 0:25–0:45 — Direct rush failure

**Show:** The `REPLAN` badge and capacity cards. The rush order's direct plan
exceeds simultaneous constraints.

**Say:** “Evaluation is side-effect free. Nothing has been dropped or mutated;
the complete portfolio and exact capacity basis are visible.”

## 0:45–1:05 — TrueForge evidence

Choose **Start hero mission**.

**Show:** The TrueForge root node, three subagents, sandbox execution, four MCP
services, and chronological tool/evidence activity.

**Say:** “TrueForge owns the real session, turns, subagents, sandbox, MCP calls,
and pauses. A bounded local model makes this run credential-free; deterministic
FlakeBrake code remains the authority.”

## 1:05–1:30 — Replan winner and promise acceptance

At the first approval, point to the exact action digest and effect, then choose
**Approve action** for the existing-order modification. Show that the winner
changes a best-effort quantity from 10 to 8 while protected work remains
unchanged.

At the second approval, choose **Approve action** to accept the fresh
capacity-safe promise and issue its exact authorization grant.

**Say:** “Portfolio v2 is durable before readmission. Acceptance and its exact
grant commit atomically; the old v1 `REPLAN` can never be accepted.”

## 1:30–2:05 — Human denial and mechanical denial

At the primary 09:10–09:40 reservation, choose **Deny action**.

**Show:** The denial in the timeline, followed by “Auto-blocked · active
policy.”

**Say:** “The planner tried the same material effect through another MCP adapter.
Typed effect normalization recognized it, so the active denial blocked it
without another owner call or mutation.”

## 2:05–2:30 — Approved alternative and one mutation

Choose **Approve action** for the distinct 09:40–10:10 alternative.

**Show:** The metrics for one acceptance, one attempt, one mutation, and one
receipt.

**Say:** “The grant allowance is fenced and idempotent. Only the approved
alternative can consume it, and only once.”

## 2:30–2:45 — Independent verification

**Show:** “Verified success,” the mutation receipt, independent read-back, and
actual-consumption facts: agent 6 and production 30.

**Say:** “A completed tool response is not success. The factory is read back
independently, actuals are appended, and only then may the root mission finish.”

## 2:45–2:55 — Reconnect proof

Refresh the browser.

**Show:** The same session, terminal projection, metrics, approvals, and
timeline.

**Say:** “Refresh replays durable state. It does not repeat an owner call,
attempt, mutation, or receipt.”

## 2:55–3:00 — Qodo quality evidence

Open the README's **Qodo Code Review Evidence** section.

**Say:** “Merged PRs preserve Qodo's initial findings, focused remediation,
exact-head re-reviews, final human adjudications, and merge commits—including
owner-boundary, atomicity, database, lifecycle, polling, and malformed-request
corrections.”

## Presenter checklist

- Browser contains no filesystem paths, credentials, or private endpoints.
- Exactly four external-owner calls are shown.
- Primary reservation is owner-denied.
- Equivalent alternate is mechanically denied.
- One distinct alternative is owner-approved.
- Acceptance, attempt, mutation, and receipt counts are each one.
- Actual facts are exactly two.
- Terminal verification precedes root completion.
- Refresh changes none of those counts.
- Press `Ctrl+C` after the demo and confirm clean shutdown.

## Optional 1:45 capacity-shock extension

After the hero, choose **Capacity shock · second scenario**. This selection is
optional and does not change the default three-minute flow.

1. Point out that `capacity-plan/v1` was `ADMITTABLE`: agent 10/10, human 3/4,
   and production 96/100.
2. Show the spindle calibration transition to `capacity-plan/v2`, where only
   production capacity changes from 100 to 90. Explain that the exact v1 action
   is rejected because its `capacity_plan_version` is stale; it cannot authorize
   work against the owner-approved current plan.
3. Show the current `REPLAN` at production 96/90. Both single-change candidates
   land at 90/90; existing comparison rules choose best-effort training trays
   10 → 8 over reducing the important planned batch 8 → 6. Protected cold-chain
   work remains unchanged.
4. Approve the replan and fresh promise, deny 09:12–09:36, then approve
   09:36–10:00. Point out the equivalent adapter's mechanical denial.
5. Show exact terminal counts: one acceptance, attempt, mutation, and receipt;
   two actual facts (agent 3 and production 24); independent read-back; and one
   stale-basis rejection.
6. Refresh to show the same capacity-shock session and terminal projection with
   no duplicate effect. Switching back to **Rush order · hero** restores the
   original untouched projection from its separate state.

## Optional 60–90 seconds — Challenge FlakeBrake

After the normal hero story, scroll to **Challenge FlakeBrake** and activate
**Run challenge lab** with the keyboard or pointer.

**Say:** “This is a separate deterministic assurance demonstration. These are
real rejected calls through the canonical stores and public change-control
adapter, each running against its own invocation-owned state.”

**Show:** Six green **Zero unauthorized effects** results. Open one snapshot
disclosure and point out that the complete before/after digests match, then
scan the eight count classes: admissions, grants, attempts, fences, mutations,
receipts, terminal events, and actual facts.

For the positive control, point to **Replayed: yes**, **Original result: same**,
**Original receipt: same**, **Second mutation: none**, and **Duplicate facts:
none**.

**Say:** “Invalid identity, stale basis, attempt conflict, forged receipt, and
alternate representation after denial all fail closed. The one valid replay
returns prior evidence without executing twice."
