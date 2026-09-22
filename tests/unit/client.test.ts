import { describe, expect, it, vi } from "vitest";
import { CopilotProbe, PROBE_PROMPT } from "../../src/copilot/client";
import { apiOrigin, delta, done, exchange, model, streamResponse, testPat, testToken } from "../fixtures/copilot";

function transport(responses: Response[]) {
  return vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
}

async function collect(probe: CopilotProbe, signal?: AbortSignal) {
  let result = "";
  for await (const text of probe.stream("fixture-chat", signal)) result += text;
  return result;
}

describe("credential and request boundaries", () => {
  it("invokes the browser fetch function with its global receiver", async () => {
    const fetcher = transport([Response.json(exchange()), Response.json({ data: [model()] })]);
    vi.stubGlobal("fetch", function (this: typeof globalThis, input: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBe(globalThis);
      return fetcher(input, init);
    });
    try {
      await expect(new CopilotProbe().connect(testPat)).resolves.toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes the PAT only to exchange and the temporary token only to the approved API", async () => {
    const fetcher = transport([
      Response.json(exchange()), Response.json({ data: [model()] }),
      streamResponse(delta("Hello 日本語") + done),
    ]);
    const probe = new CopilotProbe(fetcher);
    expect(await probe.connect(testPat)).toEqual([{ id: "fixture-chat", name: "Fixture chat model" }]);
    expect(await collect(probe)).toBe("Hello 日本語");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/copilot_internal/v2/token",
      `${apiOrigin}/models`,
      `${apiOrigin}/chat/completions`,
    ]);
    const requests = fetcher.mock.calls.map(([, init]) => init);
    expect(new Headers(requests[0]?.headers).get("Authorization")).toBe(`token ${testPat}`);
    for (const request of requests.slice(1)) {
      expect(new Headers(request?.headers).get("Authorization")).toBe(`Bearer ${testToken}`);
      expect(JSON.stringify(request)).not.toContain(testPat);
    }
    for (const request of requests) {
      expect(request).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
      const headers = new Headers(request?.headers);
      expect(headers.has("Editor-Version")).toBe(false);
      expect(headers.has("User-Agent")).toBe(false);
    }
    expect(JSON.parse(String(requests[2]?.body))).toEqual({
      model: "fixture-chat", stream: true,
      messages: [{ role: "user", content: PROBE_PROMPT }],
    });
  });

  it.each(["ghp_classic", "gho_oauth", "", "github_pat_has space", "github_pat_bad\nheader"])(
    "rejects unsupported token input without a request: %s", async (token) => {
      const fetcher = transport([]);
      await expect(new CopilotProbe(fetcher).connect(token)).rejects.toMatchObject({ code: "invalid_pat" });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://attacker.example", "https://api.githubcopilot.com.attacker.example",
    "http://api.githubcopilot.com", "https://secret@api.githubcopilot.com",
    "https://api.githubcopilot.com:8443", "https://api.githubcopilot.com/path",
    "https://api.githubcopilot.com?token=secret", "https://api.githubcopilot.com#fragment",
  ])("rejects untrusted endpoint metadata %s before sending a Copilot token", async (api) => {
    const fetcher = transport([Response.json({ ...exchange(), endpoints: { api } })]);
    await expect(new CopilotProbe(fetcher).connect(testPat)).rejects.toMatchObject({ code: "endpoint" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not guess endpoints when metadata is missing", async () => {
    const fetcher = transport([Response.json({ ...exchange(), endpoints: undefined })]);
    await expect(new CopilotProbe(fetcher).connect(testPat)).rejects.toMatchObject({ code: "endpoint" });
  });

  it.each([401, 403, 429, 500])("reports HTTP %i without exposing response bodies or retrying", async (status) => {
    const fetcher = transport([new Response(`SECRET ${testPat}`, { status })]);
    const error = await new CopilotProbe(fetcher).connect(testPat).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: `http_${status}` });
    expect(String(error)).not.toContain(testPat);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects redirect responses from non-browser transports as well", async () => {
    const fetcher = transport([new Response(null, { status: 302, headers: { location: "https://attacker.example" } })]);
    await expect(new CopilotProbe(fetcher).connect(testPat)).rejects.toMatchObject({ code: "http_302" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("only offers models explicitly enabled for chat completions", async () => {
    const fetcher = transport([Response.json(exchange()), Response.json({ data: [
      model(), { ...model("disabled"), policy: { state: "disabled" } },
      { ...model("responses"), supported_endpoints: ["/responses"] },
      { ...model("unknown"), supported_endpoints: undefined },
      { ...model("policy-unknown"), policy: undefined },
    ] })]);
    const probe = new CopilotProbe(fetcher);
    expect(await probe.connect(testPat)).toHaveLength(1);
    await expect(probe.stream("disabled").next()).rejects.toMatchObject({ code: "model" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails explicitly when no supported enabled model is returned", async () => {
    const fetcher = transport([Response.json(exchange()), Response.json({ data: [] })]);
    const probe = new CopilotProbe(fetcher);
    await expect(probe.connect(testPat)).rejects.toMatchObject({ code: "no_models" });
    await expect(collect(probe)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("clears existing credentials even when replacement input is invalid", async () => {
    const fetcher = transport([Response.json(exchange()), Response.json({ data: [model()] })]);
    const probe = new CopilotProbe(fetcher);
    await probe.connect(testPat);
    await expect(probe.connect("bad")).rejects.toMatchObject({ code: "invalid_pat" });
    await expect(collect(probe)).rejects.toMatchObject({ code: "not_connected" });
  });
});

describe("lifecycle and bounds", () => {
  it("reports timeout distinctly without retaining the credential or retrying", async () => {
    const timeout = new AbortController();
    const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    try {
      const probe = new CopilotProbe(fetcher);
      const pending = probe.connect(testPat);
      timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));
      await expect(pending).rejects.toMatchObject({ code: "timeout" });
      await expect(collect(probe)).rejects.toMatchObject({ code: "not_connected" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      timer.mockRestore();
    }
  });

  it("aborts the network operation after rejecting a non-streaming response", async () => {
    const fetcher = transport([
      Response.json(exchange()), Response.json({ data: [model()] }),
      new Response(new ReadableStream(), { headers: { "content-type": "application/json" } }),
    ]);
    const probe = new CopilotProbe(fetcher);
    await probe.connect(testPat);
    await expect(collect(probe)).rejects.toMatchObject({ code: "stream" });
    expect(fetcher.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
  });

  it("refreshes an expiring credential on demand, using returned refresh metadata", async () => {
    let now = 1_800_000_000_000;
    const fetcher = transport([
      Response.json({ ...exchange(now), refresh_in: 120 }),
      Response.json({ data: [model()] }),
      Response.json(exchange(now + 121_000)),
      streamResponse(delta("OK") + done),
    ]);
    const probe = new CopilotProbe(fetcher, () => now);
    await probe.connect(testPat);
    now += 121_000;
    expect(await collect(probe)).toBe("OK");
    expect(fetcher.mock.calls[2]?.[0]).toBe("https://api.github.com/copilot_internal/v2/token");
  });

  it("does not retry inference after a network error or echo its potentially sensitive message", async () => {
    const fetcher = transport([Response.json(exchange()), Response.json({ data: [model()] })]);
    const probe = new CopilotProbe(fetcher);
    await probe.connect(testPat);
    fetcher.mockRejectedValueOnce(new Error(`network failed ${testPat}`));
    await expect(collect(probe)).rejects.toMatchObject({ code: "network" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects expired or malformed exchanged credentials", async () => {
    for (const body of [
      { ...exchange(), expires_at: 0 },
      { ...exchange(), token: "" },
      { ...exchange(), token: "bad\nheader" },
      { ...exchange(), refresh_in: -1 },
    ]) {
      const fetcher = transport([Response.json(body)]);
      await expect(new CopilotProbe(fetcher).connect(testPat)).rejects.toMatchObject({ code: "credential" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds JSON before parsing or trusting it", async () => {
    const fetcher = transport([new Response("x".repeat(300_000))]);
    await expect(new CopilotProbe(fetcher).connect(testPat)).rejects.toMatchObject({ code: "size" });
  });

  it("logout aborts an active operation and cannot be undone by a late response", async () => {
    const fetcher = vi.fn<typeof fetch>();
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
    const probe = new CopilotProbe(fetcher);
    const pending = probe.connect(testPat);
    probe.clear();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    resolve(Response.json(exchange()));
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(collect(probe)).rejects.toMatchObject({ code: "not_connected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows only one in-flight operation", async () => {
    const fetcher = transport([Response.json(exchange()), Response.json({ data: [model()] })]);
    const probe = new CopilotProbe(fetcher);
    await probe.connect(testPat);
    const controller = new AbortController();
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream(), {
      headers: { "content-type": "text/event-stream" },
    }));
    const first = collect(probe, controller.signal);
    await expect(collect(probe)).rejects.toMatchObject({ code: "busy" });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
  });
});
