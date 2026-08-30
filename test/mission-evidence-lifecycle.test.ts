import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

import {
  EvidenceHandleOwnership,
  evidenceCleanupErrors,
  withEvidenceHandleOwnership,
  type EvidenceHandleRequest,
  type EvidenceHandleScope,
  type EvidenceOwnedHandle,
} from "../src/mission-evidence-lifecycle.js";

const FOUR_DATABASES = [
  { key: "m2", path: "/redacted/m2", label: "M2" },
  { key: "mission", path: "/redacted/mission", label: "mission" },
  { key: "factory", path: "/redacted/factory", label: "factory" },
  { key: "trueforge", path: "/redacted/trueforge", label: "TrueForge" },
] as const satisfies readonly EvidenceHandleRequest[];

class CountingHandle implements EvidenceOwnedHandle {
  closeAttempts = 0;
  successfulCloses = 0;
  failuresRemaining: number;

  constructor(
    readonly key: string,
    private readonly ledger: CountingFactory,
    closeFailures: number,
  ) {
    this.failuresRemaining = closeFailures;
  }

  close(): void {
    this.closeAttempts += 1;
    this.ledger.closeOrder.push(this.key);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error(`injected close failure for ${this.key}`);
    }
    if (this.successfulCloses !== 0) {
      throw new Error(`handle ${this.key} was closed successfully more than once`);
    }
    this.successfulCloses += 1;
    this.ledger.owned.delete(this);
  }
}

class CountingFactory {
  readonly handles: CountingHandle[] = [];
  readonly owned = new Set<CountingHandle>();
  readonly closeOrder: string[] = [];
  openAttempts = 0;

  constructor(
    private readonly shouldFailOpen: (
      request: EvidenceHandleRequest,
      attempt: number,
    ) => boolean = () => false,
    private readonly closeFailures: Readonly<Record<string, number>> = {},
  ) {}

  open = (request: EvidenceHandleRequest): CountingHandle => {
    this.openAttempts += 1;
    if (this.shouldFailOpen(request, this.openAttempts)) {
      throw new Error(`injected open failure for ${request.key}`);
    }
    const handle = new CountingHandle(
      request.key,
      this,
      this.closeFailures[request.key] ?? 0,
    );
    this.handles.push(handle);
    this.owned.add(handle);
    return handle;
  };
}

function acquireFirst(
  scope: EvidenceHandleScope<CountingHandle>,
  count: number,
): readonly CountingHandle[] {
  return FOUR_DATABASES.slice(0, count).map((request) => scope.acquire(request));
}

function assertBalanced(factory: CountingFactory): void {
  assert.equal(factory.owned.size, 0, "operation-owned handle count");
  assert.equal(
    factory.handles.reduce((sum, handle) => sum + handle.successfulCloses, 0),
    factory.handles.length,
    "every acquired handle must close successfully",
  );
  for (const handle of factory.handles) {
    assert.equal(handle.successfulCloses, 1, `${handle.key} successful close count`);
  }
}

describe("mission evidence database-handle lifecycle", () => {
  test("procfs-independent success owns and closes all four handles exactly once", () => {
    const factory = new CountingFactory();
    const result = withEvidenceHandleOwnership(factory.open, (scope) => {
      const handles = acquireFirst(scope, FOUR_DATABASES.length);
      assert.equal(scope.acquiredCount, 4);
      assert.equal(scope.ownedCount, 4);
      assert.equal(scope.closedCount, 0);
      return handles.map((handle) => handle.key).join(",");
    });

    assert.equal(result, "m2,mission,factory,trueforge");
    assert.deepEqual(factory.closeOrder, ["trueforge", "factory", "mission", "m2"]);
    assertBalanced(factory);
  });

  test("an open failure is not owned and closes earlier handles in reverse order", () => {
    for (let failureBoundary = 1; failureBoundary <= FOUR_DATABASES.length; failureBoundary += 1) {
      const factory = new CountingFactory(
        (_request, attempt) => attempt === failureBoundary,
      );
      assert.throws(
        () =>
          withEvidenceHandleOwnership(factory.open, (scope) => {
            acquireFirst(scope, FOUR_DATABASES.length);
          }),
        new RegExp(`injected open failure for ${FOUR_DATABASES[failureBoundary - 1]?.key}`),
      );
      assert.equal(factory.handles.length, failureBoundary - 1);
      assert.deepEqual(
        factory.closeOrder,
        FOUR_DATABASES.slice(0, failureBoundary - 1)
          .map((request) => request.key)
          .reverse(),
      );
      assertBalanced(factory);
    }
  });

  test("failure after each acquisition boundary closes every owned handle", () => {
    for (let failureBoundary = 1; failureBoundary <= FOUR_DATABASES.length; failureBoundary += 1) {
      const factory = new CountingFactory();
      const primary = new Error(`failure after acquisition ${failureBoundary}`);
      assert.throws(
        () =>
          withEvidenceHandleOwnership(factory.open, (scope) => {
            acquireFirst(scope, failureBoundary);
            throw primary;
          }),
        (error: unknown) => error === primary,
      );
      assert.deepEqual(
        factory.closeOrder,
        FOUR_DATABASES.slice(0, failureBoundary)
          .map((request) => request.key)
          .reverse(),
      );
      assertBalanced(factory);
    }
  });

  test("a verification throw after acquisition closes all four handles", () => {
    const factory = new CountingFactory();
    const verificationError = new Error("injected verification failure");
    assert.throws(
      () =>
        withEvidenceHandleOwnership(factory.open, (scope) => {
          acquireFirst(scope, FOUR_DATABASES.length);
          throw verificationError;
        }),
      (error: unknown) => error === verificationError,
    );
    assert.deepEqual(factory.closeOrder, ["trueforge", "factory", "mission", "m2"]);
    assertBalanced(factory);
  });

  test("one close failure does not prevent exhaustive cleanup and stays secondary", () => {
    const factory = new CountingFactory(() => false, { mission: 1 });
    const verificationError = Object.freeze(new Error("primary verification failure"));
    assert.throws(
      () =>
        withEvidenceHandleOwnership(factory.open, (scope) => {
          acquireFirst(scope, FOUR_DATABASES.length);
          throw verificationError;
        }),
      (error: unknown) => {
        assert.equal(error, verificationError);
        const cleanupErrors = evidenceCleanupErrors(error);
        assert.equal(cleanupErrors.length, 1);
        assert.match(cleanupErrors[0]?.message ?? "", /mission/u);
        return true;
      },
    );
    assert.deepEqual(factory.closeOrder, ["trueforge", "factory", "mission", "m2"]);
    assert.equal(factory.owned.size, 1);
    assert.equal(factory.handles.find((handle) => handle.key === "mission")?.successfulCloses, 0);
    for (const key of ["m2", "factory", "trueforge"]) {
      assert.equal(factory.handles.find((handle) => handle.key === key)?.successfulCloses, 1);
    }
  });

  test("cleanup can retry a failed close without reclosing successful handles", () => {
    const factory = new CountingFactory(() => false, { mission: 1 });
    const ownership = new EvidenceHandleOwnership<CountingHandle>();
    for (const request of FOUR_DATABASES) {
      ownership.acquire(request.key, () => factory.open(request));
    }

    const firstErrors = ownership.release();
    assert.equal(firstErrors.length, 1);
    assert.equal(ownership.ownedCount, 1);
    assert.equal(ownership.closedCount, 3);
    const secondErrors = ownership.release();
    assert.deepEqual(secondErrors, []);
    assert.equal(ownership.ownedCount, 0);
    assert.equal(ownership.closedCount, 4);

    const mission = factory.handles.find((handle) => handle.key === "mission");
    assert.equal(mission?.closeAttempts, 2);
    assert.equal(mission?.successfulCloses, 1);
    for (const handle of factory.handles.filter((item) => item.key !== "mission")) {
      assert.equal(handle.closeAttempts, 1, `${handle.key} must not be closed again`);
    }
    assertBalanced(factory);
  });

  test("a deliberately leaked idle handle defeats filesystem-only evidence but not ownership accounting", () => {
    const directory = mkdtempSync(join(tmpdir(), "flakebrake-idle-handle-"));
    const databasePath = join(directory, "idle.sqlite");
    const movedPath = join(directory, "idle.moved.sqlite");
    const seeded = new DatabaseSync(databasePath);
    seeded.exec("CREATE TABLE proof (value INTEGER NOT NULL)");
    seeded.close();

    const ownership = new EvidenceHandleOwnership<DatabaseSync>();
    ownership.acquire("idle-read-only", () =>
      new DatabaseSync(databasePath, { readOnly: true }),
    );
    try {
      if (process.platform === "win32") {
        // Deterministically model the successful POSIX fallback on Windows;
        // direct ownership remains the assertion on every platform.
        const virtualFiles = new Set([databasePath]);
        assert.equal(virtualFiles.delete(databasePath), true);
        virtualFiles.add(movedPath);
        assert.equal(virtualFiles.delete(movedPath), true);
        virtualFiles.add(databasePath);
        assert.equal(virtualFiles.delete(databasePath), true);
        virtualFiles.add(databasePath);
        assert.equal(virtualFiles.has(databasePath), true);
      } else {
        renameSync(databasePath, movedPath);
        renameSync(movedPath, databasePath);
        rmSync(databasePath);
        const replacement = new DatabaseSync(databasePath);
        replacement.exec("CREATE TABLE replacement (value INTEGER NOT NULL)");
        replacement.close();
        const reopened = new DatabaseSync(databasePath, { readOnly: true });
        assert.equal(
          reopened.prepare("SELECT COUNT(*) AS count FROM replacement").get()?.["count"],
          0,
        );
        reopened.close();
      }

      assert.throws(
        () => assert.equal(ownership.ownedCount, 0, "operation-owned handle count"),
        /operation-owned handle count/u,
      );
    } finally {
      assert.deepEqual(ownership.release(), []);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("sixteen repeated failed calls leave zero operation-owned handles", () => {
    const factory = new CountingFactory((request) => request.key === "mission");
    for (let attempt = 0; attempt < 16; attempt += 1) {
      assert.throws(
        () =>
          withEvidenceHandleOwnership(factory.open, (scope) => {
            scope.acquire(FOUR_DATABASES[0]);
            scope.acquire(FOUR_DATABASES[1]);
          }),
        /injected open failure for mission/u,
      );
      assert.equal(factory.owned.size, 0, `owned handles after rejected call ${attempt + 1}`);
    }
    assert.equal(factory.handles.length, 16);
    assert.equal(factory.openAttempts, 32);
    assertBalanced(factory);
  });

  test("concurrent export and verification scopes retain independent ownership", async () => {
    const operations = Array.from({ length: 8 }, (_unused, index) => {
      const factory = new CountingFactory();
      return Promise.resolve().then(() => {
        const result = withEvidenceHandleOwnership(factory.open, (scope) => {
          acquireFirst(scope, FOUR_DATABASES.length);
          return index % 2 === 0 ? "export" : "verification";
        });
        return { factory, result };
      });
    });

    const results = await Promise.all(operations);
    assert.deepEqual(
      results.map(({ result }) => result),
      [
        "export",
        "verification",
        "export",
        "verification",
        "export",
        "verification",
        "export",
        "verification",
      ],
    );
    for (const { factory } of results) {
      assert.equal(factory.handles.length, 4);
      assertBalanced(factory);
    }
    const allHandles = results.flatMap(({ factory }) => factory.handles);
    assert.equal(new Set(allHandles).size, 32);
  });
});
