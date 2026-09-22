export const testPat = "github_pat_synthetic_fixture_only";
export const testToken = "synthetic-copilot-token";
export const apiOrigin = "https://api.githubcopilot.com";

export function exchange(now = Date.now()) {
  return {
    token: testToken,
    expires_at: Math.floor(now / 1000) + 1800,
    refresh_in: 1200,
    endpoints: { api: apiOrigin },
  };
}

export function model(id = "fixture-chat") {
  return {
    id,
    name: "Fixture chat model",
    capabilities: { type: "chat" },
    supported_endpoints: ["/chat/completions"],
    policy: { state: "enabled" },
  };
}

export function event(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function delta(content: string) {
  return event({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
}

export const done = event({
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
}) + "data: [DONE]\n\n";

export function streamResponse(text: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
