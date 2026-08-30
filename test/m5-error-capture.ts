export interface BrowserScriptErrorObserver {
  addJavaScriptErrorHandler(callback: (entry: unknown) => void): Promise<number>;
  removeJavaScriptErrorHandler(id: number): Promise<void>;
}

export interface ObserverSessionBrowser {
  get(url: string): Promise<void>;
  refresh(): Promise<void>;
  wait(condition: () => boolean, timeoutMs: number, message: string): Promise<void>;
}

export interface SessionErrorCapture {
  readonly handlerId: number;
  capturedErrorCount(): number;
  openApplication(url: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface BrowserNetworkObserver {
  addFailedResponseHandler(callback: (entry: { url: string; status: number }) => void): Promise<void>;
  addFetchErrorHandler(callback: (entry: { url: string; errorText: string }) => void): Promise<void>;
  removeNetworkHandlers(): Promise<void>;
}

export interface SessionTransportProbe {
  readonly url: string;
  trigger(): Promise<void>;
}

export interface SessionNetworkCapture {
  failedResponses(): readonly string[];
  dispose(): Promise<void>;
}

export function formatFailedResponse(url: string, status: number): string {
  return `${url} status=${String(status)}`;
}

export function formatTransportFailure(url: string, errorText: string): string {
  return `${url} transport=${errorText}`;
}

export interface SessionCleanupStack {
  own(release: () => Promise<void>): void;
  release(): Promise<void>;
}

export function sessionCleanupStack(): SessionCleanupStack {
  const releases: (() => Promise<void>)[] = [];
  let released = false;
  return {
    own: (release) => {
      releases.push(release);
    },
    release: async () => {
      if (released) return;
      released = true;
      const failures: unknown[] = [];
      for (const release of [...releases].reverse()) {
        try {
          await release();
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "session capture cleanup failed");
      }
    },
  };
}

async function failedArmingError(cleanup: SessionCleanupStack, primaryError: unknown): Promise<unknown> {
  try {
    await cleanup.release();
  } catch (cleanupError: unknown) {
    return new AggregateError([primaryError, cleanupError], "session capture arming and cleanup failed", {
      cause: primaryError instanceof Error ? primaryError : undefined,
    });
  }
  return primaryError;
}

export const CONTROLLED_ERROR_PROBE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  "<script>throw new Error('m5-controlled-error-capture-probe')</script>",
)}`;

export async function armSessionErrorCapture(
  script: BrowserScriptErrorObserver,
  browser: ObserverSessionBrowser,
): Promise<SessionErrorCapture> {
  const cleanup = sessionCleanupStack();
  try {
    let capturedErrorCount = 0;
    const handlerId = await script.addJavaScriptErrorHandler(() => {
      capturedErrorCount += 1;
    });
    cleanup.own(() => script.removeJavaScriptErrorHandler(handlerId));
    await browser.get(CONTROLLED_ERROR_PROBE_URL);
    await browser.wait(
      () => capturedErrorCount > 0,
      5_000,
      "the session observer did not capture the controlled load-time probe error",
    );
    const firstProbeCount = capturedErrorCount;
    await browser.refresh();
    await browser.wait(
      () => capturedErrorCount > firstProbeCount,
      5_000,
      "the session observer did not keep capturing the probe error across refresh",
    );
    capturedErrorCount = 0;
    return {
      handlerId,
      capturedErrorCount: () => capturedErrorCount,
      openApplication: async (url: string): Promise<void> => {
        await browser.get(url);
      },
      dispose: () => cleanup.release(),
    };
  } catch (error: unknown) {
    throw await failedArmingError(cleanup, error);
  }
}

export async function armSessionNetworkCapture(
  observer: BrowserNetworkObserver,
  browser: ObserverSessionBrowser,
  probeUrl: string,
  transportProbe: SessionTransportProbe,
): Promise<SessionNetworkCapture> {
  const cleanup = sessionCleanupStack();
  try {
    const failed: string[] = [];
    const probeEntry = formatFailedResponse(probeUrl, 404);
    const transportPrefix = `${transportProbe.url} transport=`;
    await observer.addFailedResponseHandler((entry) => {
      if (entry.status >= 400) failed.push(formatFailedResponse(entry.url, entry.status));
    });
    cleanup.own(() => observer.removeNetworkHandlers());
    await observer.addFetchErrorHandler((entry) => {
      failed.push(formatTransportFailure(entry.url, entry.errorText));
    });
    const probeObservations = (): number => failed.filter((entry) => entry === probeEntry).length;
    const transportObservations = (): number =>
      failed.filter((entry) => entry.startsWith(transportPrefix)).length;
    await transportProbe.trigger();
    await browser.wait(
      () => transportObservations() >= 1,
      5_000,
      "the session network observer did not observe the controlled transport-failure probe",
    );
    await browser.get(probeUrl);
    await browser.wait(
      () => probeObservations() >= 1,
      5_000,
      "the session network observer did not observe the controlled missing-resource probe",
    );
    await browser.refresh();
    await browser.wait(
      () => probeObservations() >= 2,
      5_000,
      "the session network observer did not keep observing the missing-resource probe across refresh",
    );
    await transportProbe.trigger();
    await browser.wait(
      () => transportObservations() >= 2,
      5_000,
      "the session network observer did not keep observing the transport-failure probe across refresh",
    );
    let settledLength = -1;
    let stableSamples = 0;
    await browser.wait(
      () => {
        if (failed.length === settledLength) stableSamples += 1;
        else {
          settledLength = failed.length;
          stableSamples = 0;
        }
        return stableSamples >= 3;
      },
      5_000,
      "network evidence from the probe documents did not settle before clearing",
    );
    failed.length = 0;
    return {
      failedResponses: () => [...failed],
      dispose: () => cleanup.release(),
    };
  } catch (error: unknown) {
    throw await failedArmingError(cleanup, error);
  }
}
