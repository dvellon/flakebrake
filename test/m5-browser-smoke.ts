import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Builder, By, Key, until, type WebDriver, type WebElement } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

import {
  armSessionErrorCapture,
  armSessionNetworkCapture,
  formatFailedResponse,
  type BrowserScriptErrorObserver,
} from "./m5-error-capture.js";
import { startM5BrowserSmokeInvocation } from "./m5-browser-launcher.js";

interface BidiNetworkModule {
  responseCompleted(callback: (event: { response?: { status?: number | string; url?: string } } | null) => void): Promise<void>;
  fetchError(callback: (event: { errorText?: string; request?: { url?: string } } | null) => void): Promise<void>;
  close(): Promise<void>;
}

const requireModule = createRequire(import.meta.url);
const { Network: createBidiNetwork } = requireModule("selenium-webdriver/bidi/network.js") as {
  Network(driver: WebDriver): Promise<BidiNetworkModule>;
};

const invocation = await startM5BrowserSmokeInvocation();
const root = invocation.dataRoot;
let driver: WebDriver | null = null;
let smokeStage = "startup";
let primaryError: unknown = null;
let screenshotsCaptured = 0;

try {
  const screenshots = mkdtempSync(join(tmpdir(), "flakebrake-m5-screenshots-"));
  invocation.own(async () => {
    rmSync(screenshots, { recursive: true, force: true });
  });
  const transportKillServer = createServer((socket) => socket.destroy());
  invocation.own(async () => {
    if (!transportKillServer.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => {
      transportKillServer.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    transportKillServer.once("error", onError);
    transportKillServer.listen(0, "127.0.0.1", () => {
      transportKillServer.off("error", onError);
      resolveListen();
    });
  });
  const transportKillAddress = transportKillServer.address();
  if (transportKillAddress === null || typeof transportKillAddress === "string") {
    throw new Error("the transport-failure probe server did not expose a loopback port");
  }
  const transportProbeUrl = `http://127.0.0.1:${String(transportKillAddress.port)}/m5-controlled-transport-failure-probe`;
  const transportProbeDocument = `data:text/html;charset=utf-8,${encodeURIComponent(
    `<script>fetch("${transportProbeUrl}", { cache: "no-store" }).catch(() => {});</script>`,
  )}`;
  const options = new firefox.Options().addArguments("-headless");
  options.enableBidi();
  const explicitFirefox = process.env["FLAKEBRAKE_FIREFOX_BINARY"];
  const localSnapFirefox = "/snap/firefox/current/usr/lib/firefox/firefox";
  if (explicitFirefox !== undefined) options.setBinary(explicitFirefox);
  else if (existsSync(localSnapFirefox)) options.setBinary(localSnapFirefox);
  const browser = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
  driver = browser;
  invocation.own(async () => {
    await browser.quit();
    driver = null;
    if (process.env["FLAKEBRAKE_M5_INJECT_DRIVER_QUIT_FAILURE"] === "1") {
      throw new Error("injected Selenium shutdown failure");
    }
  });
  const browserScript = (
    browser as WebDriver & { script(): BrowserScriptErrorObserver }
  ).script();
  await browser.manage().setTimeouts({ implicit: 0, pageLoad: 20_000, script: 10_000 });
  await browser.manage().window().setRect({ width: 1440, height: 1000 });
  const sessionBrowser = {
    get: async (url: string) => {
      await browser.get(url);
    },
    refresh: async () => {
      await browser.navigate().refresh();
    },
    wait: async (condition: () => boolean, timeoutMs: number, message: string) => {
      await browser.wait(() => condition(), timeoutMs, message);
    },
  };
  const bidiNetwork = await createBidiNetwork(browser);
  const networkProbeUrl = `${invocation.url}/m5-controlled-missing-resource-probe`;
  const armedNetworkCapture = await armSessionNetworkCapture(
    {
      addFailedResponseHandler: async (callback) => {
        await bidiNetwork.responseCompleted((event) => {
          const status = Number(event?.response?.status);
          if (Number.isFinite(status)) callback({ url: String(event?.response?.url ?? ""), status });
        });
      },
      addFetchErrorHandler: async (callback) => {
        await bidiNetwork.fetchError((event) => {
          if (typeof event?.errorText === "string") {
            callback({ url: String(event.request?.url ?? ""), errorText: event.errorText });
          }
        });
      },
      removeNetworkHandlers: async () => {
        await bidiNetwork.close();
      },
    },
    sessionBrowser,
    networkProbeUrl,
    {
      url: transportProbeUrl,
      trigger: async () => {
        await browser.get(transportProbeDocument);
      },
    },
  );
  invocation.own(async () => {
    await armedNetworkCapture.dispose();
  });
  const networkProbeEntry = formatFailedResponse(networkProbeUrl, 404);
  const transportProbePrefix = `${transportProbeUrl} transport=`;
  const armedErrorCapture = await armSessionErrorCapture(browserScript, sessionBrowser);
  invocation.own(async () => {
    await armedErrorCapture.dispose();
  });
  await armedErrorCapture.openApplication(invocation.url);
  assert.equal(await browser.getTitle(), "FlakeBrake · Promise control room");
  await waitText(browser, By.css(".pill-denied"), "REPLAN");
  assert.match(await browser.findElement(By.css(".basis-note")).getText(), /precomputed canonical basis/u);
  assert.equal((await browser.findElements(By.css("progress.capacity-baseline"))).length, 3);
  assert.equal((await browser.findElements(By.css("[style]"))).length, 0, "CSP-safe UI has no inline style attributes");
  assert.equal(
    await browser.executeScript("return getComputedStyle(document.querySelector('.candidate .pill-approved')).color;"),
    "rgb(201, 244, 91)",
    "the winning candidate pill keeps its status color",
  );
  assert.equal(
    await browser.executeScript("return getComputedStyle(document.querySelector('.candidate-number')).display;"),
    "grid",
    "candidate ordinals render as centered badges",
  );
  assert.equal(
    await browser.executeScript(
      "return new Set([...document.querySelectorAll('.capacity-item .remaining')].map((item) => Math.round(item.getBoundingClientRect().top))).size;",
    ),
    1,
    "capacity remaining values align across cards",
  );
  assert.equal(
    await browser.executeScript("return getComputedStyle(document.querySelector('.topbar')).backgroundColor;"),
    "rgba(9, 16, 12, 0.96)",
    "the sticky topbar keeps scrolled content from reading through",
  );
  await screenshot(browser, join(screenshots, "01-initial.png"));
  await browser.manage().window().setRect({ width: 1024, height: 768 });
  assert.equal(await hasHorizontalOverflow(browser), false);
  await screenshot(browser, join(screenshots, "02-1024x768-idle.png"));
  await browser.manage().window().setRect({ width: 1440, height: 900 });

  const start = await browser.findElement(By.id("start-button"));
  await browser.executeScript("document.getElementById('start-button').focus();");
  assert.equal(
    await browser.executeScript("return document.activeElement === document.getElementById('start-button');"),
    true,
  );
  const controlledFailurePath = join(root, "trueforge.sqlite");
  writeFileSync(controlledFailurePath, "controlled invalid SQLite fixture\n");
  await start.sendKeys(Key.ENTER);
  smokeStage = "start_clicked";
  await waitText(browser, By.id("outcome"), "Stopped safely", 60_000);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${controlledFailurePath}${suffix}`, { force: true });
  }
  await waitText(browser, By.id("start-button"), "Resume safely");
  await browser.findElement(By.id("start-button")).click();
  smokeStage = "recovery_clicked";

  const actionDigests = new Set<string>();
  for (let ownerCall = 1; ownerCall <= 4; ownerCall += 1) {
    const panel = await browser.findElement(By.id("approval-panel"));
    await browser.wait(
      async () => {
        const className = await panel.getAttribute("class");
        const candidate = (await browser.findElement(By.id("approval-digest")).getAttribute("textContent")) ?? "";
        return !className?.includes("is-continuing") && /^sha256:[a-f0-9]{64}$/u.test(candidate);
      },
      60_000,
    );
    const digestElement = await browser.findElement(By.id("approval-digest"));
    const digest = (await digestElement.getAttribute("textContent")) ?? "";
    assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(actionDigests.has(digest), false, "each owner call has a distinct action digest");
    assert.equal(
      await browser.executeScript("return document.activeElement === document.getElementById('approval-title');"),
      true,
      "new owner decisions move keyboard focus to the approval heading",
    );
    smokeStage = `owner_${ownerCall}_visible`;
    actionDigests.add(digest);

    if (ownerCall === 2) {
      assert.equal(
        await browser.executeScript<number>(
          "return fetch('/m5-controlled-missing-resource-probe').then((response) => response.status);",
        ),
        404,
        "the pre-refresh controlled resource-failure probe reached the server",
      );
      await browser.wait(
        () => armedNetworkCapture.failedResponses().includes(networkProbeEntry),
        5_000,
        "the session network observer did not record the pre-refresh controlled failure",
      );
      await screenshot(browser, join(screenshots, "03-pending-approval.png"));
      await browser.navigate().refresh();
      await browser.wait(until.elementLocated(By.id("approval-panel")), 60_000);
      await browser.wait(
        async () =>
          (await browser.findElement(By.id("approval-digest")).getAttribute("textContent")) === digest,
        60_000,
      );
    }
    const recommendedButtons = await browser.findElements(By.css("#approval-panel .button-primary"));
    assert.equal(recommendedButtons.length, 1, "each approval has exactly one dominant action");
    const guidance = await browser.findElement(By.id("approval-guidance")).getText();
    const button = await browser.findElement(
      By.id(guidance.toLowerCase().includes("deny") ? "deny-button" : "allow-button"),
    );
    assert.equal(await recommendedButtons[0]?.getAttribute("id"), await button.getAttribute("id"));
    assert.equal(await button.isEnabled(), true);
    if (ownerCall === 3) {
      await browser.executeScript("document.querySelector('#timeline .evidence-details').open = true;");
    }
    if (ownerCall === 1) await button.sendKeys(Key.ENTER);
    else await button.click();
    if (ownerCall === 1) {
      assert.equal(
        await browser.executeScript("return document.activeElement === document.getElementById('approval-title');"),
        true,
        "keyboard focus returns to the approval heading after activating a decision",
      );
    }
    smokeStage = `owner_${ownerCall}_clicked`;
    await browser.wait(
      async () => {
        const outcome = await browser.findElement(By.id("outcome")).getText();
        if (outcome === "Verified success" || outcome === "Stopped safely") return true;
        const className = await browser.findElement(By.id("approval-panel")).getAttribute("class");
        if (className?.includes("is-continuing")) return true;
        return (
          (await browser.findElement(By.id("approval-digest")).getAttribute("textContent")) !== digest
        );
      },
      60_000,
    );
    if (ownerCall === 3) {
      await browser.wait(until.elementLocated(By.css(".policy-decision:not([hidden])")), 60_000);
      await waitText(browser, By.id("policy-decision"), "Auto-blocked · active policy", 60_000);
      assert.equal(
        await browser.executeScript("return document.querySelector('#timeline .evidence-details').open;"),
        true,
        "open durable-evidence disclosures survive state re-renders",
      );
      assert.equal(
        await browser.executeScript("return getComputedStyle(document.querySelector('#policy-decision strong')).display;"),
        "block",
        "policy decision titles render as stacked rows rather than run-on text",
      );
      await screenshot(browser, join(screenshots, "04-owner-and-mechanical-denial.png"));
    }
  }

  await waitText(browser, By.id("outcome"), "Verified success", 60_000);
  await waitText(browser, By.id("verification-pill"), "Verified", 30_000);
  const documentText = await browser.findElement(By.css("body")).getText();
  assert.match(documentText, /Auto-blocked · active policy/u);
  assert.match(documentText, /09:40–10:10/u);
  assert.match(documentText, /ACTUAL CONSUMPTION FACTS/u);
  assert.match(documentText, /Agent work[\s\S]*6/u);
  assert.match(documentText, /Production cell[\s\S]*30/u);
  assert.match(documentText, /Resolved through bounded replan/u);
  assert.match(documentText, /Earlier attempt stopped safely · recovered/u);
  assert.doesNotMatch(documentText, /Mission stopped safely/u);
  assert.match(documentText, /Independent read-back observed/u);
  assert.doesNotMatch(documentText, /Independent read-back pending/u);
  assert.equal(await browser.findElement(By.id("connection-label")).getText(), "Mission complete");
  assert.equal((await browser.findElements(By.css("#proof-stages .proof-complete"))).length, 3);
  assert.equal((await browser.findElements(By.css("#timeline li.pending"))).length, 0);
  assert.equal((await browser.findElements(By.css(".agent-node.child"))).length, 3);
  const metrics = await Promise.all(
    (await browser.findElements(By.css(".metric strong"))).map((element) => element.getText()),
  );
  assert.deepEqual(metrics, ["1", "1", "1", "1"]);
  await browser.executeScript("window.scrollTo(0, 0);");
  await screenshot(browser, join(screenshots, "05-terminal-overview.png"));
  await browser.executeScript("document.getElementById('result-title').scrollIntoView({block: 'start'});");
  await screenshot(browser, join(screenshots, "06-readback-proof.png"));

  const sessionBeforeRefresh = await browser.findElement(By.id("session-id")).getText();
  await browser.navigate().refresh();
  await waitText(browser, By.id("outcome"), "Verified success", 60_000);
  await waitText(browser, By.id("connection-label"), "Durable replay restored", 60_000);
  assert.equal(await browser.findElement(By.id("session-id")).getText(), sessionBeforeRefresh);
  assert.deepEqual(
    await Promise.all(
      (await browser.findElements(By.css(".metric strong"))).map((element) => element.getText()),
    ),
    ["1", "1", "1", "1"],
  );

  const viewports = [
    [1440, 900], [1280, 800], [1120, 800], [1024, 768], [981, 800], [820, 1180],
  ] as const;
  for (const [width, height] of viewports) {
    await browser.manage().window().setRect({ width, height });
    await browser.executeScript("window.scrollTo(0, 0);");
    assert.equal(await hasHorizontalOverflow(browser), false, `${String(width)}x${String(height)} overflow`);
    assert.equal(await browser.findElement(By.id("start-button")).isDisplayed(), true);
  }
  await screenshot(browser, join(screenshots, "07-tablet-820x1180.png"));

  await browser.manage().window().setRect({ width: 1440, height: 900 });
  await browser.executeScript("document.getElementById('scenario-select').focus();");
  assert.equal(
    await browser.executeScript(
      "return document.activeElement === document.getElementById('scenario-select');",
    ),
    true,
    "the scenario selector is keyboard focusable",
  );
  await browser.findElement(By.id("scenario-select")).sendKeys(Key.END);
  smokeStage = "capacity_scenario_selected";
  await waitText(browser, By.id("hero-title"), "A capacity shock.", 30_000);
  await waitText(browser, By.id("start-button"), "Start capacity shock", 30_000);
  await waitText(browser, By.id("scenario-transition"), "100 to 90 minutes", 30_000);
  assert.equal(
    await browser.findElement(By.id("scenario-select")).getAttribute("value"),
    "capacity-shock",
  );
  assert.match(await browser.findElement(By.id("basis-resolution")).getText(), /Capacity-plan\/v1/u);
  assert.equal(await hasHorizontalOverflow(browser), false);
  await screenshot(browser, join(screenshots, "08-capacity-shock-idle.png"));

  await browser.findElement(By.id("start-button")).click();
  const capacityDigests = new Set<string>();
  for (let ownerCall = 1; ownerCall <= 4; ownerCall += 1) {
    const panel = await browser.findElement(By.id("approval-panel"));
    await browser.wait(
      async () => {
        const className = await panel.getAttribute("class");
        const digest =
          (await browser.findElement(By.id("approval-digest")).getAttribute("textContent")) ?? "";
        return (
          !className?.includes("is-continuing") &&
          /^(?:m4-bridge\/)?sha256:[a-f0-9]{64}$/u.test(digest)
        );
      },
      60_000,
    );
    const digest =
      (await browser.findElement(By.id("approval-digest")).getAttribute("textContent")) ?? "";
    assert.equal(capacityDigests.has(digest), false);
    capacityDigests.add(digest);
    const guidance = await browser.findElement(By.id("approval-guidance")).getText();
    const button = await browser.findElement(
      By.id(guidance.toLowerCase().includes("deny") ? "deny-button" : "allow-button"),
    );
    assert.equal(await button.isEnabled(), true);
    await button.click();
    smokeStage = `capacity_owner_${ownerCall}_clicked`;
    await browser.wait(
      async () => {
        const outcome = await browser.findElement(By.id("outcome")).getText();
        if (outcome === "Verified success" || outcome === "Stopped safely") return true;
        const nextDigest =
          (await browser.findElement(By.id("approval-digest")).getAttribute("textContent")) ?? "";
        return nextDigest !== digest;
      },
      60_000,
    );
  }
  await waitText(browser, By.id("outcome"), "Verified success", 60_000);
  const capacityDocument = await browser.findElement(By.css("body")).getText();
  assert.match(capacityDocument, /Initial plan: ADMITTABLE/u);
  assert.match(capacityDocument, /Capacity shock: 100 → 90 minutes/u);
  assert.match(capacityDocument, /Stale v1 action rejected/u);
  assert.match(capacityDocument, /09:36–10:00/u);
  assert.match(capacityDocument, /Agent work[\s\S]*3/u);
  assert.match(capacityDocument, /Production cell[\s\S]*24/u);
  assert.match(capacityDocument, /order\/best-effort-training-trays/u);
  assert.equal((await browser.findElements(By.css("#proof-stages .proof-complete"))).length, 3);
  assert.deepEqual(
    await Promise.all(
      (await browser.findElements(By.css(".metric strong"))).map((element) => element.getText()),
    ),
    ["1", "1", "1", "1"],
  );
  const capacitySession = await browser.findElement(By.id("session-id")).getText();
  await screenshot(browser, join(screenshots, "09-capacity-shock-verified.png"));
  await browser.navigate().refresh();
  await waitText(browser, By.id("outcome"), "Verified success", 60_000);
  assert.equal(await browser.findElement(By.id("session-id")).getText(), capacitySession);
  assert.equal(
    await browser.findElement(By.id("scenario-select")).getAttribute("value"),
    "capacity-shock",
  );
  assert.equal(
    armedErrorCapture.capturedErrorCount(),
    0,
    "the session-level observer captured no JavaScript errors across application loads",
  );
  const browserLogs = await browser.manage().logs().get("browser").catch(() => []);
  assert.deepEqual(browserLogs.filter((item) => item.level.name === "SEVERE"), []);
  assert.equal(
    await browser.executeScript<number>(
      "return fetch('/m5-controlled-missing-resource-probe').then((response) => response.status);",
    ),
    404,
    "the end-of-session controlled resource-failure probe reached the server",
  );
  await browser.wait(
    () => armedNetworkCapture.failedResponses().filter((entry) => entry === networkProbeEntry).length >= 2,
    5_000,
    "the session network observer lost coverage before the end of the smoke",
  );
  await browser.get(transportProbeDocument);
  await browser.wait(
    () => armedNetworkCapture.failedResponses().some((entry) => entry.startsWith(transportProbePrefix)),
    5_000,
    "the session transport-failure channel lost coverage before the end of the smoke",
  );
  const sessionFailures = armedNetworkCapture.failedResponses();
  assert.deepEqual(
    sessionFailures.filter((entry) => entry !== networkProbeEntry && !entry.startsWith(transportProbePrefix)),
    [],
    "no unexpected request failed at any point in the browser session",
  );
  assert.equal(
    sessionFailures.filter((entry) => entry === networkProbeEntry).length,
    2,
    "controlled resource failures persist in session evidence across refreshes",
  );
  assert.equal(
    sessionFailures.some((entry) => entry.startsWith(transportProbePrefix)),
    true,
    "the controlled end-of-session transport failure was observed by the session channel",
  );
} catch (error: unknown) {
  const durable = await fetch(`${invocation.url}/api/state`).then((response) => response.json()).catch(() => ({})) as {
    readonly run?: { readonly status?: string; readonly errorCode?: string | null };
    readonly pendingApproval?: { readonly toolName?: string } | null;
    readonly approvals?: readonly unknown[];
  };
  const browserState =
    driver === null
      ? null
      : await driver.executeScript<Record<string, unknown>>(
          "return {connection: document.getElementById('connection-label')?.textContent, outcome: document.getElementById('outcome')?.textContent, verification: document.getElementById('verification-pill')?.textContent, toast: document.getElementById('toast')?.textContent, approvalClass: document.getElementById('approval-panel')?.className, approvalDigest: document.getElementById('approval-digest')?.textContent, allowDisabled: document.getElementById('allow-button')?.disabled, denyDisabled: document.getElementById('deny-button')?.disabled, guidance: document.getElementById('approval-guidance')?.textContent, approvalRequests: performance.getEntriesByType('resource').filter((item) => item.name.includes('/api/approval')).length};",
        ).catch(() => null);
  primaryError = new Error(
    `M5 browser smoke stopped: ${JSON.stringify({
      runStatus: durable.run?.status ?? "unknown",
      errorCode: durable.run?.errorCode ?? null,
      pendingTool: durable.pendingApproval?.toolName ?? null,
      approvalCount: durable.approvals?.length ?? 0,
      smokeStage,
      browserState,
    })}`,
    { cause: error },
  );
}

if (primaryError !== null) {
  await invocation.fail(primaryError);
}
await invocation.close();

await assert.rejects(fetch(invocation.url), /fetch failed|ECONNREFUSED/u);
process.stdout.write(
  `M5_BROWSER_SMOKE=PASS\nM5_BROWSER_SMOKE_PORT=${String(invocation.port)}\nM5_SCREENSHOTS_CAPTURED=${String(screenshotsCaptured)}\n`,
);

async function waitText(
  driver: WebDriver,
  locator: ReturnType<typeof By.id>,
  expected: string,
  timeout = 10_000,
): Promise<WebElement> {
  const element = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(
    async () => (await element.getText()).toLowerCase().includes(expected.toLowerCase()),
    timeout,
  );
  return element;
}

async function screenshot(driver: WebDriver, path: string): Promise<void> {
  const encoded = await driver.takeScreenshot();
  writeFileSync(path, encoded, "base64");
  screenshotsCaptured += 1;
}

async function hasHorizontalOverflow(driver: WebDriver): Promise<boolean> {
  return await driver.executeScript<boolean>(
    "return document.documentElement.scrollWidth > document.documentElement.clientWidth;",
  );
}
