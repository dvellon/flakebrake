# Mission Evidence Bundle v1

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
  "schemaVersion": "flakebrake-mission-evidence-bundle/v1"
}
```

`payloadDigest` is SHA-256 over the UTF-8 bytes of the canonical `payload`
value. It is a digest or commitment and does not attest who produced the
bundle.

## Durable evidence included

The v1 payload contains:

- mission, environment, TrueForge session, terminal-turn identity, and the
  recomputable successor/bridge linkage material behind those identities;
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
- exact relevant counts for admissions, approvals, grants, denials, attempts,
  fences, mutations, receipts, terminal events, actuals, and bridge actions.

The payload omits database paths and instance identities, credentials and
secret-shaped fields, mutable UI state, process counters, and audit timestamps
such as creation, update, issue, observation, or recording times. Semantic
windows such as schedule start/end and grant validity remain because they are
part of the authorization and effect.

## Read-only export

`GET /api/evidence` is available only when the durable mission is terminally
verified. The response uses `application/json`, a fixed safe download filename,
the same loopback host/origin controls as the judge UI, and the existing CSP and
security headers. Export opens SQLite with `readOnly: true` plus
`PRAGMA query_only = ON` and never calls a mutating store operation.
Before projecting records, the exporter recomputes the supplied M2 and factory
database instance identities and requires them to match the mission's durable
cross-store binding. Those path-derived instance identities are validated but
not placed in the portable payload.

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
  --mission-db /absolute/path/mission.sqlite
```

Standalone verification rejects invalid schemas, noncanonical bytes, digest
tampering, broken identity linkage, inconsistent counts, mismatched factory
results and receipts, missing owner/mechanical-denial proof, read-back mismatch,
or inconsistent terminal/actual facts. Database-backed verification additionally
rebuilds the projection through read-only handles and requires byte equality.
