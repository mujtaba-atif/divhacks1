import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getPhotonConfig, type PhotonConfig } from "../src/lib/integrations/photon";
import { withSpectrumTimeout } from "../src/lib/integrations/spectrum";
import { withoutIMessageProfileSharing } from "../src/lib/integrations/spectrum-reply-provider";
import { receiveLandlordMessage, type IncomingLandlordMessage } from "../src/lib/server/cases";
import { ApiError } from "../src/lib/server/errors";

const spaceSchema = z.object({ id: z.string().min(1), type: z.literal("dm"), phone: z.string().min(1) });
const textSchema = z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(5_000) });
const messageSchema = z.object({
  id: z.string().min(1), platform: z.literal("imessage"), direction: z.literal("inbound"),
  timestamp: z.date().refine((date) => Number.isFinite(date.getTime())),
  sender: z.object({ address: z.string().min(1) }),
  space: z.object({ id: z.string().min(1) }),
  content: z.union([textSchema, z.object({ type: z.literal("reply"), content: textSchema, target: z.object({ id: z.string().min(1) }) })]),
});

export function normalizeSpectrumReply(space: unknown, message: unknown): IncomingLandlordMessage | undefined {
  const room = spaceSchema.safeParse(space);
  const parsed = messageSchema.safeParse(message);
  if (!room.success || !parsed.success || room.data.id !== parsed.data.space.id) return undefined;
  const value = parsed.data;
  return {
    id: value.id, conversationId: room.data.id, sendingLine: room.data.phone,
    sender: value.sender.address, createdAt: value.timestamp.toISOString(),
    body: value.content.type === "text" ? value.content.text : value.content.content.text,
    ...(value.content.type === "reply" ? { replyToMessageId: value.content.target.id } : {}),
  };
}

export interface ReplyApp {
  messages: AsyncIterable<IncomingLandlordMessage | undefined>;
  stop(): Promise<void>;
}
interface ReplyOptions {
  config?: PhotonConfig;
  enabled?: boolean;
  createApp?: (config: PhotonConfig) => Promise<ReplyApp>;
  receive?: typeof receiveLandlordMessage;
  signal?: AbortSignal;
  logger?: Pick<Console, "log" | "error">;
  shutdownTimeoutMs?: number;
}

async function createReplyApp(config: PhotonConfig): Promise<ReplyApp> {
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  const app = await Spectrum({ projectId: config.projectId, projectSecret: config.projectSecret,
    providers: [withoutIMessageProfileSharing(imessage.config())], telemetry: false, options: { logLevel: "silent" } });
  return {
    messages: (async function* () {
      for await (const [space, message] of app.messages) {
        if (message.platform !== "imessage") continue;
        yield normalizeSpectrumReply(imessage(space), imessage(message));
      }
    })(),
    stop: () => app.stop(),
  };
}

async function nextOrAbort<T>(iterator: AsyncIterator<T>, signal?: AbortSignal): Promise<IteratorResult<T> | undefined> {
  if (signal?.aborted) return undefined;
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal?.addEventListener("abort", abort, { once: true });
    void iterator.next().then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}

/** Authenticated inbound only. This worker never invokes any send or payment API. */
export async function runSpectrumReplies(options: ReplyOptions = {}): Promise<number> {
  const logger = options.logger ?? console;
  let app: ReplyApp | undefined;
  let exitCode = 0;
  try {
    if (!(options.enabled ?? process.env.PHOTON_RECEIVE_ENABLED === "true")) {
      logger.error("Set PHOTON_RECEIVE_ENABLED=true to start the case reply listener.");
      return 1;
    }
    const config = options.config ?? getPhotonConfig();
    if (!config) throw new Error("Live configuration required");
    if (options.signal?.aborted) return 0;
    app = await (options.createApp ?? createReplyApp)(config);
    const iterator = app.messages[Symbol.asyncIterator]();
    logger.log("Spectrum case reply listener started. Application auto-replies are disabled.");
    while (!options.signal?.aborted) {
      const result = await nextOrAbort(iterator, options.signal);
      if (!result || result.done) break;
      const incoming = result.value;
      if (!incoming || incoming.sender !== config.allowedRecipient
        || (config.sendingLine && incoming.sendingLine !== config.sendingLine)) continue;
      try {
        await (options.receive ?? receiveLandlordMessage)(config.tenantId, config.caseId, incoming);
        logger.log("Case reply persisted or already recorded.");
      } catch (error) {
        if (error instanceof ApiError && error.code === "MESSAGE_BINDING_REJECTED") {
          logger.log("Ignored a reply outside the approved case conversation.");
          continue;
        }
        // Stop on a persistence/classification failure rather than silently consuming further messages.
        throw error;
      }
    }
  } catch {
    logger.error(app ? "Reply listener stopped: a message could not be persisted. Inspect the provider conversation before restarting."
      : "Reply listener could not start. Check private Spectrum configuration and provider connection.");
    exitCode = 1;
  } finally {
    if (app) {
      try { await withSpectrumTimeout(app.stop(), options.shutdownTimeoutMs ?? 5_000); }
      catch { logger.error("Spectrum reply listener cleanup timed out or failed."); exitCode = 1; }
    }
  }
  return exitCode;
}

async function main() {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    timer = setTimeout(() => process.exit(1), 10_000);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    return await runSpectrumReplies({ signal: controller.signal });
  } catch { console.error("Unable to load Spectrum listener configuration."); return 1; }
  finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => process.exit(code));
}
