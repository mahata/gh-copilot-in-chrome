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
const unsavableTokenWithoutModels = `github_pat_NOMODELSNOSAVE${"L".repeat(68)}`;
const heldTokenWithoutModels = `github_pat_NOMODELSHOLD${"K".repeat(70)}`;
const undeletableToken = `github_pat_NOFORGET${"G".repeat(74)}`;
const unreadableToken = `github_pat_LOCKED${"H".repeat(76)}`;
const vanishingToken = `github_pat_VANISH${"J".repeat(76)}`;
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
  saveTokenOutsidePanel: (token: string) => void;
  releaseHeldKeychainTask: () => void;
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
    saveTokenOutsidePanel: (token) => writeFileSync(keychainPath, token),
    releaseHeldKeychainTask: () => writeFileSync(`${keychainPath}.release`, ""),
  };
}

const PAT_EXPLANATION = "Copilot needs a fine-grained PAT with the Copilot Requests permission to sign in as you.";

function patField(page: Page) {
  return page.getByLabel(PAT_EXPLANATION);
}

function promptField(page: Page) {
  return page.getByLabel("Prompt", { exact: true });
}

function conversationLog(page: Page) {
  return page.getByRole("log", { name: "Conversation", includeHidden: true });
}

function chatView(page: Page) {
  return page.getByRole("region", { name: "Chat", includeHidden: true });
}

function button(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

async function connect(page: Page, token = approvedToken) {
  await expect(patField(page)).toBeEnabled();
  await patField(page).fill(token);
  await button(page, "Connect").click();
}

async function sendPrompt(page: Page, prompt: string) {
  await promptField(page).fill(prompt);
  await button(page, "Send").click();
}

async function expectReplyFinished(page: Page) {
  await expect(conversationLog(page)).toHaveAttribute("aria-busy", "false");
  await expect(button(page, "Send")).toBeVisible();
}

function markPatFormIfShown() {
  addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("auth-form");
    if (form === null) return;
    new MutationObserver(() => {
      if (!form.hidden) form.dataset.shown = "";
    }).observe(form, { attributeFilter: ["hidden"] });
  });
}

test.afterEach(async () => {
  await cleanUp?.();
  cleanUp = undefined;
});

test("explains how to install a missing companion, then finds it after installation", async () => {
  const { page, networkRequests, installCompanion } = await openPanel({ withCompanion: false });
  await expect(page.getByRole("alert")).toContainText("pnpm companion:install");
  await expect(page.getByRole("alert")).toContainText("companion_not_installed");
  await expect(patField(page)).toBeHidden();
  const tryAgainButton = button(page, "Try again");
  await expect(tryAgainButton).toBeFocused();

  await installCompanion();
  await tryAgainButton.click();
  await expect(patField(page)).toBeFocused();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(tryAgainButton).toBeHidden();
  expect(networkRequests).toEqual([]);
});

test("connects with the saved PAT once Try again finds the companion", async () => {
  const { page, installCompanion } = await openPanel({ withCompanion: false, savedToken: approvedToken });
  await expect(page.getByRole("alert")).toContainText("companion_not_installed");

  await installCompanion();
  await button(page, "Try again").click();
  await expect(promptField(page)).toBeFocused();
  await expect(patField(page)).toBeHidden();
});

test("asks a new user only for a PAT, then chats with the cheapest model preselected and renders both sides as inert text", async () => {
  const { page, networkRequests, dialogs } = await openPanel();
  await expect(patField(page)).toBeFocused();
  await expect(page.locator("main")).toHaveText(`${PAT_EXPLANATION} Connect`, { useInnerText: true });
  await expect(page.locator("p:visible")).toHaveCount(0);
  const connectButton = button(page, "Connect");
  await expect(connectButton).toBeDisabled();
  await patField(page).fill(approvedToken);
  await connectButton.click();

  await expect(promptField(page)).toBeFocused();
  await expect(patField(page)).toBeHidden();
  await expect(patField(page)).toHaveValue("");
  await expect(page.locator("p:visible")).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveText(["Sign out", "Send"]);
  const modelSelect = page.getByLabel("Model", { exact: true });
  await expect(modelSelect.locator("option")).toHaveText([
    "Fake other reply (1×)",
    "Fake reply (0×)",
    "Fake slow reply (1×)",
    "Fake quota failure (0.33×)",
    "Fake crash (1×)",
  ]);
  await expect(modelSelect).toHaveValue("fake-reply");
  const conversation = conversationLog(page);
  await expect(conversation).toBeEmpty();
  await expect(conversation).toBeHidden();
  const sendButton = button(page, "Send");
  await expect(sendButton).toBeDisabled();

  const prompt = "Explain <b>bold</b> & <i>italic</i> tags.";
  await sendPrompt(page, prompt);
  await expectReplyFinished(page);
  await expect(conversation).toBeVisible();
  await expect(conversation.getByRole("article")).toHaveText(
    `You ${prompt} Copilot (Fake reply) Reply 1 (fake-reply) to: ${prompt} 日本語 ${inertMarkup}`,
    { useInnerText: true },
  );
  await expect(conversation.locator(".speaker")).toHaveText(["You", "Copilot (Fake reply)"]);
  await expect(conversation.locator(".speaker").first()).toHaveCSS("clip-path", "inset(50%)");
  await expect(page.locator("img")).toHaveCount(0);
  await expect(conversation.locator("b, i")).toHaveCount(0);
  await expect(promptField(page)).toHaveValue("");
  await expect(promptField(page)).toBeFocused();
  await expect(sendButton).toBeDisabled();
  await expect(button(page, "New chat")).toBeEnabled();
  expect(dialogs).toEqual([]);
  expect(networkRequests).toEqual([]);
});

test("keeps the conversation across turns and model changes until New chat starts over", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  const conversation = conversationLog(page);
  const replies = conversation.locator(".reply");
  const newChatButton = button(page, "New chat");
  await expect(newChatButton).toBeHidden();

  await sendPrompt(page, "First question");
  await expectReplyFinished(page);
  await sendPrompt(page, "Second question");
  await expectReplyFinished(page);
  await page.getByLabel("Model", { exact: true }).selectOption("fake-other");
  await sendPrompt(page, "Third question");
  await expectReplyFinished(page);

  await expect(conversation.getByRole("article")).toHaveCount(3);
  await expect(replies).toHaveText([
    /^Reply 1 \(fake-reply\) to: First question/,
    /^Reply 2 \(fake-reply\) to: Second question/,
    /^Reply 3 \(fake-other\) to: Third question/,
  ]);
  await expect(conversation.getByText("Copilot (Fake other reply)", { exact: true })).toHaveCount(1);

  await newChatButton.click();
  await expect(conversation).toBeEmpty();
  await expect(conversation).toBeHidden();
  await expect(newChatButton).toBeHidden();
  await expect(promptField(page)).toBeFocused();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("fake-other");

  await sendPrompt(page, "Fresh question");
  await expectReplyFinished(page);
  await expect(replies).toHaveText([/^Reply 1 \(fake-other\) to: Fresh question/]);
});

test("sends with Command or Control Enter, keeps Enter for new lines, and ignores blank prompts", async () => {
  const { page } = await openPanel();
  await connect(page);
  const promptInput = promptField(page);
  await expect(promptInput).toBeEnabled();
  const sendButton = button(page, "Send");
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
  await expect(conversation).toBeEmpty();

  const prompt = "  Keep this indentation\nand this second line";
  await promptInput.fill("  Keep this indentation");
  await promptInput.press("Enter");
  await expect(promptInput).toHaveAttribute("data-last-enter", "typed");
  await promptInput.pressSequentially("and this second line");
  await expect(promptInput).toHaveValue(prompt);
  await promptInput.press("Control+Enter");
  await expect(promptInput).toHaveAttribute("data-last-enter", "consumed");
  await expectReplyFinished(page);
  await expect(promptInput).toHaveValue("");
  await expect(conversation.locator(".prompt-text")).toHaveJSProperty("textContent", prompt);
  await expect(conversation.locator(".reply")).toHaveJSProperty(
    "textContent",
    `Reply 1 (fake-reply) to: ${prompt} 日本語 ${inertMarkup}`,
  );

  await promptInput.fill("Now with Command");
  await promptInput.press("Meta+Enter");
  await expectReplyFinished(page);
  await expect(promptInput).toHaveValue("");
  await expect(conversation.locator(".reply").last()).toContainText("Reply 2 (fake-reply) to: Now with Command");
});

test("waits for an input method to finish composing before Command or Control Enter sends", async () => {
  const { page } = await openPanel();
  await connect(page);
  const promptInput = promptField(page);
  await expect(promptInput).toBeEnabled();
  const conversation = conversationLog(page);
  const inputMethod = await page.context().newCDPSession(page);

  await promptInput.focus();
  await inputMethod.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
  await expect(button(page, "Send")).toBeEnabled();
  await promptInput.press("ControlOrMeta+Enter");
  await expect(conversation).toBeEmpty();

  await inputMethod.send("Input.insertText", { text: "日本語" });
  await expect(promptInput).toHaveValue("日本語");
  await promptInput.press("ControlOrMeta+Enter");
  await expect(conversation.locator(".prompt-text")).toHaveText("日本語");
});

test("follows a streaming reply only while the reader stays at the end of the conversation", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  const conversation = conversationLog(page);

  await sendPrompt(page, "Answer at length.\n".repeat(60));
  await expectReplyFinished(page);
  expect(await conversation.evaluate((log) => log.scrollHeight - log.scrollTop - log.clientHeight)).toBeLessThanOrEqual(1);

  await page.getByLabel("Model", { exact: true }).selectOption("fake-slow");
  await sendPrompt(page, "Take your time.");
  await expect(conversation.locator(".reply").last()).toHaveText("Partial reply");
  await conversation.evaluate((log) => log.scrollTo({ top: 0 }));
  await button(page, "Stop").click();
  await expect(conversation.locator(".turn-note").last()).toHaveText("Stopped. Output may be incomplete.");
  expect(await conversation.evaluate((log) => log.scrollTop)).toBe(0);
});

test("explains a prompt over the length limit and refuses to send it", async () => {
  const { page } = await openPanel();
  await connect(page);
  const promptInput = promptField(page);
  await expect(promptInput).toBeEnabled();
  const sendButton = button(page, "Send");
  const limitText = "This prompt is 32,769 characters. Shorten it to 32,768 or fewer to send.";

  await promptInput.fill("x".repeat(32_769));
  await expect(page.getByText(limitText)).toBeVisible();
  await expect(promptInput).toHaveAccessibleDescription(limitText);
  await expect(sendButton).toBeDisabled();
  await promptInput.press("ControlOrMeta+Enter");
  await expect(conversationLog(page)).toBeEmpty();

  await promptInput.press("Backspace");
  await expect(page.getByText(limitText)).toBeHidden();
  await expect(promptInput).toHaveAccessibleDescription("");
  await expect(sendButton).toBeEnabled();
});

test("saves an accepted PAT in the Keychain and opens straight into the chat next time", async () => {
  const { context, page, openAnotherPanel, savedToken, runningCompanions, networkRequests } = await openPanel();
  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  await expect.poll(savedToken).toBe(approvedToken);
  await expect(page.locator("body")).not.toContainText(approvedToken);

  await page.close();
  await expect.poll(runningCompanions).toEqual([]);
  await context.addInitScript(markPatFormIfShown);
  const reopened = await openAnotherPanel();
  await expect(promptField(reopened)).toBeFocused();
  await expect(reopened.locator("p:visible")).toHaveCount(0);
  await expect(reopened.getByRole("button")).toHaveText(["Sign out", "Send"]);
  await expect(reopened.locator("#auth-form")).not.toHaveAttribute("data-shown");
  await expect(patField(reopened)).toHaveValue("");
  expect(networkRequests).toEqual([]);
});

test("restores the model previously selected for the signed-in account", async () => {
  const { page, openAnotherPanel, savedToken, runningCompanions } = await openPanel();
  await connect(page);
  await page.getByLabel("Model", { exact: true }).selectOption("fake-slow");

  await page.close();
  await expect.poll(savedToken).toBe(approvedToken);
  await expect.poll(runningCompanions).toEqual([]);
  const reopened = await openAnotherPanel();
  await expect(reopened.getByLabel("Model", { exact: true })).toHaveValue("fake-slow");
});

test("signing out forgets the PAT, clears the conversation, and asks for a PAT from a fresh companion", async () => {
  const { page, runningCompanions, savedToken } = await openPanel({ savedToken: approvedToken });
  await expect(promptField(page)).toBeEnabled();
  await sendPrompt(page, "Remember this conversation?");
  await expectReplyFinished(page);
  await promptField(page).fill("An unsent draft");
  expect(runningCompanions()).toHaveLength(1);
  const [connectedCompanion] = runningCompanions();

  await button(page, "Sign out").click();
  await expect(patField(page)).toBeFocused();
  expect(savedToken()).toBeUndefined();
  await expect.poll(runningCompanions).toHaveLength(1);
  expect(runningCompanions()).not.toContain(connectedCompanion);
  await expect(chatView(page)).toBeHidden();
  await expect(button(page, "Sign out")).toBeHidden();
  await expect(promptField(page)).toHaveValue("");
  await expect(conversationLog(page)).toBeEmpty();
  await expect(page.getByRole("alert")).toBeHidden();

  await connect(page);
  await expect(promptField(page)).toBeFocused();
  await expect(conversationLog(page)).toBeEmpty();
});

test("stays signed in and names the Keychain item when the saved PAT cannot be removed", async () => {
  const { page, savedToken } = await openPanel({ savedToken: undeletableToken });
  await expect(promptField(page)).toBeEnabled();

  const signOutButton = button(page, "Sign out");
  await signOutButton.click();
  await expect(page.getByRole("alert")).toContainText("forget_failed");
  await expect(page.getByRole("alert")).toContainText("Keychain Access");
  await expect(signOutButton).toBeFocused();
  await expect(promptField(page)).toBeEnabled();
  await expect(patField(page)).toBeHidden();
  expect(savedToken()).toBe(undeletableToken);
});

test("explains a saved PAT that GitHub rejects and replaces it with a new one", async () => {
  const { page, savedToken } = await openPanel({ savedToken: deniedToken });
  await expect(page.getByRole("alert")).toContainText("GitHub did not accept the saved PAT");
  await expect(page.getByRole("alert")).toContainText("auth_failed");
  await expect(patField(page)).toBeFocused();
  await expect(chatView(page)).toBeHidden();
  await expect(page.locator("body")).not.toContainText(deniedToken);

  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect.poll(savedToken).toBe(approvedToken);
});

test("keeps the chat view and offers Try again when the saved PAT cannot be read", async () => {
  const { page, runningCompanions, saveTokenOutsidePanel } = await openPanel({ savedToken: unreadableToken });
  await expect(page.getByRole("alert")).toContainText("keychain_read_failed");
  await expect(chatView(page)).toBeVisible();
  await expect(patField(page)).toBeHidden();
  await expect(promptField(page)).toBeDisabled();
  await expect(button(page, "Sign out")).toBeEnabled();
  const tryAgainButton = button(page, "Try again");
  await expect(tryAgainButton).toBeFocused();

  const firstCompanion = runningCompanions();
  await tryAgainButton.click();
  await expect.poll(() => runningCompanions().some((marker) => !firstCompanion.includes(marker))).toBe(true);
  await expect(tryAgainButton).toBeFocused();
  await expect(page.getByRole("alert")).toContainText("keychain_read_failed");

  saveTokenOutsidePanel(approvedToken);
  await tryAgainButton.click();
  await expect(promptField(page)).toBeFocused();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(tryAgainButton).toBeHidden();
});

test("asks for a PAT when the saved one disappeared from the Keychain", async () => {
  const { page, savedToken } = await openPanel({ savedToken: vanishingToken });
  await expect(page.getByRole("alert")).toContainText("no_saved_token");
  await expect(patField(page)).toBeFocused();
  await expect(chatView(page)).toBeHidden();
  expect(savedToken()).toBeUndefined();

  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("stays connected and says so when the Keychain refuses to save the PAT", async () => {
  const { page, savedToken } = await openPanel();
  await connect(page, unsavableToken);

  await expect(page.getByRole("alert")).toContainText("save_failed");
  await expect(promptField(page)).toBeEnabled();
  expect(savedToken()).toBeUndefined();
});

test("reports a rejected token without reflecting it and allows another attempt", async () => {
  const { page } = await openPanel();
  await connect(page, deniedToken);

  await expect(page.getByRole("alert")).toContainText("auth_failed");
  await expect(patField(page)).toBeFocused();
  await expect(patField(page)).toHaveValue("");
  await expect(chatView(page)).toBeHidden();
  await expect(page.locator("body")).not.toContainText(deniedToken);
  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("accepts only fine-grained PATs and never forwards other tokens", async () => {
  const { page, runningCompanions } = await openPanel();
  await expect(patField(page)).toBeEnabled();
  const companionsBeforeRejection = runningCompanions();
  expect(companionsBeforeRejection).toHaveLength(1);
  await connect(page, "ghp_classicPersonalAccessToken");

  await expect(page.getByRole("alert")).toContainText("github_pat_");
  await expect(patField(page)).toHaveValue("");
  await expect(patField(page)).toBeFocused();
  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  expect(runningCompanions()).toEqual(companionsBeforeRejection);
});

test("says so when the account has no enabled models, and Try again picks up models enabled later", async () => {
  const { page, savedToken, saveTokenOutsidePanel } = await openPanel();
  await connect(page, tokenWithoutModels);

  await expect(page.getByRole("status")).toHaveText(
    "GitHub returned no enabled models for this account, so there is nothing to send.",
  );
  await expect(chatView(page)).toBeVisible();
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Model", { exact: true }).locator("option")).toHaveText(["No models"]);
  await expect(promptField(page)).toBeDisabled();
  await expect(button(page, "Send")).toBeDisabled();
  const tryAgainButton = button(page, "Try again");
  await expect(tryAgainButton).toBeFocused();
  expect(savedToken()).toBe(tokenWithoutModels);

  saveTokenOutsidePanel(approvedToken);
  await tryAgainButton.click();
  await expect(promptField(page)).toBeFocused();
  await expect(page.getByRole("status")).toBeEmpty();
  await expect(tryAgainButton).toBeHidden();
});

test("offers Try again only when restarting the companion cannot drop an unsaved PAT or undo Sign out", async () => {
  const { page, savedToken, releaseHeldKeychainTask } = await openPanel();
  await connect(page, heldTokenWithoutModels);
  await expect(page.getByRole("status")).toContainText("no enabled models");
  const tryAgainButton = button(page, "Try again");
  await expect(tryAgainButton).toBeHidden();
  expect(savedToken()).toBeUndefined();

  releaseHeldKeychainTask();
  await expect(tryAgainButton).toBeFocused();
  expect(savedToken()).toBe(heldTokenWithoutModels);

  await button(page, "Sign out").click();
  await expect(tryAgainButton).toBeHidden();
  releaseHeldKeychainTask();
  await expect(patField(page)).toBeFocused();
  expect(savedToken()).toBeUndefined();
});

test("does not offer Try again when the Keychain refuses to save the PAT of an account with no models", async () => {
  const { page, savedToken } = await openPanel();
  await connect(page, unsavableTokenWithoutModels);

  await expect(page.getByRole("alert")).toContainText("save_failed");
  await expect(page.getByRole("status")).toContainText("no enabled models");
  await expect(button(page, "Try again")).toBeHidden();
  await expect(button(page, "Sign out")).toBeEnabled();
  expect(savedToken()).toBeUndefined();
});

test("swaps Send for Stop while a reply streams, marks a stopped reply incomplete, and keeps the next prompt drafted", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  await page.getByLabel("Model", { exact: true }).selectOption("fake-slow");
  const conversation = conversationLog(page);
  const sendButton = button(page, "Send");
  const stopButton = button(page, "Stop");
  await expect(stopButton).toBeHidden();
  await expect(conversation).toBeHidden();
  await sendPrompt(page, "Take your time.");
  await expect(conversation.locator(".reply")).toHaveText("Partial reply");
  await expect(conversation).toHaveAttribute("aria-busy", "true");
  await expect(conversation).toBeVisible();
  await expect(sendButton).toBeHidden();
  await expect(stopButton).toBeEnabled();
  await expect(page.getByLabel("Model", { exact: true })).toBeDisabled();
  await expect(button(page, "New chat")).toBeDisabled();

  await promptField(page).fill("Next question");
  await stopButton.press("Enter");

  await expect(conversation.locator(".turn-note")).toHaveText("Stopped. Output may be incomplete.");
  await expect(conversation.locator(".reply")).toHaveText("Partial reply");
  await expect(conversation).toHaveAttribute("aria-busy", "false");
  await expect(stopButton).toBeHidden();
  await expect(sendButton).toBeEnabled();
  await expect(promptField(page)).toHaveValue("Next question");
  await expect(promptField(page)).toBeFocused();
  await expect(button(page, "New chat")).toBeEnabled();
});

test("marks a failed request in the conversation and keeps the connection", async () => {
  const { page } = await openPanel();
  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  await page.getByLabel("Model", { exact: true }).selectOption("fake-quota");
  await sendPrompt(page, "Use the costly model.");

  await expect(page.getByRole("alert")).toContainText("quota_exceeded");
  const conversation = conversationLog(page);
  await expect(conversation.locator(".turn-note")).toHaveText("The request did not finish (quota_exceeded).");
  await expect(conversation.locator(".reply")).toBeEmpty();
  await expect(page.getByLabel("Model", { exact: true })).toBeEnabled();

  await page.getByLabel("Model", { exact: true }).selectOption("fake-reply");
  await sendPrompt(page, "Use the free model.");
  await expectReplyFinished(page);
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(conversation.getByRole("article")).toHaveCount(2);
});

test("recovers after the companion exits while connecting", async () => {
  const { page } = await openPanel();
  await connect(page, crashingToken);

  await expect(page.getByRole("alert")).toContainText("companion_exited");
  await expect(patField(page)).toBeDisabled();
  const tryAgainButton = button(page, "Try again");
  await expect(tryAgainButton).toBeFocused();
  await tryAgainButton.click();
  await expect(patField(page)).toBeFocused();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("keeps an interrupted reply visible when the companion exits mid-response, then reconnects", async () => {
  const { page } = await openPanel({ savedToken: approvedToken });
  await expect(promptField(page)).toBeEnabled();
  await page.getByLabel("Model", { exact: true }).selectOption("fake-crash");
  await sendPrompt(page, "Crash while replying.");

  await expect(page.getByRole("alert")).toContainText("companion_exited");
  const conversation = conversationLog(page);
  await expect(conversation.locator(".reply")).toHaveText("Partial reply");
  await expect(conversation.locator(".turn-note")).toHaveText("The companion stopped before the response finished.");
  await expect(conversation).toHaveAttribute("aria-busy", "false");
  await expect(promptField(page)).toBeDisabled();
  await expect(button(page, "Stop")).toBeHidden();
  await expect(button(page, "Send")).toBeDisabled();
  await expect(button(page, "New chat")).toBeDisabled();
  await expect(button(page, "Sign out")).toBeDisabled();

  await button(page, "Try again").click();
  await expect(promptField(page)).toBeFocused();
  await expect(conversation).toBeEmpty();
});

test("closing the panel ends the companion", async () => {
  const { page, runningCompanions } = await openPanel();
  await connect(page);
  await expect(promptField(page)).toBeEnabled();

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

test("fits a narrow sidebar and a wider extension page without scrolling the page", async () => {
  const { page } = await openPanel();
  await expect(patField(page)).toBeEnabled();
  const fitsViewport = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
    );
  for (const width of [320, 720]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fitsViewport()).toBe(true);
    await page.screenshot({ path: `test-results/panel-setup-${width}.png` });
  }

  await connect(page);
  await expect(promptField(page)).toBeEnabled();
  await sendPrompt(page, `Wrap ${"unbroken".repeat(40)} text.\n`.repeat(12));
  await expectReplyFinished(page);
  const conversation = conversationLog(page);
  for (const width of [320, 720]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fitsViewport()).toBe(true);
    expect(await conversation.evaluate((log) => log.scrollWidth <= log.clientWidth)).toBe(true);
    await expect(promptField(page)).toBeInViewport();
    await page.screenshot({ path: `test-results/panel-chat-${width}.png` });
  }
});
