export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly code: "unavailable" | "invalid_response" | "invalid_input" | "rejected" | "uncertain_delivery" = "unavailable",
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export class DeliveryUncertainError extends IntegrationError {
  constructor(message = "Photon may have sent this message, but delivery could not be confirmed. Check delivery before retrying.") {
    super(message, "Photon", "uncertain_delivery");
    this.name = "DeliveryUncertainError";
  }
}

export function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new IntegrationError("Integration adapters can only run on the server.", "configuration", "rejected");
  }
}

export async function fetchJson(url: URL | string, provider: string, init: RequestInit = {}): Promise<unknown> {
  assertServer();
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new IntegrationError(`${provider} is unavailable (HTTP ${response.status}). Please try again later.`, provider);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    // Provider payloads and request URLs can contain credentials or private evidence.
    throw new IntegrationError(`${provider} could not complete the request. No result was recorded.`, provider);
  }
}
