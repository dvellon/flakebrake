import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Builder, By, until, type WebDriver } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

import { startRecoveryDemoServer } from "../src/recovery-demo-ui.js";

const directory = mkdtempSync(join(tmpdir(), "flakebrake-recovery-browser-"));
const running = await startRecoveryDemoServer({
  dataRoot: directory,
  port: 4177,
  cleanupDataOnClose: false,
});
let browser: WebDriver | null = null;
try {
  const options = new firefox.Options().addArguments("-headless");
  const explicitFirefox = process.env["FLAKEBRAKE_FIREFOX_BINARY"];
  const localSnapFirefox = "/snap/firefox/current/usr/lib/firefox/firefox";
  if (explicitFirefox !== undefined) options.setBinary(explicitFirefox);
  else if (existsSync(localSnapFirefox)) options.setBinary(localSnapFirefox);
  browser = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();
  await browser.get(running.url);
  await browser.wait(until.elementTextIs(browser.findElement(By.id("connection-label")), "Loopback connected"), 10_000);
  assert.equal((await browser.findElements(By.css("[style]"))).length, 0);
  assert.equal((await browser.findElements(By.xpath("//*[contains(text(), 'Start hero mission')]"))).length, 0);

  await exercise(browser, "after_execution_fence_before_factory_mutation");
  await browser.findElement(By.id("reset-button")).click();
  await waitStage(browser, "idle");
  await exercise(browser, "after_factory_commit_before_m2_binding");

  for (const [width, height] of [[1280, 900], [768, 900], [390, 844]] as const) {
    await browser.manage().window().setRect({ width, height });
    const horizontalOverflow: number = await browser.executeScript<number>(
      "return Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);",
    );
    assert.equal(horizontalOverflow, 0, `horizontal overflow at ${String(width)}px`);
  }
  const errors = await browser.executeScript<readonly string[]>(
    "return window.__recoveryDemoErrors || [];",
  );
  assert.deepEqual(errors, []);
  process.stdout.write("Recovery demonstration browser smoke passed on port 4177.\n");
} finally {
  await browser?.quit();
  await running.close();
  rmSync(directory, { recursive: true, force: true });
}

async function exercise(
  browser: WebDriver,
  boundary: "after_execution_fence_before_factory_mutation" | "after_factory_commit_before_m2_binding",
): Promise<void> {
  await browser.findElement(By.css(`input[value="${boundary}"]`)).click();
  await browser.findElement(By.id("interrupt-button")).click();
  await waitStage(browser, "interrupted");
  assert.equal(await focusedStageTitle(browser), true);
  await browser.findElement(By.id("restart-button")).click();
  await waitStage(browser, "restarted");
  assert.equal(await focusedStageTitle(browser), true);
  await browser.findElement(By.id("recover-button")).click();
  await waitStage(browser, "verified");
  assert.equal(await focusedStageTitle(browser), true);
  assert.equal(await browser.findElement(By.id("after-mutations")).getText(), "1");
  assert.equal(await browser.findElement(By.id("after-receipts")).getText(), "1");
  assert.equal(await browser.findElement(By.id("after-terminals")).getText(), "1");
  assert.equal(await browser.findElement(By.id("after-actuals")).getText(), "2");
  await browser.findElement(By.id("replay-button")).click();
  await waitStage(browser, "replayed");
  assert.equal(await focusedStageTitle(browser), true);
  assert.match(await browser.findElement(By.id("replay-proof")).getText(), /digest did not change/u);
}

async function waitStage(browser: WebDriver, stage: string): Promise<void> {
  await browser.wait(
    async () => (await browser.findElement(By.id("stage-pill")).getText()).toLowerCase() === stage,
    10_000,
  );
}

async function focusedStageTitle(browser: WebDriver): Promise<boolean> {
  return await browser.executeScript<boolean>(
    "return document.activeElement === document.getElementById('stage-title');",
  );
}
