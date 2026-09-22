import { CopilotProbe } from "./client";
import { ProbeError } from "./errors";

export const DEMO_PAT = "github_pat_synthetic_demo_only";

export function createDemoProbe() {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      return Response.json({
        token: "synthetic_demo_token",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        refresh_in: 1200,
        endpoints: { api: "https://api.githubcopilot.com" },
      });
    }
    if (url === "https://api.githubcopilot.com/models") {
      return Response.json({ data: [{
        id: "synthetic-demo",
        name: "Synthetic demo",
        capabilities: { type: "chat" },
        supported_endpoints: ["/chat/completions"],
        policy: { state: "enabled" },
      }] });
    }
    if (url !== "https://api.githubcopilot.com/chat/completions") {
      throw new ProbeError("demo", "The offline demo received an unexpected request.");
    }
    const words = ["Synthetic ", "response. ", "日本語 ", "streams correctly. ", "No network request was made."];
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout>;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        let index = 0;
        const next = () => {
          const word = words[index++];
          if (word === undefined) {
            controller.enqueue(encoder.encode(
              'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            ));
            controller.close();
          } else {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
            })}\n\n`));
            timer = setTimeout(next, 120);
          }
        };
        next();
      },
      cancel() { clearTimeout(timer); },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  return new CopilotProbe(fetcher);
}
