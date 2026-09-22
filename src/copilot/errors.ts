export class ProbeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

export function safeError(error: unknown, signal?: AbortSignal): ProbeError {
  if (signal?.aborted) {
    return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      ? new ProbeError("timeout", "The request timed out. No automatic retry was made.")
      : new ProbeError("cancelled", "Stopped. The server may still finish or charge for this request.");
  }
  if (error instanceof ProbeError) return error;
  return new ProbeError("network", "The request failed. Check connectivity and extension permissions. No automatic retry was made.");
}

export function httpError(status: number) {
  const messages: Record<number, string> = {
    401: "The credential was rejected or expired. Check the PAT and its Copilot Requests permission.",
    403: "Access was denied. Check account eligibility and organization policy; do not change client identity to bypass this.",
    429: "GitHub rate-limited the request or reported a usage limit. Check your allowance and wait before trying again.",
  };
  return new ProbeError(`http_${status}`, messages[status] ?? `GitHub returned HTTP ${status}. The experiment stopped without retrying.`);
}
