# gh-copilot-in-chrome

A private experiment for a Chrome sidebar using **GitHub Copilot directly**, without a
local companion or a hosted relay. This is not affiliated with GitHub.

**Current status:** the offline feasibility harness is implemented. Fine-grained PAT
compatibility, live inference, billing attribution, and permission to distribute an
integration using these endpoints remain **unverified**. Passing the demo or automated
tests does not establish any of them.

## Build and load

Requires Node.js 24, npm, and Chrome 120+.
Node.js is a build tool here, not an end-user companion process.

```sh
npm ci
npm run build
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select this checkout's `dist/` directory. Open the extension from the toolbar to
show its side panel. Reload the extension after rebuilding.

Choose **Run offline demo** first. It exercises the same bounded stream parser and
adapter against synthetic responses, including Japanese text, without network access.
It does not require a token.

## Optional live feasibility check

Live checks are a separate, user-authorized step. They are never run by the test suite
or on panel startup. Do not provide credentials in chat, issues, commits, screenshots,
logs, or CI.

1. Create a fresh, expiring **fine-grained PAT** with your personal account as resource
   owner and only the account-level **Copilot Requests** permission. This permission is
   documented for the CLI/SDK; compatibility with this direct flow is not yet proven.
2. Enter it directly in the extension's password field. Review the disclosure and select
   **Check PAT (live)** to authorize token exchange and model discovery only.
3. If discovery succeeds, select a model. Only entries explicitly identifying themselves
   as enabled chat models with `/chat/completions` support are offered.
4. Separately approve allowance consumption and select **Send test prompt (live)**. The
   entire prompt is fixed and visible: `Reply with exactly: Connection confirmed.`
   Each send requires a new approval; there is no automatic retry.
5. Verify usage in your GitHub account separately. Record the operation stage, error
   code or success, Chrome version, and enabled model ID. Do not export request headers,
   raw authentication responses, or tokens.
6. Select **Clear credentials and output**, then revoke the experimental PAT when done.

Stop on authentication/policy denial or unsupported metadata. Do not try borrowed
OAuth application IDs, editor impersonation, token extraction, model-policy changes,
or alternative credential flows to bypass the result. A passing request demonstrates
technical access only, not a supported API contract or approval for public release.

## Boundaries

- The extension has only `sidePanel` and four narrow API host permissions. It has no
  content scripts, page-capture permissions, native messaging, tools, or external message
  bridge. Page-aware chat is a later milestone, gated on this experiment.
- PATs are sent only to `https://api.github.com/copilot_internal/v2/token`. Temporary
  Copilot tokens are sent only to the exact individual/business/enterprise Copilot API
  origins allowlisted in the manifest and adapter. Endpoint redirects are rejected.
  No endpoint is guessed if metadata is missing.
- Requests use browser `fetch` with cookies omitted and no editor-identity headers.
  Unknown inference protocols, tool calls, and model-policy states are rejected, not
  silently treated as compatible.
- Credentials, model selection, and output exist only in panel memory. Reloading or
  closing it clears them; reopening starts fresh. Neither persistent nor session storage
  is used in this initial harness. This is intentionally stricter than the eventual
  browser-session chat history design.
- The password field is cleared immediately on submission. Errors name the failing stage
  but never reflect server response bodies. Output uses text rendering, not HTML.
- **Stop** aborts the client request and retains partial output as incomplete. It does
  not guarantee cancellation or avoidance of charges on GitHub's side.
- The harness applies a 60-second operation timeout, 256 KiB JSON-response limit,
  1 MiB stream limit, 64 KiB event/output limits, and one operation at a time per panel.
  A limit failure is explicit; no content is silently truncated.
- GitHub receives live credentials/prompts and applies its own retention/account terms.
  Local clearing does not retract those requests. Panel memory is not a guarantee
  against browser/OS crash artifacts or a compromised extension/browser.

## Development checks

```sh
npm test
npx playwright install chromium
npm run check
```

`npm run check` runs unit tests, strict TypeScript checking, a production build, and
Playwright tests loading the packaged MV3 extension in an isolated Chrome for Testing
profile. All application HTTP requests in browser tests are fulfilled with synthetic
fixtures or blocked; no real PAT or Copilot allowance is used.

The browser tests cover separate approvals, safe text output, narrow permissions,
credential clearing, and responsive layout. Unit tests cover credential routing,
endpoint validation, refresh/expiry, errors, cancellation, and incomplete/oversized
streams. Tests do not establish live token compatibility, endpoint support, or billing.

## Integration evidence

- [Official CLI PAT setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
  and [SDK authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)
  document credential support in the runtime, not direct browser inference.
- [Pi's direct Copilot client](https://github.com/earendil-works/pi/blob/d201760ffee16564aa8d9a759e0c85b70db33674/packages/ai/src/auth/oauth/github-copilot.ts)
  and [copilot-api's token exchange](https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/github/get-copilot-token.ts)
  demonstrate HTTP flows using GitHub credentials. They are protocol evidence, not a
  promise of PAT compatibility, a public contract, or code dependencies of this project.
- [Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
  explains trusted-context requests with host permissions.

If legitimate direct access cannot be established, the supported-route alternative is
the official Copilot SDK with a local native companion, or a hosted SDK backend. Neither
is silently substituted by this experiment.