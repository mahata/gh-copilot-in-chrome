import { chromium, expect, test } from "@playwright/test";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInstaller } from "../../src/companion/install.ts";
import { EXTENSION_ID } from "../../src/protocol/identity.ts";

const extensionPath = resolve("dist");
const fakeCompanionPath = resolve("tests/e2e/fake-companion.ts");
const approvedToken = `github_pat_${"A".repeat(82)}`;
const deniedToken = `github_pat_DENIED${"B".repeat(76)}`;
const crashingToken = `github_pat_CRASH${"C".repeat(77)}`;
const tokenWithoutModels = `github_pat_NOMODELS${"D".repeat(74)}`;

type OpenPanel = {
  context: BrowserContext;
  page: Page;
  worker: Worker;
  networkRequests: string[];
  dialogs: string[];
  runningCompanions: () => string[];
  installCompanion: () => Promise<void>;
};

let cleanUp: (() => Promise<void>) | undefined;

async function openPanel({ withCompanion = true } = {}): Promise<OpenPanel> {
  const home = mkdtempSync(join(tmpdir(), "panel-e2e-home-"));
  const companionStateDirectory = join(home, "running-companions");
  mkdirSync(companionStateDirectory);
  const installCompanion = async () => {
    await runInstaller({
      args: [],
      platform: "darwin",
      home,
      nodePath: process.execPath,
      companionEntryPath: fakeCompanionPath,
      output: { log: () => {}, error: () => {} },
    });
  };
  if (withCompanion) await installCompanion();

  const chromeUserDataDirectory = join(home, "Library", "Application Support", "Google", "Chrome");
  const context = await chromium.launchPersistentContext(chromeUserDataDirectory, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    env: { ...process.env, FAKE_COMPANION_STATE_DIR: companionStateDirectory },
  });
  cleanUp = async () => {
    await context.close();
    rmSync(home, { recursive: true, force: true });
  };

  const networkRequests: string[] = [];
  await context.route(/^https?:/, async (route) => {
    networkRequests.push(route.request().url());
    await route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  return {
    context,
    page,
    worker,
    networkRequests,
    dialogs,
    runningCompanions: () => readdirSync(companionStateDirectory),
    installCompanion,
  };
}

async function connect(page: Page, token = approvedToken) {
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await page.getByLabel("Fine-grained PAT", { exact: true }).fill(token);
  await page.getByLabel("I authorize the local companion").check();
  await page.getByRole("button", { name: "Connect (live)" }).click();
}

async function sendTestPrompt(page: Page, modelId: string) {
  await page.getByLabel("Model", { exact: true }).selectOption(modelId);
  await page.getByLabel("I approve one live request").check();
  await page.getByRole("button", { name: "Send test prompt (live)" }).click();
}

test.afterEach(async () => {
  await cleanUp?.();
  cleanUp = undefined;
});

test("explains how to install a missing companion, then finds it after installation", async () => {
  const { page, networkRequests, installCompanion } = await openPanel({ withCompanion: false });
  await expect(page.getByRole("alert")).toContainText("npm run companion:install");
  await expect(page.getByRole("alert")).toContainText("companion_not_installed");
  await expect(page.getByRole("button", { name: "Connect (live)" })).toBeDisabled();

  await installCompanion();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.getByRole("button", { name: "Check again" })).toBeHidden();
  expect(networkRequests).toEqual([]);
});

test("connects through the companion and renders the approved reply as inert text", async () => {
  const { page, networkRequests, dialogs } = await openPanel();
  await expect(page.getByRole("status")).toContainText(/Companion ready \(Copilot SDK fake-\d+\)/);
  const connectButton = page.getByRole("button", { name: "Connect (live)" });
  await expect(connectButton).toBeDisabled();
  await page.getByLabel("Fine-grained PAT", { exact: true }).fill(approvedToken);
  await expect(connectButton).toBeDisabled();
  await page.getByLabel("I authorize the local companion").check();
  await connectButton.click();

  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await expect(page.getByLabel("Fine-grained PAT", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("I authorize the local companion")).not.toBeChecked();
  await expect(page.getByLabel("Model", { exact: true }).locator("option")).toHaveText([
    "Choose a model",
    "Fake reply (0× premium requests)",
    "Fake slow reply (1× premium requests)",
    "Fake quota failure (0.33× premium requests)",
  ]);
  await expect(page.getByText("Reply with exactly: Connection confirmed.", { exact: true })).toBeVisible();

  const sendButton = page.getByRole("button", { name: "Send test prompt (live)" });
  await page.getByLabel("Model", { exact: true }).selectOption("fake-reply");
  await expect(sendButton).toBeDisabled();
  await page.getByLabel("I approve one live request").check();
  await sendButton.click();

  await expect(page.getByRole("status")).toContainText("Response complete");
  await expect(page.getByLabel("Response output")).toHaveText('Connection confirmed. 日本語 <img src="x" onerror="alert(1)">');
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.getByText("SDK usage report")).toContainText("fake-reply");
  await expect(page.getByLabel("I approve one live request")).not.toBeChecked();
  await expect(sendButton).toBeDisabled();
  expect(dialogs).toEqual([]);
  expect(networkRequests).toEqual([]);
});

test("reports a rejected token without reflecting it and allows another attempt", async () => {
  const { page } = await openPanel();
  await connect(page, deniedToken);

  await expect(page.getByRole("alert")).toContainText("auth_failed");
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await expect(page.locator("body")).not.toContainText(deniedToken);
  await expect(page.getByRole("button", { name: "Send test prompt (live)" })).toBeDisabled();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await expect(page.getByRole("alert")).toBeHidden();
});

test("accepts only fine-grained PATs and never forwards other tokens", async () => {
  const { page, runningCompanions } = await openPanel();
  await expect(page.getByRole("status")).toContainText("Companion ready");
  const companionsBeforeRejection = runningCompanions();
  expect(companionsBeforeRejection).toHaveLength(1);
  await connect(page, "ghp_classicPersonalAccessToken");

  await expect(page.getByRole("alert")).toContainText("github_pat_");
  await expect(page.getByLabel("Fine-grained PAT", { exact: true })).toHaveValue("");
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  expect(runningCompanions()).toEqual(companionsBeforeRejection);
});

test("says so when the account has no enabled models", async () => {
  const { page } = await openPanel();
  await connect(page, tokenWithoutModels);

  await expect(page.getByRole("status")).toContainText("no enabled models");
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Model", { exact: true }).locator("option")).toHaveText(["No enabled models were returned"]);
  await expect(page.getByRole("button", { name: "Send test prompt (live)" })).toBeDisabled();
});

test("stops a streaming reply and keeps the partial output marked incomplete", async () => {
  const { page } = await openPanel();
  await connect(page);
  await sendTestPrompt(page, "fake-slow");
  await expect(page.getByLabel("Response output")).toContainText("Partial reply");

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Stopped. Output may be incomplete.");
  await expect(page.getByLabel("Response output")).toContainText("Partial reply");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Model", { exact: true })).toBeEnabled();
});

test("reports a failed request and keeps the connection", async () => {
  const { page } = await openPanel();
  await connect(page);
  await sendTestPrompt(page, "fake-quota");

  await expect(page.getByRole("alert")).toContainText("quota_exceeded");
  await expect(page.getByLabel("Model", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send test prompt (live)" })).toBeDisabled();
});

test("recovers after the companion exits unexpectedly", async () => {
  const { page } = await openPanel();
  await connect(page, crashingToken);

  await expect(page.getByRole("alert")).toContainText("companion_exited");
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status")).toContainText("Companion ready");
});

test("clearing ends the companion and starts a fresh one without credentials", async () => {
  const { page, runningCompanions } = await openPanel();
  await connect(page);
  await sendTestPrompt(page, "fake-reply");
  await expect(page.getByRole("status")).toContainText("Response complete");
  expect(runningCompanions()).toHaveLength(1);
  const [connectedCompanion] = runningCompanions();

  await page.getByRole("button", { name: "Clear credentials and output" }).click();
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await expect.poll(runningCompanions).toHaveLength(1);
  expect(runningCompanions()).not.toContain(connectedCompanion);
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Response output")).toHaveText("No response yet.");
  await expect(page.getByText("SDK usage report")).toBeHidden();
});

test("closing the panel ends the companion", async () => {
  const { page, runningCompanions } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");

  await page.close();
  await expect.poll(runningCompanions).toEqual([]);
});

test("asks only for the side panel and native messaging and blocks network access", async () => {
  const { page, worker, networkRequests } = await openPanel();
  expect(new URL(worker.url()).host).toBe(EXTENSION_ID);
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toEqual(["sidePanel", "nativeMessaging"]);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.optional_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.externally_connectable).toBeUndefined();
  expect(manifest.content_security_policy).toEqual({ extension_pages: expect.stringContaining("connect-src 'none'") });

  const fetchResult = await page.evaluate(() => fetch("https://api.github.com/").then(() => "fetched", () => "blocked"));
  expect(fetchResult).toBe("blocked");
  expect(networkRequests).toEqual([]);
  const storage = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
  expect(storage).toEqual({ local: [], session: [] });
});

test("fits a narrow sidebar and a wider extension page", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  for (const width of [320, 720]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/panel-${width}.png`, fullPage: true });
  }
});
