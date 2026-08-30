import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import * as publicApi from "../src/index.js";
import {
  HERO_RESOURCE_KEYS,
  RecoveryDemoCoordinator,
  interruptRecoveryDemonstration,
  recoverRecoveryDemonstration,
  replayCompletedRecoveryDemonstration,
  restartRecoveryDemonstration,
  startRecoveryDemoServer,
  type RecoveryDemoBoundary,
  type RecoveryDemoPaths,
} from "../src/index.js";
import { parseRecoveryDemoCliArguments } from "../src/recovery-demo-cli.js";
import {
  RecoveryDemoFactoryInterruption,
  reachRecoveryDemoFactoryCommitBoundary,
  runWithRecoveryDemoFactoryInterruption,
} from "../src/recovery-demo-seam.js";
import type { SyntheticMutationResult } from "../src/factory-environment.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("deterministic recovery runner", () => {
  for (const boundary of [
    "after_execution_fence_before_factory_mutation",
    "after_factory_commit_before_m2_binding",
  ] as const) {
    test(`converges exactly once from ${boundary}`, () => {
      const { paths } = fixture();
      const interrupted = interruptRecoveryDemonstration(paths, boundary);
      assert.equal(interrupted.fenceStatus, "active");
      assert.equal(interrupted.claimState, "claimed_nonterminal");
      assert.equal(interrupted.counts.fences, 1);
      assert.equal(interrupted.counts.fenceBindings, 0);
      assert.equal(interrupted.counts.terminalEvents, 0);
      assert.equal(interrupted.counts.terminalFailures, 0);
      assert.equal(interrupted.counts.actualConsumptionFacts, 0);
      assert.equal(interrupted.mixedTerminalFailureAndMutation, false);
      assert.equal(
        interrupted.counts.mutations,
        boundary === "after_factory_commit_before_m2_binding" ? 1 : 0,
      );
      assert.equal(interrupted.counts.receipts, interrupted.counts.mutations);

      const restarted = restartRecoveryDemonstration(paths, boundary);
      assert.equal(restarted.durableStateDigest, interrupted.durableStateDigest);

      const recovered = recoverRecoveryDemonstration(paths, boundary);
      assert.deepEqual(recovered.counts, {
        acceptances: 1,
        attempts: 1,
        fences: 1,
        fenceBindings: 1,
        mutations: 1,
        receipts: 1,
        terminalEvents: 1,
        terminalFailures: 0,
        actualConsumptionFacts: 2,
      });
      assert.equal(recovered.claimState, "terminal_verified");
      assert.equal(recovered.fenceStatus, "factory_result_bound");
      assert.equal(recovered.mixedTerminalFailureAndMutation, false);
      assert.deepEqual(
        new Map(recovered.actualConsumption.map((item) => [item.resourceKey, item.value])),
        new Map([
          [HERO_RESOURCE_KEYS.agent, 6],
          [HERO_RESOURCE_KEYS.production, 30],
        ]),
      );

      const replay = replayCompletedRecoveryDemonstration(paths, boundary);
      assert.equal(replay.executorReportedReplay, true);
      assert.equal(replay.verificationReportedReplay, true);
      assert.equal(replay.durableStateUnchanged, true);
      assert.equal(replay.durableStateDigest, recovered.durableStateDigest);
      assert.deepEqual(replay.counts, recovered.counts);
    });
  }
});

describe("internal recovery demonstration seam", () => {
  const target = {
    executionAttemptId: "attempt/recovery-demo-scope-target",
  } as SyntheticMutationResult;
  const ordinary = {
    executionAttemptId: "attempt/ordinary-concurrent-mutation",
  } as SyntheticMutationResult;

  test("is targeted, one-shot, and absent from the public barrel", () => {
    assert.equal(
      Object.hasOwn(publicApi, "runWithRecoveryDemoFactoryInterruption"),
      false,
    );
    assert.doesNotThrow(() => reachRecoveryDemoFactoryCommitBoundary(target));

    runWithRecoveryDemoFactoryInterruption(target.executionAttemptId, () => {
      assert.doesNotThrow(() => reachRecoveryDemoFactoryCommitBoundary(ordinary));
      assert.throws(
        () => reachRecoveryDemoFactoryCommitBoundary(target),
        RecoveryDemoFactoryInterruption,
      );
      assert.doesNotThrow(() => reachRecoveryDemoFactoryCommitBoundary(target));
    });

    assert.doesNotThrow(() => reachRecoveryDemoFactoryCommitBoundary(target));
  });

  test("restores inert state after failure and across later asynchronous work", async () => {
    assert.throws(
      () =>
        runWithRecoveryDemoFactoryInterruption(target.executionAttemptId, () => {
          reachRecoveryDemoFactoryCommitBoundary(target);
        }),
      RecoveryDemoFactoryInterruption,
    );
    assert.doesNotThrow(() => reachRecoveryDemoFactoryCommitBoundary(target));

    let deferred: Promise<void> | null = null;
    runWithRecoveryDemoFactoryInterruption(target.executionAttemptId, () => {
      deferred = waitForImmediate().then(() => {
        reachRecoveryDemoFactoryCommitBoundary(target);
      });
    });
    await deferred;

    await runWithRecoveryDemoFactoryInterruption(
      target.executionAttemptId,
      async () => {
        await waitForImmediate();
        reachRecoveryDemoFactoryCommitBoundary(target);
      },
    );
    assert.doesNotThrow(() => reachRecoveryDemoFactoryCommitBoundary(target));
  });
});

describe("explicit recovery coordinator and loopback server", () => {
  test("exposes distinct interruption, restart, recovery, verification, and replay states", () => {
    const { directory } = fixture();
    const coordinator = new RecoveryDemoCoordinator({
      dataRoot: directory,
      cleanupDataOnClose: false,
    });
    try {
      assert.equal(coordinator.state().mode, "recovery_demonstration");
      assert.equal(coordinator.state().stage, "idle");
      assert.equal(coordinator.interrupt("after_factory_commit_before_m2_binding").stage, "interrupted");
      assert.equal(coordinator.state().runnerClosedAtBoundary, true);
      assert.equal(coordinator.restart().stage, "restarted");
      const verified = coordinator.recover();
      assert.equal(verified.stage, "verified");
      assert.deepEqual(
        verified.timeline.map((item) => item.phase),
        ["setup", "interruption", "restart", "recovery", "verification"],
      );
      const replayed = coordinator.replay();
      assert.equal(replayed.stage, "replayed");
      assert.equal(replayed.completedReplay?.durableStateUnchanged, true);
    } finally {
      coordinator.close();
    }
  });

  test("binds only loopback, applies CSP, and rejects cross-origin mutation", async () => {
    const { directory } = fixture();
    const running = await startRecoveryDemoServer({
      dataRoot: directory,
      port: 0,
      cleanupDataOnClose: false,
    });
    try {
      assert.match(running.url, /^http:\/\/127\.0\.0\.1:/u);
      const page = await fetch(running.url);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/u);
      assert.doesNotMatch(await page.text(), /Start hero mission/u);

      const blocked = await fetch(`${running.url}/api/recovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://example.invalid" },
        body: JSON.stringify({
          operation: "interrupt",
          boundary: "after_execution_fence_before_factory_mutation",
          requestId: "recovery:blocked:0001",
        }),
      });
      assert.equal(blocked.status, 403);

      const result = await post(
        running.url,
        "interrupt",
        "after_execution_fence_before_factory_mutation",
        "recovery:interrupt:0001",
      );
      assert.equal(result.state.stage, "interrupted");
      const replayedRequest = await post(
        running.url,
        "interrupt",
        "after_execution_fence_before_factory_mutation",
        "recovery:interrupt:0001",
      );
      assert.equal(replayedRequest.replayed, true);
      assert.equal(replayedRequest.state.durableBeforeInterruption.counts.mutations, 0);
    } finally {
      await running.close();
    }
  });

  test("uses port 4177 only for the explicit recovery CLI default", () => {
    assert.deepEqual(parseRecoveryDemoCliArguments([]), {
      help: false,
      port: 4177,
      dataRoot: null,
    });
    assert.deepEqual(parseRecoveryDemoCliArguments(["--port", "0"]), {
      help: false,
      port: 0,
      dataRoot: null,
    });
    assert.equal(
      readFileSync(join(process.cwd(), "ui/recovery/index.html"), "utf8").includes(
        "Explicit mode · Recovery demonstration",
      ),
      true,
    );
  });
});

function fixture(): { readonly directory: string; readonly paths: RecoveryDemoPaths } {
  const directory = mkdtempSync(join(tmpdir(), "flakebrake-recovery-test-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    paths: {
      m2DatabasePath: join(directory, "m2.sqlite"),
      factoryDatabasePath: join(directory, "factory.sqlite"),
    },
  };
}

async function post(
  url: string,
  operation: "interrupt" | "restart" | "recover" | "replay" | "reset",
  boundary: RecoveryDemoBoundary | null,
  requestId: string,
): Promise<any> {
  const response = await fetch(`${url}/api/recovery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ operation, boundary, requestId }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}
