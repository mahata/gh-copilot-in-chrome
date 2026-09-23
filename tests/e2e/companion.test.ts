import { chromium, expect, test } from "@playwright/test";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const unsavableToken = `github_pat_NOSAVE${"F".repeat(76)}`;

type OpenPanel = {
  context: BrowserContext;
  page: Page;
  worker: Worker;
  networkRequests: string[];
  dialogs: string[];
  runningCompanions: () => string[];
  installCompanion: () => Promise<void>;
  openAnotherPanel: () => Promise<Page>;
  savedToken: () => string | undefined;
  removeSavedTokenOutsidePanel: () => void;
};

type PanelSetup = { withCompanion?: boolean; savedToken?: string };

let cleanUp: (() => Promise<void>) | undefined;

async function openPanel({ withCompanion = true, savedToken }: PanelSetup = {}): Promise<OpenPanel> {
  const home = mkdtempSync(join(tmpdir(), "panel-e2e-home-"));
  const companionStateDirectory = join(home, "running-companions");
  mkdirSync(companionStateDirectory);
  const keychainPath = join(home, "fake-keychain");
  if (savedToken !== undefined) writeFileSync(keychainPath, savedToken);
  const installCompanion = async () => {
    await runInstaller({
      args: [],
      platform: "darwin",
      home,
      nodePath: process.execPath,
      companionEntryPath: fakeCompanionPath,
      store: { forgetToken: async () => false },
      output: { log: () => {}, error: () => {} },
    });
  };
  if (withCompanion) await installCompanion();

  const chromeUserDataDirectory = join(home, "Library", "Application Support", "Google", "Chrome");
  const context = await chromium.launchPersistentContext(chromeUserDataDirectory, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    env: { ...process.env, FAKE_COMPANION_STATE_DIR: companionStateDirectory, FAKE_KEYCHAIN_PATH: keychainPath },
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
  const dialogs: string[] = [];
  const openAnotherPanel = async () => {
    const panelPage = await context.newPage();
    panelPage.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await panelPage.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
    return panelPage;
  };
  const page = await openAnotherPanel();
  return {
    context,
    page,
    worker,
    networkRequests,
    dialogs,
    runningCompanions: () => readdirSync(companionStateDirectory),
    installCompanion,
    openAnotherPanel,
    savedToken: () => (existsSync(keychainPath) ? readFileSync(keychainPath, "utf8") : undefined),
    removeSavedTokenOutsidePanel: () => rmSync(keychainPath, { force: true }),
  };
}

async function connect(page: Page, token = approvedToken, { remember = true } = {}) {
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await page.getByLabel("Fine-grained PAT", { exact: true }).fill(token);
  await page.getByLabel("Remember this PAT").setChecked(remember);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
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
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();

  await installCompanion();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.getByRole("button", { name: "Check again" })).toBeHidden();
  expect(networkRequests).toEqual([]);
});

test("connects with the saved PAT once Check again finds the companion", async () => {
  const { page, installCompanion } = await openPanel({ withCompanion: false, savedToken: approvedToken });
  await expect(page.getByRole("alert")).toContainText("companion_not_installed");

  await installCompanion();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
});

test("connects through the companion and renders the approved reply as inert text", async () => {
  const { page, networkRequests, dialogs } = await openPanel();
  await expect(page.getByRole("status")).toContainText(/Companion ready \(Copilot SDK fake-\d+\)/);
  await expect(page.getByText("No prompt is sent.")).toBeVisible();
  const connectButton = page.getByRole("button", { name: "Connect", exact: true });
  await expect(connectButton).toBeDisabled();
  await page.getByLabel("Fine-grained PAT", { exact: true }).fill(approvedToken);
  await connectButton.click();

  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await expect(page.getByLabel("Fine-grained PAT", { exact: true })).toHaveValue("");
  await expect(connectButton).toBeDisabled();
  await expect(page.getByLabel("Model", { exact: true }).locator("option")).toHaveText([
    "Choose a model",
    "Fake reply (billing multiplier 0×)",
    "Fake slow reply (billing multiplier 1×)",
    "Fake quota failure (billing multiplier 0.33×)",
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

test("remembers an accepted PAT in the Keychain and connects with it when the panel opens again", async () => {
  const { page, openAnotherPanel, savedToken, runningCompanions, networkRequests } = await openPanel();
  await expect(page.getByLabel("Remember this PAT")).toBeChecked();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await expect(page.getByText("A PAT is saved in your macOS login keychain")).toBeVisible();
  expect(savedToken()).toBe(approvedToken);
  await expect(page.locator("body")).not.toContainText(approvedToken);

  await page.close();
  await expect.poll(runningCompanions).toEqual([]);
  const reopened = await openAnotherPanel();
  await expect(reopened.getByRole("status")).toContainText("Connected as octocat");
  await expect(reopened.getByLabel("Fine-grained PAT", { exact: true })).toHaveValue("");
  await expect(reopened.getByRole("button", { name: "Connect with saved PAT" })).toBeDisabled();
  await expect(reopened.getByRole("button", { name: "Forget saved PAT" })).toBeEnabled();
  expect(networkRequests).toEqual([]);
});

test("keeps the PAT only in memory when Remember is unchecked", async () => {
  const { page, openAnotherPanel, savedToken, runningCompanions } = await openPanel();
  await connect(page, approvedToken, { remember: false });
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await expect(page.getByRole("button", { name: "Forget saved PAT" })).toBeHidden();

  await page.close();
  await expect.poll(runningCompanions).toEqual([]);
  expect(savedToken()).toBeUndefined();
  const reopened = await openAnotherPanel();
  await expect(reopened.getByRole("status")).toContainText("Companion ready");
  await expect(reopened.getByRole("button", { name: "Connect with saved PAT" })).toBeHidden();
});

test("forgets the saved PAT and stays connected until Disconnect", async () => {
  const { page, savedToken } = await openPanel({ savedToken: approvedToken });
  await expect(page.getByRole("status")).toContainText("Connected as octocat");

  await page.getByRole("button", { name: "Forget saved PAT" }).click();
  await expect(page.getByRole("button", { name: "Forget saved PAT" })).toBeHidden();
  await expect(page.getByText("A PAT is saved in your macOS login keychain")).toBeHidden();
  expect(savedToken()).toBeUndefined();
  await expect(page.getByRole("status")).toContainText("Connected as octocat");

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await expect(page.getByRole("button", { name: "Connect with saved PAT" })).toBeHidden();
});

test("explains a saved PAT that GitHub rejects and replaces it with a new one", async () => {
  const { page, savedToken } = await openPanel({ savedToken: deniedToken });
  await expect(page.getByRole("alert")).toContainText("GitHub did not accept the saved PAT");
  await expect(page.getByRole("alert")).toContainText("auth_failed");
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await expect(page.locator("body")).not.toContainText(deniedToken);

  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await expect(page.getByRole("alert")).toBeHidden();
  await expect.poll(savedToken).toBe(approvedToken);
});

test("asks for a PAT when the saved one disappeared from the Keychain", async () => {
  const { page, removeSavedTokenOutsidePanel } = await openPanel({ savedToken: approvedToken });
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("status")).toContainText("Companion ready");

  removeSavedTokenOutsidePanel();
  await page.getByRole("button", { name: "Connect with saved PAT" }).click();
  await expect(page.getByRole("alert")).toContainText("no_saved_token");
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await expect(page.getByRole("button", { name: "Connect with saved PAT" })).toBeHidden();
});

test("stays connected and says so when the Keychain refuses to save the PAT", async () => {
  const { page, savedToken } = await openPanel();
  await connect(page, unsavableToken);

  await expect(page.getByRole("alert")).toContainText("save_failed");
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await expect(page.getByRole("button", { name: "Forget saved PAT" })).toBeHidden();
  expect(savedToken()).toBeUndefined();
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

test("disconnecting starts a fresh companion that waits for Connect with saved PAT", async () => {
  const { page, runningCompanions } = await openPanel({ savedToken: approvedToken });
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await sendTestPrompt(page, "fake-reply");
  await expect(page.getByRole("status")).toContainText("Response complete");
  expect(runningCompanions()).toHaveLength(1);
  const [connectedCompanion] = runningCompanions();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await expect.poll(runningCompanions).toHaveLength(1);
  expect(runningCompanions()).not.toContain(connectedCompanion);
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeHidden();
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Response output")).toHaveText("No response yet.");
  await expect(page.getByText("SDK usage report")).toBeHidden();

  await page.getByRole("button", { name: "Connect with saved PAT" }).click();
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
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
