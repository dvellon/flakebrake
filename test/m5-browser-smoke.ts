import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Builder, By, Key, until, type WebDriver, type WebElement } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

import { startM5JudgeServer } from "../src/m5-ui.js";
import {
  armSessionErrorCapture,
  armSessionNetworkCapture,
  formatFailedResponse,
  type BrowserScriptErrorObserver,
  type SessionErrorCapture,
  type SessionNetworkCapture,
} from "./m5-error-capture.js";

interface BidiNetworkModule {
  responseCompleted(callback: (event: { response?: { status?: number | string; url?: string } } | null) => void): Promise<void>;
  fetchError(callback: (event: { errorText?: string; request?: { url?: string } } | null) => void): Promise<void>;
  close(): Promise<void>;
}

const requireModule = createRequire(import.meta.url);
const { Network: createBidiNetwork } = requireModule("selenium-webdriver/bidi/network.js") as {
  Network(driver: WebDriver): Promise<BidiNetworkModule>;
};

const root = mkdtempSync(join(tmpdir(), "flakebrake-m5-browser-"));
const screenshots = mkdtempSync(join(tmpdir(), "flakebrake-m5-screenshots-"));
const browserPort = Number(process.env["FLAKEBRAKE_M5_BROWSER_PORT"] ?? "0");
if (!Number.isSafeInteger(browserPort) || browserPort < 0 || browserPort > 65_535) {
  throw new Error("FLAKEBRAKE_M5_BROWSER_PORT must be an integer from 0 through 65535");
}
const running = await startM5JudgeServer({
  dataRoot: root,
  port: browserPort,
  cleanupDataOnClose: true,
});
const transportKillServer = createServer((socket) => socket.destroy());
await new Promise<void>((resolveListen) => {
  transportKillServer.listen(0, "127.0.0.1", resolveListen);
});
const transportKillAddress = transportKillServer.address();
if (transportKillAddress === null || typeof transportKillAddress === "string") {
  throw new Error("the transport-failure probe server did not expose a loopback port");
}
const transportProbeUrl = `http://127.0.0.1:${String(transportKillAddress.port)}/m5-controlled-transport-failure-probe`;
const transportProbeDocument = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<script>fetch("${transportProbeUrl}", { cache: "no-store" }).catch(() => {});</script>`,
)}`;
let driver: WebDriver | null = null;
let capture: SessionErrorCapture | null = null;
let networkCapture: SessionNetworkCapture | null = null;
let smokeStage = "startup";
let primaryError: unknown = null;

try {
  const options = new firefox.Options().addArguments("-headless");
  options.enableBidi();
  const explicitFirefox = process.env["FLAKEBRAKE_FIREFOX_BINARY"];
  const localSnapFirefox = "/snap/firefox/current/usr/lib/firefox/firefox";
  if (explicitFirefox !== undefined) options.setBinary(explicitFirefox);
  else if (existsSync(localSnapFirefox)) options.setBinary(localSnapFirefox);
  const browser = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
  driver = browser;
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
  const networkProbeUrl = `${running.url}/m5-controlled-missing-resource-probe`;
  networkCapture = await armSessionNetworkCapture(
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
  const armedNetworkCapture = networkCapture;
  const networkProbeEntry = formatFailedResponse(networkProbeUrl, 404);
  const transportProbePrefix = `${transportProbeUrl} transport=`;
  capture = await armSessionErrorCapture(browserScript, sessionBrowser);
  await capture.openApplication(running.url);
  assert.equal(await browser.getTitle(), "FlakeBrake · Promise control room");
  await waitText(browser, By.css(".pill-denied"), "REPLAN");
  await waitText(browser, By.id("proof-direct-result"), "Doesn’t fit yet");
  await waitText(browser, By.id("proof-winner-result"), "10 → 8");
  assert.match(await browser.findElement(By.id("proof-winner-note")).getText(), /Deliver best-effort display stands/u);
  assert.match(await browser.findElement(By.id("proof-direct-note")).getText(), /Agent work over by 2.*Human decisions over by 1/u);
  await waitText(browser, By.id("harness-state"), "Ready");
  await waitText(browser, By.id("guided-heading"), "A rush order is waiting");
  assert.match(
    await browser.findElement(By.id("guided-why")).getText(),
    /This rush order doesn’t fit yet[\s\S]*FlakeBrake found a safer plan/u,
  );
  assert.equal(
    await browser.findElement(By.id("harness-plain")).getText(),
    "TrueForge is ready to coordinate specialist agents, connect 4 factory tools, run a sandbox check, and pause for your decisions.",
  );
  assert.equal(await browser.findElement(By.id("chain-mission")).getText(), "CONFIGURED");
  const readTextContent = async (id: string): Promise<string> =>
    (await browser.findElement(By.id(id)).getAttribute("textContent")) ?? "";
  assert.equal(await readTextContent("harness-mcp"), "4 services configured");
  assert.equal(await readTextContent("harness-sandbox"), "Configured");
  assert.equal(await readTextContent("harness-subagents"), "Dynamic · configured");
  assert.equal(await readTextContent("harness-runtime"), "TrueForge 0.1.4 · SDK 0.1.3");
  assert.equal(await browser.findElement(By.id("harness-pause")).isDisplayed(), false, "the pause line stays hidden while idle");
  assert.equal(
    await browser.executeScript("return document.querySelector('.harness-why').open;"),
    false,
    "the TrueForge disclosure starts collapsed",
  );
  assert.equal(
    await browser.executeScript("return document.querySelector('.harness-technical').open;"),
    false,
    "raw TrueForge identifiers start behind the collapsed technical disclosure",
  );
  assert.equal(
    await browser.findElement(By.id("harness-mcp")).isDisplayed(),
    false,
    "technical harness facts are not visible until the disclosure opens",
  );
  assert.equal(
    await browser.executeScript("return document.querySelector('.trust-technical').open;"),
    false,
    "agent-trust identifiers start behind the collapsed technical disclosure",
  );
  assert.match(
    await browser.findElement(By.css(".trust-primary")).getText(),
    /Agents can propose anything; they cannot make it true\./u,
  );
  assert.equal(
    await browser.findElement(By.id("trust-empty")).isDisplayed(),
    true,
    "idle shows the honest empty agent-trust state",
  );
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
  await browser.executeScript("document.getElementById('proof-capacity-details').open = true; document.getElementById('proof-center-title').scrollIntoView({block: 'start'});");
  const capacityProof = await browser.findElement(By.id("proof-capacity-impact")).getText();
  assert.match(capacityProof, /BEFORE RUSH[\s\S]*DIRECT PLAN[\s\S]*SAFE WINNER/u);
  assert.match(capacityProof, /Agent work\s+4\s+-2\s+2\s+1/u);
  assert.match(capacityProof, /criticality-weighted service degradation:[\s\S]*2\/5[\s\S]*versus[\s\S]*5/u);
  await screenshot(browser, join(screenshots, "02-proof-center-capacity.png"));
  await browser.executeScript("document.getElementById('proof-capacity-details').open = false; window.scrollTo(0, 0);");
  await browser.manage().window().setRect({ width: 1024, height: 768 });
  assert.equal(await hasHorizontalOverflow(browser), false);
  await screenshot(browser, join(screenshots, "03-1024x768-idle.png"));
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
    await waitText(browser, By.id("harness-state"), "Paused for human");
    assert.equal(await browser.findElement(By.id("harness-pause")).isDisplayed(), true);
    assert.equal(
      await browser.findElement(By.id("harness-pause")).getText(),
      "TrueForge paused this turn for your decision.",
    );
    assert.equal(
      (await browser.findElement(By.id("harness-gate")).getAttribute("textContent")) ?? "",
      "Holding this turn",
    );
    assert.equal(
      await browser.findElement(By.id("guided-heading")).getText(),
      ownerCall <= 2 ? "Your approval is required" : ownerCall === 3 ? "This time slot conflicts with protected work" : "A safe time slot is available",
      `owner call ${String(ownerCall)} carries its plain-language story heading`,
    );
    if (ownerCall === 4) {
      assert.equal(
        await browser.findElement(By.id("guided-mechanical")).isDisplayed(),
        true,
        "the mechanical-block story persists into the next approval",
      );
      assert.match(
        await browser.findElement(By.id("guided-mechanical")).getText(),
        /The same unsafe request was blocked automatically/u,
      );
      const pendingTrustRows = await browser.findElement(By.id("trust-rows")).getText();
      assert.match(
        pendingTrustRows,
        /the same denied action in another technical representation/u,
        "the agents-checking-agents panel carries the mechanical-block handoff",
      );
      assert.match(pendingTrustRows, /BLOCKED/u, "the mechanical handoff renders its Blocked result");
    }
    const foldViewports = [
      [1440, 900], [1280, 800], [1120, 800], [1024, 768],
    ] as const;
    for (const [foldWidth, foldHeight] of foldViewports) {
      await browser.manage().window().setRect({ width: foldWidth, height: foldHeight });
      await browser.executeScript("window.scrollTo(0, 0);");
      const positions = await browser.executeScript<{
        readonly headingBottom: number;
        readonly actionsBottom: number;
        readonly viewport: number;
      }>(
        "const heading = document.getElementById('guided-heading').getBoundingClientRect();" +
          "const actions = document.querySelector('.approval-actions').getBoundingClientRect();" +
          "return { headingBottom: heading.bottom, actionsBottom: actions.bottom, viewport: window.innerHeight };",
      );
      assert.equal(
        positions.headingBottom > 0 && positions.headingBottom <= positions.viewport,
        true,
        `guided story heading is above the fold at ${String(foldWidth)}x${String(foldHeight)}`,
      );
      assert.equal(
        positions.actionsBottom > 0 && positions.actionsBottom <= positions.viewport,
        true,
        `the operator decision actions are above the fold at ${String(foldWidth)}x${String(foldHeight)}`,
      );
    }
    await browser.manage().window().setRect({ width: 1440, height: 900 });

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
      await screenshot(browser, join(screenshots, "04-pending-approval.png"));
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
      await waitText(browser, By.id("policy-decision"), "Blocked automatically — same denied action", 60_000);
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
      await screenshot(browser, join(screenshots, "05-owner-and-mechanical-denial.png"));
    }
  }

  await waitText(browser, By.id("outcome"), "Verified success", 60_000);
  await waitText(browser, By.id("verification-pill"), "Verified", 30_000);
  const documentText = await browser.findElement(By.css("body")).getText();
  assert.match(documentText, /Blocked automatically — same denied action/u);
  assert.match(documentText, /09:40–10:10/u);
  assert.match(documentText, /MEASURED RESOURCE USE/u);
  assert.match(documentText, /Agent work[\s\S]*6/u);
  assert.match(documentText, /Production cell[\s\S]*30/u);
  assert.match(documentText, /Resolved through the safest workable plan/u);
  assert.match(documentText, /Earlier attempt stopped safely · recovered/u);
  assert.doesNotMatch(documentText, /Mission stopped safely/u);
  assert.match(documentText, /Independent read-back observed/u);
  assert.doesNotMatch(documentText, /Independent read-back pending/u);
  assert.match(documentText, /What FlakeBrake prevented/iu);
  assert.match(documentText, /3 allowed · 1 denied/u);
  assert.match(documentText, /1 receipt · 1 verified completion · 2 measured facts/u);
  assert.match(documentText, /only mutation is the approved 09:40–10:10 interval/u);
  assert.equal(await browser.findElement(By.id("connection-label")).getText(), "Mission complete");
  await waitText(browser, By.id("harness-state"), "Verified");
  await waitText(browser, By.id("guided-heading"), "Done—and independently verified", 30_000);
  assert.equal(
    await browser.findElement(By.id("harness-plain")).getText(),
    "TrueForge coordinated 3 specialist agents, connected 4 factory tools, ran a sandbox check, paused for your decisions, and resumed the same durable session.",
    "the terminal ribbon states the exact plain-language TrueForge sentence",
  );
  assert.equal(await browser.findElement(By.id("chain-verified")).getText(), "VERIFIED");
  assert.equal(await browser.findElement(By.id("chain-agents")).getText(), "OBSERVED");
  assert.equal(await browser.findElement(By.id("chain-tools")).getText(), "OBSERVED");
  assert.equal(await browser.findElement(By.id("chain-sandbox")).getText(), "OBSERVED");
  assert.equal(await browser.findElement(By.id("chain-resume")).getText(), "OBSERVED");
  assert.equal(await readTextContent("harness-mcp"), "4/4 services reached");
  assert.equal(await readTextContent("harness-sandbox"), "1 executed");
  assert.equal(await readTextContent("harness-subagents"), "3 threads evidenced");
  assert.match(await readTextContent("harness-gate"), /Native · 4 owner calls/u);
  const harnessSessionBeforeRefresh = await readTextContent("harness-session");
  assert.match(harnessSessionBeforeRefresh, /^[0-9a-z]{20,}$/u, "the ribbon shows the genuine TrueForge session identifier");
  assert.equal(await browser.findElement(By.id("harness-pause")).isDisplayed(), false);
  const trustRowsText = await browser.findElement(By.id("trust-rows")).getText();
  assert.match(trustRowsText, /Specialist subagents — Portfolio and order analyst, Capacity and schedule analyst, Assurance and simulation engineer/u);
  assert.match(trustRowsText, /RECOMMENDATION RECORDED/u, "recorded specialist prose is labeled as recorded, never verified");
  assert.match(trustRowsText, /recorded, not semantically verified/u);
  assert.match(trustRowsText, /Authoritative effect check: factory-change-control\/select_portfolio_modification/u);
  assert.match(trustRowsText, /no additional owner decision was used/u);
  assert.match(trustRowsText, /Authoritative effect check: factory-change-control\/verify_schedule_execution/u);
  assert.doesNotMatch(trustRowsText, /pending verification/iu, "the executor claim reads verified only at terminal");
  assert.match(trustRowsText, /VERIFIED RESULT/u, "the executor claim renders its verified result after read-back");
  assert.equal(
    await browser.findElement(By.id("trust-recheck")).isDisplayed(),
    true,
    "the audited root-recheck sentence appears once specialist evidence exists",
  );
  assert.doesNotMatch(trustRowsText, /bridge |turn\/|call /u, "trust rows keep raw identities behind the disclosure");
  assert.equal((await browser.findElements(By.css("#proof-stages .proof-complete"))).length, 3);
  assert.equal((await browser.findElements(By.css("#timeline li.pending"))).length, 0);
  assert.equal((await browser.findElements(By.css(".agent-node.child"))).length, 3);
  const evidenceDownload = await browser.findElement(By.id("evidence-download"));
  assert.equal(await evidenceDownload.isDisplayed(), true);
  assert.equal(await evidenceDownload.getAttribute("aria-disabled"), "false");
  assert.equal(await evidenceDownload.getAttribute("download"), "flakebrake-mission-evidence.json");
  assert.equal(
    await browser.executeScript<boolean>(
      "return fetch('/api/evidence').then(async (response) => response.status === 200 && response.headers.get('content-type')?.startsWith('application/json') === true && JSON.parse(await response.text()).schemaVersion === 'flakebrake-mission-evidence-bundle/v2');",
    ),
    true,
    "the completed mission exposes inspectable canonical evidence",
  );
  const metrics = await Promise.all(
    (await browser.findElements(By.css(".metric strong"))).map((element) => element.getText()),
  );
  assert.deepEqual(metrics, ["1", "1", "1", "1"]);
  assert.deepEqual(
    await browser.executeScript("return [...document.querySelectorAll('.proof-counts strong')].map((item) => item.textContent);"),
    ["1", "1", "1", "2"],
  );
  await browser.executeScript("window.scrollTo(0, 0);");
  await screenshot(browser, join(screenshots, "06-terminal-overview.png"));
  await browser.executeScript("document.getElementById('proof-control-details').open = true; document.getElementById('proof-durable-details').open = true; document.getElementById('proof-center-title').scrollIntoView({block: 'start'});");
  assert.equal((await browser.findElements(By.css("#proof-decisions .proof-decision"))).length, 4);
  assert.equal((await browser.findElements(By.css("#proof-decisions .mechanical-proof"))).length, 1);
  await screenshot(browser, join(screenshots, "07-terminal-proof-center.png"));
  await browser.executeScript("document.getElementById('result-title').scrollIntoView({block: 'start'});");
  await screenshot(browser, join(screenshots, "08-readback-proof.png"));

  const sessionBeforeRefresh = await browser.findElement(By.id("session-id")).getText();
  await browser.navigate().refresh();
  await waitText(browser, By.id("outcome"), "Verified success", 60_000);
  await waitText(browser, By.id("connection-label"), "Durable replay restored", 60_000);
  assert.match((await browser.findElement(By.id("proof-durable-proof")).getAttribute("textContent")) ?? "", /browser is attached to a durable replay/u);
  assert.equal(await browser.findElement(By.id("session-id")).getText(), sessionBeforeRefresh);
  assert.equal(
    (await browser.findElement(By.id("harness-session")).getAttribute("textContent")) ?? "",
    harnessSessionBeforeRefresh,
    "refresh preserves the harness session identity",
  );
  assert.equal(
    await browser.executeScript("return document.getElementById('harness-replay-row').hidden;"),
    false,
  );
  assert.equal(
    (await browser.findElement(By.id("harness-replay")).getAttribute("textContent")) ?? "",
    "Durable session replayed",
    "the recovered mission carries genuine durable-replay evidence",
  );
  await waitText(browser, By.id("harness-state"), "Verified");
  await waitText(browser, By.id("guided-heading"), "Done—and independently verified");
  assert.match(
    await browser.findElement(By.id("guided-why")).getText(),
    /same completed TrueForge session/u,
    "the replay story explains the unchanged completed session",
  );
  assert.match(
    await browser.findElement(By.id("trust-rows")).getText(),
    /Resumed process — continuity claim/u,
    "the replayed session carries the continuity trust row",
  );
  assert.equal(
    (await browser.findElements(By.css("#trust-rows li"))).length,
    await browser.executeScript<number>(
      "return new Set([...document.querySelectorAll('#trust-rows li')].map((item) => item.textContent)).size;",
    ),
    "refresh cannot duplicate agent-trust handoffs",
  );
  assert.deepEqual(
    await Promise.all(
      (await browser.findElements(By.css(".metric strong"))).map((element) => element.getText()),
    ),
    ["1", "1", "1", "1"],
  );
  assert.equal(await browser.findElement(By.id("evidence-download")).isDisplayed(), true);
  assert.equal(
    await browser.findElement(By.id("evidence-download")).getAttribute("aria-disabled"),
    "false",
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
  await screenshot(browser, join(screenshots, "09-tablet-820x1180.png"));
  assert.equal(
    capture.capturedErrorCount(),
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
  // The smoke's own deliberate refreshes and away-navigations abort whichever
  // application /api poll is mid-flight; Firefox reports that browser-initiated
  // cancellation as NS_BINDING_ABORTED. Only that exact self-inflicted
  // signature is exempt — every other failed request still fails the smoke.
  const navigationAbortedPoll = (entry: string): boolean =>
    entry.startsWith(`${running.url}/api/`) && entry.endsWith("transport=NS_BINDING_ABORTED");
  assert.deepEqual(
    sessionFailures.filter(
      (entry) =>
        entry !== networkProbeEntry &&
        !entry.startsWith(transportProbePrefix) &&
        !navigationAbortedPoll(entry),
    ),
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
  process.stdout.write(`M5_BROWSER_SMOKE=PASS\nM5_SCREENSHOTS=${screenshots}\n`);
} catch (error: unknown) {
  const durable = await fetch(`${running.url}/api/state`).then((response) => response.json()).catch(() => ({})) as {
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

const cleanupErrors: unknown[] = [];
try {
  if (capture !== null) {
    await capture.dispose();
    capture = null;
  }
} catch (error: unknown) {
  cleanupErrors.push(error);
}
try {
  if (networkCapture !== null) {
    await networkCapture.dispose();
    networkCapture = null;
  }
} catch (error: unknown) {
  cleanupErrors.push(error);
}
try {
  await new Promise<void>((resolveClose, rejectClose) => {
    transportKillServer.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
} catch (error: unknown) {
  cleanupErrors.push(error);
}
try {
  await driver?.quit();
  if (process.env["FLAKEBRAKE_M5_INJECT_DRIVER_QUIT_FAILURE"] === "1") {
    throw new Error("injected Selenium shutdown failure");
  }
} catch (error: unknown) {
  cleanupErrors.push(error);
}
try {
  await running.close();
} catch (error: unknown) {
  cleanupErrors.push(error);
}
try {
  rmSync(root, { recursive: true, force: true });
} catch (error: unknown) {
  cleanupErrors.push(error);
}

if (primaryError !== null) {
  if (cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "M5 browser smoke and cleanup failed", {
      cause: primaryError instanceof Error ? primaryError : undefined,
    });
  }
  throw primaryError;
}
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "M5 browser smoke cleanup failed");
}

await assert.rejects(fetch(running.url), /fetch failed|ECONNREFUSED/u);

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
}

async function hasHorizontalOverflow(driver: WebDriver): Promise<boolean> {
  return await driver.executeScript<boolean>(
    "return document.documentElement.scrollWidth > document.documentElement.clientWidth;",
  );
}
