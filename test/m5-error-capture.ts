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

export const CONTROLLED_ERROR_PROBE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  "<script>throw new Error('m5-controlled-error-capture-probe')</script>",
)}`;

export async function armSessionErrorCapture(
  script: BrowserScriptErrorObserver,
  browser: ObserverSessionBrowser,
): Promise<SessionErrorCapture> {
  let capturedErrorCount = 0;
  const handlerId = await script.addJavaScriptErrorHandler(() => {
    capturedErrorCount += 1;
  });
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
    dispose: async (): Promise<void> => {
      await script.removeJavaScriptErrorHandler(handlerId);
    },
  };
}
