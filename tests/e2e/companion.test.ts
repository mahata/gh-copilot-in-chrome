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
const inertMarkup = '<img src="x" onerror="alert(1)">';

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

async function sendPrompt(page: Page, prompt: string) {
  await page.getByLabel("Prompt", { exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

function conversationLog(page: Page) {
  return page.getByRole("log", { name: "Conversation" });
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

test("chats through the companion with the cheapest model preselected and renders both sides as inert text", async () => {
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
  const modelSelect = page.getByLabel("Model", { exact: true });
  await expect(modelSelect.locator("option")).toHaveText([
    "Fake other reply (billing multiplier 1×)",
    "Fake reply (billing multiplier 0×)",
    "Fake slow reply (billing multiplier 1×)",
    "Fake quota failure (billing multiplier 0.33×)",
    "Fake crash (billing multiplier 1×)",
  ]);
  await expect(modelSelect).toHaveValue("fake-reply");
  const conversation = conversationLog(page);
  await expect(conversation).toHaveText("No messages yet.");
  const sendButton = page.getByRole("button", { name: "Send", exact: true });
  const newChatButton = page.getByRole("button", { name: "New chat", exact: true });
  await expect(sendButton).toBeDisabled();
  await expect(newChatButton).toBeDisabled();

  const prompt = "Explain <b>bold</b> & <i>italic</i> tags.";
  await sendPrompt(page, prompt);
  await expect(page.getByRole("status")).toContainText("Response complete");
  await expect(conversation.getByText("You", { exact: true })).toBeVisible();
  await expect(conversation.locator(".prompt-text")).toHaveText(prompt);
  await expect(conversation.getByText("Copilot (Fake reply)", { exact: true })).toBeVisible();
  await expect(conversation.locator(".reply")).toHaveText(`Reply 1 (fake-reply) to: ${prompt} 日本語 ${inertMarkup}`);
  await expect(conversation.getByText("SDK usage report: fake-reply, billing multiplier 0×.")).toBeVisible();
  await expect(page.locator("img")).toHaveCount(0);
  await expect(conversation.locator("b, i")).toHaveCount(0);
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Prompt", { exact: true })).toBeFocused();
  await expect(sendButton).toBeDisabled();
  await expect(newChatButton).toBeEnabled();
  expect(dialogs).toEqual([]);
  expect(networkRequests).toEqual([]);
});

test("keeps the conversation across turns and model changes until New chat starts over", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  const conversation = conversationLog(page);
  const replies = conversation.locator(".reply");
  const newChatButton = page.getByRole("button", { name: "New chat", exact: true });

  await sendPrompt(page, "First question");
  await expect(page.getByRole("status")).toContainText("Response complete");
  await sendPrompt(page, "Second question");
  await expect(page.getByRole("status")).toContainText("Response complete");
  await page.getByLabel("Model", { exact: true }).selectOption("fake-other");
  await sendPrompt(page, "Third question");
  await expect(page.getByRole("status")).toContainText("Response complete");

  await expect(conversation.getByRole("article")).toHaveCount(3);
  await expect(replies).toHaveText([
    /^Reply 1 \(fake-reply\) to: First question/,
    /^Reply 2 \(fake-reply\) to: Second question/,
    /^Reply 3 \(fake-other\) to: Third question/,
  ]);
  await expect(conversation.getByText("Copilot (Fake other reply)", { exact: true })).toBeVisible();

  await newChatButton.click();
  await expect(page.getByRole("status")).toHaveText("New chat started. Copilot no longer sees the earlier messages.");
  await expect(conversation).toHaveText("No messages yet.");
  await expect(newChatButton).toBeDisabled();
  await expect(page.getByLabel("Prompt", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("fake-other");

  await sendPrompt(page, "Fresh question");
  await expect(page.getByRole("status")).toContainText("Response complete");
  await expect(replies).toHaveText([/^Reply 1 \(fake-other\) to: Fresh question/]);
});

test("sends with Command or Control Enter, keeps Enter for new lines, and ignores blank prompts", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  const promptInput = page.getByLabel("Prompt", { exact: true });
  const sendButton = page.getByRole("button", { name: "Send", exact: true });
  const conversation = conversationLog(page);
  await promptInput.evaluate((textarea: HTMLTextAreaElement) =>
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter") textarea.dataset.lastEnter = event.defaultPrevented ? "consumed" : "typed";
    }),
  );

  await promptInput.fill(" \n\t ");
  await expect(sendButton).toBeDisabled();
  await promptInput.press("Meta+Enter");
  await promptInput.press("Control+Enter");
  await expect(promptInput).toHaveValue(" \n\t ");
  await expect(promptInput).toHaveAttribute("data-last-enter", "consumed");
  await expect(conversation).toHaveText("No messages yet.");

  const prompt = "  Keep this indentation\nand this second line";
  await promptInput.fill("  Keep this indentation");
  await promptInput.press("Enter");
  await expect(promptInput).toHaveAttribute("data-last-enter", "typed");
  await promptInput.pressSequentially("and this second line");
  await expect(promptInput).toHaveValue(prompt);
  await promptInput.press("Control+Enter");
  await expect(promptInput).toHaveAttribute("data-last-enter", "consumed");
  await expect(page.getByRole("status")).toContainText("Response complete");
  await expect(promptInput).toHaveValue("");
  await expect(conversation.locator(".prompt-text")).toHaveJSProperty("textContent", prompt);
  await expect(conversation.locator(".reply")).toHaveJSProperty(
    "textContent",
    `Reply 1 (fake-reply) to: ${prompt} 日本語 ${inertMarkup}`,
  );

  await promptInput.fill("Now with Command");
  await promptInput.press("Meta+Enter");
  await expect(page.getByRole("status")).toContainText("Response complete");
  await expect(promptInput).toHaveValue("");
  await expect(conversation.locator(".reply").last()).toContainText("Reply 2 (fake-reply) to: Now with Command");
});

test("waits for an input method to finish composing before Command or Control Enter sends", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  const promptInput = page.getByLabel("Prompt", { exact: true });
  const conversation = conversationLog(page);
  const inputMethod = await page.context().newCDPSession(page);

  await promptInput.focus();
  await inputMethod.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await promptInput.press("ControlOrMeta+Enter");
  await expect(conversation).toHaveText("No messages yet.");

  await inputMethod.send("Input.insertText", { text: "日本語" });
  await expect(promptInput).toHaveValue("日本語");
  await promptInput.press("ControlOrMeta+Enter");
  await expect(conversation.locator(".prompt-text")).toHaveText("日本語");
});

test("follows a streaming reply only while the reader stays at the end of the conversation", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  const conversation = conversationLog(page);

  await sendPrompt(page, "Answer at length.\n".repeat(60));
  await expect(page.getByRole("status")).toContainText("Response complete");
  expect(await conversation.evaluate((log) => log.scrollHeight - log.scrollTop - log.clientHeight)).toBeLessThanOrEqual(1);

  await page.getByLabel("Model", { exact: true }).selectOption("fake-slow");
  await sendPrompt(page, "Take your time.");
  await expect(conversation.locator(".reply").last()).toHaveText("Partial reply");
  await conversation.evaluate((log) => log.scrollTo({ top: 0 }));
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(conversation.locator(".turn-note").last()).toHaveText("Stopped. Output may be incomplete.");
  expect(await conversation.evaluate((log) => log.scrollTop)).toBe(0);
});

test("explains a prompt over the length limit and refuses to send it", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  const promptInput = page.getByLabel("Prompt", { exact: true });
  const sendButton = page.getByRole("button", { name: "Send", exact: true });
  const shortcutHint = "⌘ Enter or Ctrl Enter sends. Enter starts a new line.";
  const limitNotice = page.getByText("This prompt is 32,769 characters. Shorten it to 32,768 or fewer to send.");

  await promptInput.fill("x".repeat(32_769));
  await expect(limitNotice).toBeVisible();
  await expect(promptInput).toHaveAccessibleDescription(/Shorten it to 32,768 or fewer to send\.$/);
  await expect(sendButton).toBeDisabled();
  await promptInput.press("ControlOrMeta+Enter");
  await expect(conversationLog(page)).toHaveText("No messages yet.");

  await promptInput.press("Backspace");
  await expect(limitNotice).toBeHidden();
  await expect(promptInput).toHaveAccessibleDescription(shortcutHint);
  await expect(sendButton).toBeEnabled();
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
  await expect(page.getByLabel("Prompt", { exact: true })).toBeDisabled();
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
  await expect(page.getByLabel("Prompt", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});

test("stops a streaming reply, marks it incomplete, and keeps the prompt drafted meanwhile", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await page.getByLabel("Model", { exact: true }).selectOption("fake-slow");
  await sendPrompt(page, "Take your time.");
  const conversation = conversationLog(page);
  const sendButton = page.getByRole("button", { name: "Send", exact: true });
  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(conversation.locator(".reply")).toHaveText("Partial reply");
  await expect(conversation).toHaveAttribute("aria-busy", "true");
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeDisabled();

  await page.getByLabel("Prompt", { exact: true }).fill("Next question");
  await expect(sendButton).toBeDisabled();
  await stopButton.click();

  await expect(page.getByRole("status")).toContainText("Stopped. Output may be incomplete.");
  await expect(conversation.locator(".turn-note")).toHaveText("Stopped. Output may be incomplete.");
  await expect(conversation.locator(".reply")).toHaveText("Partial reply");
  await expect(conversation).toHaveAttribute("aria-busy", "false");
  await expect(stopButton).toBeDisabled();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("Next question");
  await expect(sendButton).toBeEnabled();
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeEnabled();
});

test("marks a failed request in the conversation and keeps the connection", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await page.getByLabel("Model", { exact: true }).selectOption("fake-quota");
  await sendPrompt(page, "Use the costly model.");

  await expect(page.getByRole("alert")).toContainText("quota_exceeded");
  await expect(page.getByRole("status")).toContainText("You are still connected.");
  const conversation = conversationLog(page);
  await expect(conversation.locator(".turn-note")).toHaveText("The request did not finish (quota_exceeded).");
  await expect(conversation.locator(".reply")).toBeEmpty();
  await expect(page.getByLabel("Model", { exact: true })).toBeEnabled();

  await page.getByLabel("Model", { exact: true }).selectOption("fake-reply");
  await sendPrompt(page, "Use the free model.");
  await expect(page.getByRole("status")).toContainText("Response complete");
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(conversation.getByRole("article")).toHaveCount(2);
});

test("recovers after the companion exits while connecting", async () => {
  const { page } = await openPanel();
  await connect(page, crashingToken);

  await expect(page.getByRole("alert")).toContainText("companion_exited");
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status")).toContainText("Companion ready");
});

test("keeps an interrupted reply visible when the companion exits mid-response, then reconnects", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await page.getByLabel("Model", { exact: true }).selectOption("fake-crash");
  await sendPrompt(page, "Crash while replying.");

  await expect(page.getByRole("alert")).toContainText("companion_exited");
  const conversation = conversationLog(page);
  await expect(conversation.locator(".reply")).toHaveText("Partial reply");
  await expect(conversation.locator(".turn-note")).toHaveText("The companion stopped before the response finished.");
  await expect(conversation).toHaveAttribute("aria-busy", "false");
  await expect(page.getByLabel("Prompt", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await expect(conversation).toHaveText("No messages yet.");
});

test("disconnecting clears the conversation and starts a fresh companion that waits for Connect with saved PAT", async () => {
  const { page, runningCompanions } = await openPanel({ savedToken: approvedToken });
  await expect(page.getByRole("status")).toContainText("Connected as octocat");
  await sendPrompt(page, "Remember this conversation?");
  await expect(page.getByRole("status")).toContainText("Response complete");
  await page.getByLabel("Prompt", { exact: true }).fill("An unsent draft");
  expect(runningCompanions()).toHaveLength(1);
  const [connectedCompanion] = runningCompanions();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("status")).toContainText("Companion ready");
  await expect.poll(runningCompanions).toHaveLength(1);
  expect(runningCompanions()).not.toContain(connectedCompanion);
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeHidden();
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Prompt", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("");
  await expect(conversationLog(page)).toHaveText("No messages yet.");

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
  await sendPrompt(page, `Wrap ${"unbroken".repeat(40)} text.`);
  await expect(page.getByRole("status")).toContainText("Response complete");
  const conversation = conversationLog(page);
  for (const width of [320, 720]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await conversation.evaluate((log) => log.scrollWidth <= log.clientWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `test-results/panel-${width}.png`, fullPage: true });
  }
});
