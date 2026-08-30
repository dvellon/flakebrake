# Mission Evidence Bundle v2

The optional Mission Evidence Bundle is a read-only, canonical projection of a
completed deterministic mission. It packages the durable facts needed to
inspect the path from admission through independently verified execution. It
does not change M1–M4 admission, authorization, ledger, fencing, mutation, or
verification semantics.

## Envelope and digest

The downloaded document is exact canonical JSON with this envelope:

```json
{
  "canonicalization": "canonical-json/v1",
  "digestAlgorithm": "sha256",
  "payload": {},
  "payloadDigest": "sha256:...",
  "schemaVersion": "flakebrake-mission-evidence-bundle/v2"
}
```

`payloadDigest` is SHA-256 over the UTF-8 bytes of the canonical `payload`
value. It is a digest or commitment and does not attest who produced the
bundle.

## Durable evidence included

The v2 payload contains:

- mission, environment, TrueForge agent/session, complete turn-chain,
  durable-cursor, terminal-turn, and recomputable successor/bridge identities;
- deterministic judge-profile disclosure, all three completed subagent thread
  identities, MCP service identities, native approval events and successor
  decisions, response status/commitments, and path-free local-sandbox proof;
- the accepted authoritative Promise Basis, calibration digest, and versions;
- the original REPLAN admission, selected modification, accepted execution
  admission, and pre-execution recomputation, including their durable addenda;
- promise acceptance, authorization grant, allowance, and claimed ordinal;
- M2 owner decisions and M4 approval bindings with owner-source identity;
- the active denial and mechanically blocked alternate representation;
- the exact attempt, execution fence, and factory-result binding;
- the mutation result and receipt;
- terminal independent read-back and its observed-state digest;
- terminal projection and actual-consumption facts;
- native mutation/read-back/verification/terminal ordering and refresh/replay
  continuity evidence;
- exact relevant counts for admissions, approvals, grants, denials, attempts,
  fences, mutations, receipts, terminal events, actuals, bridge actions, and
  TrueForge turns/events/connectors/threads/sandbox actions.

The payload omits database paths, credentials and secret-shaped fields,
provider/connector manifests and URLs, raw sandbox identifiers, mutable UI
state, process counters, and audit timestamps
such as creation, update, issue, observation, or recording times. Semantic
windows such as schedule start/end and grant validity remain because they are
part of the authorization and effect. M2/factory instance bindings are emitted
only as opaque digest identities so the owner-action commitment can be
independently recomputed without revealing a path.

## Read-only export

`GET /api/evidence` is available only when the durable mission is terminally
verified. The response uses `application/json`, a fixed safe download filename,
the same loopback host/origin controls as the judge UI, and the existing CSP and
security headers. Export opens SQLite with `readOnly: true` plus
`PRAGMA query_only = ON` and never calls a mutating store operation.
Before projecting records, the exporter recomputes the supplied M2 and factory
database instance identities and requires them to match the mission's durable
cross-store binding. It also opens the TrueForge session database read-only and
requires its agent, session, turns, events, threads, connectors, approvals,
responses, and sandbox evidence to match the mission bridge.

## Local verification

Standalone validation:

```bash
npm run evidence:verify -- --bundle /absolute/path/mission-evidence.json
```

Validation against the exact durable projection:

```bash
npm run evidence:verify -- \
  --bundle /absolute/path/mission-evidence.json \
  --data-dir /absolute/path/to/m5-data
```

Explicit database paths are also supported:

```bash
npm run evidence:verify -- \
  --bundle /absolute/path/mission-evidence.json \
  --m2-db /absolute/path/m2.sqlite \
  --factory-db /absolute/path/factory.sqlite \
  --mission-db /absolute/path/mission.sqlite \
  --trueforge-db /absolute/path/trueforge.sqlite
```

Standalone verification rejects invalid schemas, noncanonical bytes, digest
tampering, broken identity linkage, inconsistent counts, mismatched factory
results and receipts, missing owner/mechanical-denial proof, read-back mismatch,
inconsistent terminal/actual facts, or invalid TrueForge provenance and event
ordering. Database-backed verification additionally rebuilds the projection
through four read-only handles and requires byte equality.
