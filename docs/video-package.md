# FlakeBrake — three-minute video package

Companion to [demo-script.md](demo-script.md). This is the recording plan for
the final submission video. **Hard ceiling: 3:00.** Narration target:
**2:40–2:55** spoken; leave the last beats breathing room rather than rushing.

Everything below uses only merged behavior at current main and the exact
labels the UI renders. If a label on screen ever differs from this document,
the screen wins — re-check before upload.

---

## Shot list and narration script

Speak at a calm ~150 wpm. Bracketed times are cue points, not hard cuts.
Bold quotes are the exact on-screen labels to point at or hover.

### 0:00–0:18 · Problem and stakes

**Shot:** Judge UI idle at desktop width. Pan slowly across the capacity
cards and the accepted portfolio. Pill reads **"REPLAN · original basis"**.

**Say:** "Agents are great at plausible plans — and terrible at knowing what
the whole system can still afford. FlakeBrake makes a promise an admission
decision: nothing is accepted unless the complete portfolio can keep it, and
nothing counts as done until it's independently verified."

### 0:18–0:35 · The TrueForge harness and action chain

**Shot:** Hold on the blue **"TrueForge harness"** ribbon:
**"Agent loop owned by the TrueForge server · Deterministic judge profile"**,
**"TrueForge 0.1.4 · SDK 0.1.3"**, **"4 services configured"**,
**"Dynamic · configured"**, approval gate **"Native"**.

**Say:** "This is a real TrueForge harness — session, turns, three subagents,
four MCP services, sandbox, native approval pauses, reconnect. The judge
profile swaps in a local deterministic model, so everything you're about to
see runs credential-free, the same way every time."

### 0:35–0:55 · REPLAN and the Operator Proof Center

**Shot:** Scroll to **"Operator proof center — Safety and impact, from the
record"**. Status pill **"Canonical basis"**. Cards: **"Direct plan / REPLAN"**
("Agent work over by 2 · Owner decisions over by 1"), **"Safe winner /
10 → 8"**. Then click **"Start hero mission"**; the harness state flips to
**"Running"** and MCP becomes **"4/4 services reached"**, subagents
**"3 threads evidenced"**.

**Say:** "The direct rush plan fails the whole-portfolio check — so FlakeBrake
computes the smallest safe replan: one best-effort order, ten down to eight,
protected work untouched. Start the mission and TrueForge does the real work —
all four MCP services reached, three subagent threads in evidence."

### 0:55–1:15 · Exact owner approval (calls 1 and 2)

**Shot:** The panel **"Your decision is required"** with
**"Select Portfolio Modification"** →
**"Modify order/best-effort-display: quantity 10 → 8"**. Open
**"Durable action identity"** to flash the digest. Ribbon shows
**"Paused for human"** and **"TrueForge paused this turn for your decision."**
Click **"Approve action"**. At the second pause (accept the fresh promise),
click **"Approve action"** again.

**Say:** "TrueForge pauses the turn natively. I'm approving exactly what's on
screen — this action, this digest, nothing broader. First the bounded
modification; then the fresh capacity-safe promise, whose acceptance and grant
commit atomically."

### 1:15–1:30 · Owner denial

**Shot:** Third pause: the 09:10–09:40 reservation. Click **"Deny action"**.

**Say:** "The primary time slot conflicts with protected production — so the
owner says no. That denial isn't a chat message; it's a durable, typed
constraint."

### 1:30–1:50 · Mechanical equivalent-action denial

**Shot:** The policy panel appears: **"Owner denied primary interval"** and
**"Auto-blocked · active policy"**. In the Proof Center's
**"Exact control decisions"** drawer, show
**"Mechanically blocked · no owner decision"**.

**Say:** "Now the trick every agent eventually tries: the same effect through
a different tool, submit_schedule_change instead of the reservation call.
Typed effect normalization recognizes it, and the active denial blocks it
mechanically — no extra owner call, no mutation."

### 1:50–2:05 · Safe alternative approval, one mutation

**Shot:** Fourth pause: the distinct 09:40–10:10 alternative. Click
**"Approve action"**. Show the **"Execution ledger"** metrics ticking to one
acceptance, one attempt, one mutation, one receipt.

**Say:** "The nine-forty alternative is a genuinely different effect, so it
earns its own decision. One fenced, idempotent mutation — exactly once."

### 2:05–2:20 · Read-back pending → independently verified

**Shot:** Verification pill **"Read-back pending"**, then the flip to
**"Verified"** / outcome **"Verified success"**; read-back note showing the
verified interval and the two actual facts (agent 6, production 30).

**Say:** "A receipt is not success. FlakeBrake reads the factory back
independently, records actual consumption — six agent work units, thirty cell
minutes — and only then reports verified success."

### 2:20–2:40 · Refresh / reconnect proof

**Shot:** Press F5. Same session ID, outcome **"Verified success"**, ribbon
replay row **"Durable session replayed"**, gate **"Native · 4 owner calls"**.
Counts unchanged.

**Say:** "Refresh. Same session, same four owner calls, still one mutation.
Recovery replays the durable record — it never repeats a human decision or an
effect."

### 2:40–2:52 · Closing value proposition

**Shot:** Slow pull-back to the Proof Center's **"Verified record"** state and
**"What FlakeBrake prevented"**.

**Say:** "Human-governed, mechanically enforced, independently verified — on a
real TrueForge harness. FlakeBrake: an agent you can hold to its word."

**[2:52 — end card / silence to 2:55. Do not exceed 3:00.]**

---

## YouTube metadata

**Title (drop-in):**
FlakeBrake — a human-governed TrueForge agent that proves its promises (3-min demo)

**Description:**

FlakeBrake is obligation admission control for autonomous agents, built on a
genuine TrueForge 0.1.4 harness. In three minutes: a rush order fails the
whole-portfolio check (REPLAN), a bounded replan trims one best-effort order
from 10 to 8, the owner approves the exact modification and the fresh promise,
denies a 09:10–09:40 reservation, an equivalent action through a different MCP
adapter is blocked mechanically by the active denial, the distinct 09:40–10:10
alternative is approved, exactly one fenced mutation executes, the factory is
read back independently, and only then is verified success reported. A browser
refresh replays the durable session without repeating any owner call or
effect.

Deterministic judge profile — no OpenAI or Daytona credentials required.

Repository: https://github.com/dvellon/flakebrake
⟨PAGES URL, once enabled⟩ · ⟨BLOG URL⟩

Chapters:
0:00 The problem: agents that over-promise
0:18 A real TrueForge harness
0:35 REPLAN and the Operator Proof Center
0:55 Exact owner approvals
1:15 Owner denial
1:30 Mechanical equivalent-action denial
1:50 One fenced mutation
2:05 Independent read-back → verified
2:20 Refresh: nothing happens twice
2:40 Why it matters

**Thumbnail copy (pick one):**

- `ONE MUTATION. PROVEN.` (large) + `Built on TrueForge` (small, blue)
- `THE "NO" THAT STICKS` + `4 owner calls · 1 mutation · 0 repeats`
- `REPLAN → APPROVE → DENY → VERIFY` + FB mark

Style: match the site — near-black `#09100c` ground, lime `#c9f45b` headline,
blue `#72c9ff` for the TrueForge line, big mono numerals if used.

---

## Recording-day checklist

- [ ] Fresh clone or clean checkout of main; `npm ci && npm run m5:ui`.
- [ ] Desktop browser window, 1440×900 or larger; 125% zoom only if text
      legibility on the recording demands it.
- [ ] Screen free of personal items: no bookmarks bar, no other tabs, no
      notifications, no filesystem paths, no terminal with private output.
- [ ] The UI shows the documented loopback URL only.
- [ ] Do a full silent rehearsal run first; the mission is deterministic, so
      the second (recorded) run will match it.
- [ ] Verify the four owner calls land ALLOW / ALLOW / DENY / ALLOW.
- [ ] Confirm the counts on screen: 4 owner calls, 1 mechanical block,
      1 mutation, 1 receipt, 2 actual facts.
- [ ] Capture the refresh beat in the same take (it's the proof).
- [ ] Runtime check before upload: **under 3:00**, narration 2:40–2:55.
- [ ] After upload: paste the final URL into the site's video panel
      (see the comment in `docs/index.html`), `docs/submission-form.md`, and
      the YouTube description placeholders above.
