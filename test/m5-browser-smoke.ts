import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Builder, By, until, type WebDriver, type WebElement } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

import { startM5JudgeServer } from "../src/m5-ui.js";

const root = mkdtempSync(join(tmpdir(), "flakebrake-m5-browser-"));
const screenshots = mkdtempSync(join(tmpdir(), "flakebrake-m5-screenshots-"));
const running = await startM5JudgeServer({
  dataRoot: root,
  port: 0,
  cleanupDataOnClose: true,
});
let driver: WebDriver | null = null;
let smokeStage = "startup";
let primaryError: unknown = null;

try {
  const options = new firefox.Options().addArguments("-headless");
  const explicitFirefox = process.env["FLAKEBRAKE_FIREFOX_BINARY"];
  const localSnapFirefox = "/snap/firefox/current/usr/lib/firefox/firefox";
  if (explicitFirefox !== undefined) options.setBinary(explicitFirefox);
  else if (existsSync(localSnapFirefox)) options.setBinary(localSnapFirefox);
  const browser = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
  driver = browser;
  await browser.manage().setTimeouts({ implicit: 0, pageLoad: 20_000, script: 10_000 });
  await browser.manage().window().setRect({ width: 1440, height: 1000 });
  await browser.get(running.url);
  assert.equal(await browser.getTitle(), "FlakeBrake · Promise control room");
  await waitText(browser, By.css(".pill-denied"), "REPLAN");
  await screenshot(browser, join(screenshots, "01-initial.png"));

  const start = await browser.findElement(By.id("start-button"));
  await browser.executeScript("document.getElementById('start-button').focus();");
  assert.equal(
    await browser.executeScript("return document.activeElement === document.getElementById('start-button');"),
    true,
  );
  await start.click();
  smokeStage = "start_clicked";

  const actionDigests = new Set<string>();
  for (let ownerCall = 1; ownerCall <= 4; ownerCall += 1) {
    const panel = await browser.findElement(By.id("approval-panel"));
    await browser.wait(until.elementIsVisible(panel), 60_000);
    const digestElement = await browser.findElement(By.id("approval-digest"));
    const digest = (await digestElement.getAttribute("textContent")) ?? "";
    assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(actionDigests.has(digest), false, "each owner call has a distinct action digest");
    smokeStage = `owner_${ownerCall}_visible`;
    actionDigests.add(digest);

    if (ownerCall === 2) {
      await screenshot(browser, join(screenshots, "02-approval.png"));
      await browser.navigate().refresh();
      await browser.wait(until.elementLocated(By.id("approval-panel")), 60_000);
      await browser.wait(
        async () =>
          (await browser.findElement(By.id("approval-digest")).getAttribute("textContent")) === digest,
        60_000,
      );
    }
    const guidance = await browser.findElement(By.id("approval-guidance")).getText();
    const button = await browser.findElement(
      By.id(guidance.includes("deny") ? "deny-button" : "allow-button"),
    );
    assert.equal(await button.isEnabled(), true);
    await button.click();
    smokeStage = `owner_${ownerCall}_clicked`;
    await browser.wait(
      async () => {
        const outcome = await browser.findElement(By.id("outcome")).getText();
        if (outcome === "Verified success" || outcome === "Stopped safely") return true;
        const className = await browser.findElement(By.id("approval-panel")).getAttribute("class");
        if (className?.includes("is-hidden")) return true;
        return (
          (await browser.findElement(By.id("approval-digest")).getAttribute("textContent")) !== digest
        );
      },
      60_000,
    );
  }

  await waitText(browser, By.id("outcome"), "Verified success", 60_000);
  await waitText(browser, By.id("verification-pill"), "Verified", 30_000);
  const documentText = await browser.findElement(By.css("body")).getText();
  assert.match(documentText, /Equivalent representation denied mechanically/u);
  assert.match(documentText, /09:40.*10:10/u);
  assert.match(documentText, /ACTUAL CONSUMPTION/u);
  assert.match(documentText, /agent_work_units[\s\S]*6/u);
  assert.match(documentText, /production_cell_minutes[\s\S]*30/u);
  assert.equal((await browser.findElements(By.css(".agent-node.child"))).length, 3);
  const metrics = await Promise.all(
    (await browser.findElements(By.css(".metric strong"))).map((element) => element.getText()),
  );
  assert.deepEqual(metrics, ["1", "1", "1", "1"]);
  await browser.executeScript("window.scrollTo(0, 0);");
  await screenshot(browser, join(screenshots, "03-verified-overview.png"));
  await browser.executeScript("document.getElementById('result-title').scrollIntoView({block: 'start'});");
  await screenshot(browser, join(screenshots, "04-verified-evidence.png"));

  const sessionBeforeRefresh = await browser.findElement(By.id("session-id")).getText();
  await browser.navigate().refresh();
  await waitText(browser, By.id("outcome"), "Verified success", 60_000);
  assert.equal(await browser.findElement(By.id("session-id")).getText(), sessionBeforeRefresh);
  assert.deepEqual(
    await Promise.all(
      (await browser.findElements(By.css(".metric strong"))).map((element) => element.getText()),
    ),
    ["1", "1", "1", "1"],
  );

  await browser.manage().window().setRect({ width: 820, height: 1100 });
  await browser.executeScript("window.scrollTo(0, 0);");
  const noHorizontalOverflow = await browser.executeScript<boolean>(
    "return document.documentElement.scrollWidth <= document.documentElement.clientWidth;",
  );
  assert.equal(noHorizontalOverflow, true);
  assert.equal(await browser.findElement(By.id("start-button")).isDisplayed(), true);
  await screenshot(browser, join(screenshots, "05-tablet.png"));
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
