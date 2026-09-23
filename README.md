# gh-copilot-in-chrome

A private experiment: a Chrome side panel for chatting with GitHub Copilot through the
official [Copilot SDK](https://github.com/github/copilot-sdk), which runs in a small
companion process on your Mac. This project is not affiliated with GitHub.

**Current status:** the chat panel, the companion, its macOS Keychain storage for your PAT
and its installer are built and tested against a scripted fake companion. Whether a real
fine-grained PAT authenticates through the SDK, which models it lists and how usage is
billed are all **unverified** until you run the [live check](#live-check).

## Why a local companion

The first version called GitHub's undocumented token exchange,
`https://api.github.com/copilot_internal/v2/token`, directly from the extension. A
fine-grained PAT got **HTTP 404**. Clients that use that endpoint exchange tokens from
Copilot's editor OAuth apps. Getting past it would have meant borrowing those app IDs or
impersonating an editor, which the experiment's stop rule forbids. The direct flow is
therefore gone.

The SDK
[supports fine-grained PATs](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md),
so the experiment now uses that route instead:

```mermaid
flowchart LR
  Panel["Side panel<br/>(no network access)"] -- "Chrome native messaging<br/>(stdio, JSON)" --> Companion["Companion<br/>(Node.js on this Mac)"]
  Companion -- "/usr/bin/security" --> Keychain["macOS login keychain<br/>(saved PAT, optional)"]
  Companion -- "Copilot SDK" --> Runtime["Bundled Copilot runtime"]
  Runtime -- HTTPS --> GitHub["GitHub Copilot"]
```

- The extension cannot reach the network. It has no host permissions, and its CSP sets
  `connect-src 'none'`. It can talk only to the companion.
- Chrome starts the companion when the panel opens, so the panel can tell whether it is
  installed and whether a PAT is saved. With a saved PAT, the panel connects right away.
  Otherwise nothing is sent to GitHub until you choose **Connect**.
- The companion lives only as long as the panel's connection. **Disconnect** ends it, along
  with its in-memory PAT and SDK session, and starts a fresh one that waits for you to
  connect again. Closing the panel ends it too. A saved PAT stays in your login keychain
  until you choose **Forget saved PAT** or uninstall the companion.

## Requirements

- macOS with Google Chrome 120 or later. The installer registers the companion with Google
  Chrome only, not with Chromium or other Chrome channels.
- Node.js 24 and npm. The companion's TypeScript runs directly on the Node.js that ran the
  installer.
- A GitHub account with Copilot access, and permission to create a fine-grained PAT for
  it.

## Install

```sh
npm ci
npm run build
npm run companion:install
```

In Chrome, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**,
and select this checkout's `dist/` directory. The manifest's `key` pins the extension ID
to `hdmfkhdfamhcfglofebjnoepkbbbihkg`, and the companion accepts only that ID. Open the
extension from the toolbar. The status line should read "Companion ready (Copilot SDK
*version*). Not connected to GitHub."

`npm run companion:install` writes two files:

- `~/Library/Application Support/gh-copilot-in-chrome/companion`: a launcher that runs this
  checkout's `src/companion/main.ts` with the Node.js that ran the installer.
- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.github.mahata.gh_copilot_in_chrome.json`:
  registers the launcher with Chrome for this extension only.

Run it again after moving this checkout or changing Node.js. To remove the companion, run
`npm run companion:uninstall`, which also deletes any saved PAT from your login keychain,
then remove the extension in `chrome://extensions`.

## Use

- **Connect:** paste a fine-grained PAT and choose **Connect**. With **Remember this PAT in
  my macOS login keychain** checked, as it is by default, the companion saves the PAT once
  GitHub accepts it, and the panel connects with it whenever it opens. After
  **Disconnect**, **Connect with saved PAT** reconnects. **Forget saved PAT** deletes it.
- **Chat:** choose a model, write a prompt of up to 32,768 characters, and choose **Send**
  or press ⌘ Enter or Ctrl Enter. Enter starts a new line. The panel preselects the model
  with the lowest billing multiplier, and each option shows the multiplier the SDK
  reported.
- **Replies:** they stream in as plain text, and the conversation follows them while you
  are scrolled to its end. **Stop** ends a reply early and keeps what arrived. You can
  draft the next prompt meanwhile.
- **Conversations:** the conversation carries across prompts, including when you switch
  models. **New chat** starts over, and Copilot no longer sees the earlier messages. If a
  conversation outgrows the model's context window, a reply can fail with
  `context_limit`. Start a new chat when that happens.

## Live check

The live check is your first use with a real PAT, and you authorize it yourself. The test
suite never runs it. Never put a credential in chat, issues, commits, screenshots, logs or
CI.

1. Create a fresh, expiring
   [fine-grained PAT](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
   with your personal account as resource owner and only the **Copilot Requests** account
   permission.
2. Paste it into **Fine-grained PAT**, leave **Remember** checked, and choose **Connect**.
   The companion starts the SDK, which checks the PAT with GitHub and lists models. No
   prompt is sent. Once GitHub accepts the PAT, the panel says it is saved in your macOS
   login keychain.
3. Check that the Keychain item exists. This command prints its attributes but not the PAT:

   ```sh
   security find-generic-password -s io.github.mahata.gh_copilot_in_chrome -a fine-grained-pat login.keychain
   ```

4. Send a short prompt, then a follow-up that depends on the reply. Switch models, send
   another follow-up, and check that the conversation carries over. Every prompt is a live
   request that uses your Copilot allowance, and nothing is retried automatically.
5. Choose **New chat** and check that Copilot no longer sees the earlier messages. Then ask
   for a long answer and choose **Stop** while it streams. The partial reply should stay,
   marked "Stopped. Output may be incomplete."
6. Close the panel and open it again. It should connect with the saved PAT on its own.
7. Record the status lines, any error codes, the Chrome and SDK versions, the model IDs and
   the "SDK usage report" lines. Check usage in your GitHub account separately. Do not
   record tokens, raw server responses or headers.
8. Choose **Forget saved PAT** and run the command from step 3 again. It should report that
   the item could not be found. Then choose **Disconnect** or close the panel, and revoke
   the PAT.

If something fails:

- **`auth_failed`:** GitHub did not accept the PAT. Check its owner, permission and
  expiry. If a correct PAT still fails, record the result and stop.
- **No enabled models:** the panel offers only models whose SDK metadata says
  `policy.state: "enabled"`, and it does not guess when that field is missing. Record the
  result and stop, because the filter may need revisiting.
- **`sdk_start_failed`:** the SDK's platform runtime may be missing. It is an optional
  dependency (`@github/copilot-sdk-darwin-arm64` or `-darwin-x64`), so run `npm ci` without
  `--omit=optional`.
- **`keychain_read_failed`, `save_failed` or `forget_failed`:** `/usr/bin/security` could
  not read, save or delete the saved PAT. Pasting a PAT still connects. Record the result,
  and delete any leftover item in Keychain Access.
- **`companion_*` codes:** the panel names the fix. Most need `npm run companion:install`
  followed by **Check again**.

Stop when GitHub denies access. Do not work around a denial with a stored login, a `gh`
token, a classic PAT, a borrowed OAuth app ID, editor impersonation or a custom
integration ID. A passing check shows technical access through the SDK for your own
account. It does not mean approval to distribute this or to offer it to other people.

## Boundaries

The extension:

- Requests only `sidePanel` and `nativeMessaging`. It has no host permissions, no content
  scripts and no access to pages.
- Sends the companion a PAT only if it starts with `github_pat_`, and clears the field on
  submission. It stores nothing in Chrome, so models and the conversation live only in the
  panel's memory.
- Sends only the prompts you submit, exactly as typed, and refuses any over 32,768
  characters. It attaches no page content, selection or files.
- Renders prompts and responses as text, never as HTML. Errors show fixed text and a code,
  never the server's text or the token.

The companion:

- Exits unless its first argument is this extension's origin, which Chrome passes when this
  extension starts it. Chrome's host manifest also allows only this extension ID.
- Accepts six messages: connect with a PAT, optionally remembering it; connect with the
  saved PAT; send a prompt of at most 32,768 characters to a model from this connection's
  list; stop; start a new chat; and forget the saved PAT.
- Keeps a saved PAT as a generic password item in your login keychain, with service
  `io.github.mahata.gh_copilot_in_chrome` and account `fine-grained-pat`:
  - It names the login keychain (`login.keychain`) in every `security` command, so a
    different default keychain or search list does not change where it saves, reads or
    deletes the PAT.
  - It saves the PAT only when **Remember** is checked and GitHub has accepted it,
    replacing any earlier one. Choosing **Forget saved PAT** before GitHub accepts it
    cancels that save, so the last choice wins.
  - At startup it checks only whether the item exists. It reads the PAT only to connect
    with it, and uses it only if it is still a well-formed fine-grained PAT.
  - It deletes the item on **Forget saved PAT** and on `npm run companion:uninstall`.
  - It runs `/usr/bin/security` with only `HOME` and a system `PATH`, and stops it after
    10 seconds. The PAT goes in on standard input rather than as an argument, the tool's
    error output is discarded, and the PAT is never logged.
- Configures the SDK:
  - `mode: "empty"` and `useLoggedInUser: false`, which stop the runtime from using stored
    OAuth tokens or `gh` CLI authentication and turn off the SDK's other ambient features.
    The runtime authenticates only with the PAT the companion passes as `gitHubToken`.
  - No tools (`availableTools: []`), and every permission request is rejected.
  - One streaming session per conversation, kept across prompts and switched with
    `setModel` when you change models. **New chat** disconnects it, and the next prompt
    starts a fresh one. Infinite sessions are off, which turns off the SDK's background
    compaction and session workspace, so an overlong conversation can fail with
    `context_limit`. Sub-agent events are ignored.
- Gives the runtime a new private temporary directory as its `HOME`, `TMPDIR`, Copilot home
  (`COPILOT_HOME`) and working directory, instead of your `~/.copilot` configuration. The
  rest of its environment is a system `PATH` and the variables the SDK adds, so tokens such
  as `GH_TOKEN` are not passed on. Neither are proxy and custom CA settings such as
  `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS`, so networks that require them will not work.
- Enforces limits: 256 KiB per inbound message, 1 MiB per outbound message (Chrome's
  limit), 32,768 characters per prompt, 65,536 characters per reply, 60 seconds per
  connect, 5 minutes per reply, and one connect or prompt at a time. The reply length and
  time limits end a reply with an explicit error and keep what arrived.
- Counts an operation as running until it has cleaned up, and reports its error only then.
  A failed or timed-out connection waits for its runtime to stop. A reply ended by a limit
  waits for its turn to end. If the turn has not ended 5 seconds after the abort, the
  companion reports the limit, stops the runtime and exits, and the panel offers **Check
  again**.
- Handles **Stop** by aborting the current turn and keeping the partial output, marked
  incomplete. It may not prevent server-side work or charges. Stop replaces the reply's
  5-minute limit with 5 seconds: if the turn has not ended by then, the companion reports
  it stopped, stops the runtime and exits, and the panel offers **Check again**.
- Stops a runtime by asking it to shut down, killing it if it has not stopped within
  5 seconds, and then deleting its temporary directory. It does this after a failed
  connection and on exit.

Accepted risks:

- A saved PAT is encrypted at rest in your login keychain, never in Chrome's profile. But
  macOS trusts the tool that created an item to read it without warning. The companion
  saves the PAT with `/usr/bin/security`, so any process running as your macOS user can
  read it by running that tool. Use an expiring PAT and forget it when you are done.
- While a PAT is saved, the panel connects with it every time it opens, which sends it to
  GitHub through the SDK.
- While connected, the PAT sits in the companion's memory and in the runtime's
  `COPILOT_SDK_AUTH_TOKEN` environment variable. Other processes running as your macOS user
  can read it there. Use a short-lived PAT and disconnect when you are done.
- Because the manifest's public `key` fixes the ID, any unpacked extension with the same key
  can talk to the companion, including connecting with the saved PAT and sending prompts.
  The companion never sends the PAT back. Loading such an extension requires access to
  your Chrome profile.
- While the companion runs, the runtime's session log in its temporary directory holds your
  prompts and replies, but not the token. If the companion is still running a few seconds
  after the panel disconnects, Chrome force-quits it, and that directory
  (`$TMPDIR/gh-copilot-in-chrome-*`) can then remain. Delete leftovers by hand.
- The runtime keeps its default integration ID, `copilot-developer-cli`. The companion only
  names itself `gh-copilot-in-chrome` in the SDK's `clientInfo`, which labels the runtime's
  telemetry.
- The SDK is young (1.0.x), so its options, defaults and events may change, including the
  ones this lockdown relies on. `npm ci` installs the exact version pinned in
  `package-lock.json`, and the status line names the running version. After updating the
  SDK, review `src/companion/sdk-gateway.ts`, then run `npm run check` and the live check
  again.

GitHub receives the PAT, your prompts and the conversation so far with the SDK's system
instructions, the chosen model, and whatever request metadata and telemetry the official
runtime sends. This project neither configures nor suppresses that telemetry.
Disconnecting, starting a new chat or forgetting the saved PAT does not retract anything
already sent.

## Development

```sh
npm test
npx playwright install chromium
npm run check
```

`npm run check` runs the unit tests, strict TypeScript checking, a production build and the
browser tests. The browser tests:

- Use the real installer to register a scripted fake companion in a throwaway Chromium
  profile.
- Load the built extension and drive every panel state, including a missing companion,
  rejected tokens, no models, saving, reusing, replacing and forgetting a PAT, multi-turn
  chat, model switches, New chat, keyboard shortcuts and input methods, the prompt length
  limit, following a streaming reply, Stop, failures, a crash mid-reply, Disconnect,
  closing the panel, permissions and layout.
- Run the real protocol code in the fake companion, which never loads the SDK and keeps
  its saved PAT in a temporary file instead of the Keychain.
- Block and record every HTTP request the browser makes, and assert that the install,
  chat, saved-PAT and permission flows make none.

No real PAT or Copilot allowance is used, so the tests do not establish live compatibility
or billing. They never touch your login keychain either. Tests that run the real
`/usr/bin/security`, directly or through the real companion or installer, give it a
temporary `HOME`, where it finds no login keychain. The other tests use fakes.

CI runs the same checks on Ubuntu for pull requests, pushes to `main`, and on demand from
the Actions tab. There, Chromium also reads the profile's `NativeMessagingHosts` directory.
Unit tests and the type-checked build run in parallel. The E2E job then tests the exact
`chrome-extension` artifact uploaded by the build, which you can also download from the
run and load unpacked in place of `dist/`. The companion still comes from
`npm run companion:install` in a checkout of the same commit. Playwright output, including
layout screenshots, is uploaded as `playwright-test-results` even when tests fail. CI uses
no secrets and has read-only repository access.

The code is organized as:

- `src/sidepanel/`: the chat panel UI and its native messaging bridge.
- `src/companion/`: the companion's entry point, protocol state machine, SDK gateway,
  Keychain store, frame codec and installer.
- `src/protocol/`: the messages and extension identity shared by both sides.

## Evidence

- [SDK authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md):
  `github_pat_` fine-grained PATs are supported, and classic `ghp_` tokens are not.
- [Copilot CLI authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli):
  the PAT must be owned by your personal account and have the Copilot Requests permission.
- [SDK multi-tenancy](https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md):
  `mode: "empty"` and the default integration ID.
- [SDK streaming events](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md)
  and [usage and billing](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md):
  `assistant.message_delta`, `session.idle` and the `assistant.usage` multiplier.
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
  and [the manifest `key`](https://developer.chrome.com/docs/extensions/reference/manifest/key).
- `man security`, under `add-generic-password`: `-U` replaces an existing item, and by
  default the application that creates an item is trusted to read it without warning. The
  add, find and delete commands also take a keychain argument, and the page's examples name
  the login keychain `login.keychain`.
