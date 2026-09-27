import "server-only";
import type { User } from "spectrum-ts";
import { DeliveryUncertainError, IntegrationError } from "./shared";

/** Fixed safe guidance for a line failure observed after send() was invoked. */
export class SpectrumLineUncertainError extends DeliveryUncertainError {
  constructor() {
    super("Photon could not confirm delivery because the sending line is unavailable. Check SPECTRUM_SENDING_LINE and the provider conversation before retrying.");
  }
}

export interface SpectrumDirectMessage {
  id: string;
  type: string;
  phone: string;
  send(body: string): Promise<unknown>;
}

export interface SpectrumClient {
  openDirectMessage(recipient: string, sendingLine?: string, conversationId?: string): Promise<SpectrumDirectMessage>;
  stop(): Promise<void>;
}

/** Narrow boundary around the installed SDK, also used by offline contract tests. */
export interface SpectrumIMessageApi {
  user(recipient: string): Promise<User>;
  space: {
    create(user: User, params?: { phone?: string }): Promise<SpectrumDirectMessage>;
    get(id: string, params?: { phone?: string }): Promise<SpectrumDirectMessage>;
  };
}

export function isSpectrumSendingLine(line: string): boolean {
  return line === "shared" || /^\+[1-9]\d{7,14}$/.test(line);
}

/** Known local routing errors in the pinned SDK; never expose its available-line list. */
export function isUnavailableSpectrumLineError(error: unknown): boolean {
  return error instanceof Error && (error.message.startsWith("No iMessage client serves phone ")
    || error.message === "No iMessage clients configured");
}

/** Cloud shared-pool spaces expose a logical route, never a pinned physical line. */
export function matchesSpectrumSendingLine(actual: string | undefined, configured: string | undefined): boolean {
  return Boolean(actual && isSpectrumSendingLine(actual)
    && (!configured || actual === configured || (actual === "shared" && isSpectrumSendingLine(configured))));
}

export function spectrumClientFromIMessage(im: SpectrumIMessageApi, stop: () => Promise<void>): SpectrumClient {
  return {
    async openDirectMessage(recipient, sendingLine, conversationId) {
      if (sendingLine !== undefined && !isSpectrumSendingLine(sendingLine)) {
        throw new IntegrationError("Photon sending line must be an E.164 phone number or shared. No message was dispatched.", "Photon", "invalid_input");
      }
      // This resolves an iMessage handle, not project enrollment. Shared routing
      // continues to enforce Photon's project-user allowlist at the provider.
      const user = await im.user(recipient);
      if (user.__platform !== "imessage" || user.id !== recipient) {
        throw new IntegrationError("Photon did not resolve the approved iMessage recipient. No message was dispatched.", "Photon", "rejected");
      }
      const params = sendingLine ? { phone: sendingLine } : undefined;
      try {
        // get() reconstructs a saved DM reference. create() is the supported
        // cold start: dedicated chats.create, or the shared pool's dynamic route.
        // Do not retry failed lookups by opening a different conversation.
        return conversationId ? await im.space.get(conversationId, params) : await im.space.create(user, params);
      } catch (error) {
        if (isUnavailableSpectrumLineError(error)) {
          throw new IntegrationError("The configured Photon sending line is not available to this project. Check SPECTRUM_SENDING_LINE. No message was dispatched.", "Photon", "invalid_input");
        }
        throw error;
      }
    },
    stop,
  };
}

export async function createSpectrumClient(config: { projectId: string; projectSecret: string }): Promise<SpectrumClient> {
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  const app = await Spectrum({
    projectId: config.projectId, projectSecret: config.projectSecret,
    providers: [imessage.config()], telemetry: false, options: { logLevel: "silent" },
  });
  return spectrumClientFromIMessage(imessage(app), () => app.stop());
}

export async function withSpectrumTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Spectrum operation timed out")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function stopSpectrumClient(app: SpectrumClient, milliseconds: number): Promise<void> {
  try { await withSpectrumTimeout(app.stop(), milliseconds); }
  catch { /* Cleanup must not replace a confirmed send receipt or expose provider errors. */ }
}
