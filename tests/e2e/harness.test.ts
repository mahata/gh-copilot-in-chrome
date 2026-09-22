import { chromium, expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { resolve } from "node:path";
import { apiOrigin, delta, done, exchange, model, testPat } from "../fixtures/copilot";

let context: BrowserContext;
let page: Page;
let extensionId: string;
let calls: Array<{ url: string; headers: Record<string, string>; body: string | null }>;

test.beforeEach(async () => {
  const path = resolve("dist");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
  calls = [];
  await context.route(/^https?:/, async (route) => {
    const request = route.request();
    calls.push({ url: request.url(), headers: request.headers(), body: request.postData() });
    await route.abort();
  });
  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
});

test.afterEach(async () => {
  await context?.close();
});

test("starts without network access; offline demonstration is clearly synthetic", async () => {
  await expect(page.getByRole("heading", { name: "Connection experiment" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check PAT (live)" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send test prompt (live)" })).toBeDisabled();
  await page.getByRole("button", { name: "Run offline demo" }).click();
  await expect(page.getByRole("status")).toContainText("Offline demo complete");
  await expect(page.getByLabel("Response output")).toContainText("日本語");
  await expect(page.getByLabel("Response output")).toContainText("Synthetic");
  expect(calls).toEqual([]);
  await expect(page.getByRole("button", { name: "Send test prompt (live)" })).toBeDisabled();
});

test("requires distinct live approvals and renders model output as text", async () => {
  await context.unroute(/^https?:/);
  await context.route(/^https?:/, async (route) => {
    const request = route.request();
    calls.push({ url: request.url(), headers: request.headers(), body: request.postData() });
    if (request.url() === "https://api.github.com/copilot_internal/v2/token") {
      await route.fulfill({ json: exchange() });
    } else if (request.url() === `${apiOrigin}/models`) {
      await route.fulfill({ json: { data: [model()] } });
    } else if (request.url() === `${apiOrigin}/chat/completions`) {
      await route.fulfill({
        contentType: "text/event-stream",
        body: delta('<img src="https://attacker.example/track"> 日本語') + done,
      });
    } else {
      await route.abort();
    }
  });
  await page.getByLabel("Fine-grained PAT", { exact: true }).fill(testPat);
  await expect(page.getByRole("button", { name: "Check PAT (live)" })).toBeDisabled();
  await page.getByLabel("I authorize sending this PAT").check();
  await page.getByRole("button", { name: "Check PAT (live)" }).click();
  await expect(page.getByRole("status")).toContainText("Discovery succeeded");
  await expect(page.getByLabel("Fine-grained PAT", { exact: true })).toHaveValue("");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.headers.authorization).toBe(`token ${testPat}`);
  expect(JSON.stringify(calls.slice(1))).not.toContain(testPat);
  await page.getByLabel("Enabled Chat Completions model").selectOption("fixture-chat");
  await expect(page.getByRole("button", { name: "Send test prompt (live)" })).toBeDisabled();
  await page.getByLabel("I approve one live inference request").check();
  await page.getByRole("button", { name: "Send test prompt (live)" }).click();
  await expect(page.getByRole("status")).toContainText("Live response complete");
  await expect(page.getByLabel("Response output")).toContainText("<img");
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.getByLabel("I approve one live inference request")).not.toBeChecked();
  expect(calls).toHaveLength(3);
  expect(JSON.stringify(calls[2]?.body)).not.toContain(testPat);
  await page.getByRole("button", { name: "Clear credentials and output" }).click();
  await expect(page.getByRole("status")).toContainText("Cleared");
  await expect(page.getByRole("button", { name: "Send test prompt (live)" })).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Fine-grained PAT", { exact: true })).toHaveValue("");
  expect(calls).toHaveLength(3);
});

test("does not register untrusted bridges or permission to capture pages", async () => {
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toEqual(["sidePanel"]);
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.externally_connectable).toBeUndefined();
  expect(manifest.host_permissions).toHaveLength(4);
  expect(manifest.host_permissions).not.toContain("<all_urls>");
  const storage = await page.evaluate(() => ({
    local: Object.keys(localStorage), session: Object.keys(sessionStorage),
  }));
  expect(storage).toEqual({ local: [], session: [] });
});

test("can stop an in-flight demo and start a fresh one without late output", async () => {
  await page.getByRole("button", { name: "Run offline demo" }).click();
  await expect(page.getByLabel("Response output")).toContainText("Synthetic");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Stopped");
  await page.getByRole("button", { name: "Clear credentials and output" }).click();
  await expect(page.getByLabel("Response output")).toHaveText("No response yet.");
  await page.getByRole("button", { name: "Run offline demo" }).click();
  await expect(page.getByRole("status")).toContainText("Offline demo complete");
  await expect(page.getByLabel("Response output")).toHaveText(
    "Synthetic response. 日本語 streams correctly. No network request was made.",
  );
  expect(calls).toEqual([]);
});

test("shows an actionable rejection without reflecting secrets", async () => {
  await context.unroute(/^https?:/);
  await context.route(/^https?:/, (route) => route.fulfill({ status: 403, body: testPat }));
  await page.getByLabel("Fine-grained PAT", { exact: true }).fill(testPat);
  await page.getByLabel("I authorize sending this PAT").check();
  await page.getByRole("button", { name: "Check PAT (live)" }).click();
  await expect(page.getByRole("alert")).toContainText("Access was denied");
  await expect(page.locator("body")).not.toContainText(testPat);
  await expect(page.getByRole("button", { name: "Send test prompt (live)" })).toBeDisabled();
});

test("fits a narrow sidebar and a wider extension page", async () => {
  for (const width of [320, 720]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/harness-${width}.png`, fullPage: true });
  }
});
