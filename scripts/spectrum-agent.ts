import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface AgentMessage {
  platform: string;
  direction: string;
  id: string;
  timestamp: Date;
  content: { type: string; text?: string };
}
interface AgentSpace { send(text: string): Promise<unknown> }
export interface EchoApp {
  messages: AsyncIterable<readonly [AgentSpace, AgentMessage]>;
  stop(): Promise<void>;
}
interface AgentConfig { projectId: string; projectSecret: string }
interface AgentOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  createApp?: (config: AgentConfig) => Promise<EchoApp>;
  signal?: AbortSignal;
  logger?: Pick<Console, "log" | "error">;
  now?: () => number;
  shutdownTimeoutMs?: number;
}

const ECHO_PREFIX = "RentEscrow Agent got: ";
const MAX_SEEN_MESSAGES = 10_000;

async function createSpectrumApp(config: AgentConfig): Promise<EchoApp> {
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  return Spectrum({ ...config, providers: [imessage.config()], telemetry: false, options: { logLevel: "silent" } });
}

async function waitOrAbort<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return operation();
  if (signal.aborted) return null;
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); resolve(null); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => signal.aborted ? null : operation()).then((value) => {
      signal.removeEventListener("abort", aborted);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", aborted);
      reject(error);
    });
  });
}

async function stopWithTimeout(app: EchoApp, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([app.stop(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Shutdown timed out")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Importing this module never connects. Only the CLI or an explicit caller starts the live worker. */
export async function runSpectrumAgent(options: AgentOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env;
  const logger = options.logger ?? console;
  const projectId = environment.SPECTRUM_PROJECT_ID?.trim();
  const projectSecret = environment.SPECTRUM_PROJECT_SECRET?.trim();
  if (!projectId || !projectSecret) {
    logger.error("Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env.local.");
    return 1;
  }
  if (options.signal?.aborted) return 0;
  const startedAt = (options.now ?? Date.now)();
  const seen = new Set<string>();
  let app: EchoApp | undefined;
  let exitCode = 0;
  try {
    app = await (options.createApp ?? createSpectrumApp)({ projectId, projectSecret });
    if (!options.signal?.aborted) logger.log("RentEscrow echo agent is live. New incoming iMessage text will receive a reply.");
    const iterator = app.messages[Symbol.asyncIterator]();
    while (!options.signal?.aborted) {
      const result = await waitOrAbort(() => iterator.next(), options.signal);
      if (!result || result.done) break;
      const [space, message] = result.value;
      if (message.platform !== "imessage" || message.direction !== "inbound" || message.content.type !== "text"
        || !message.id || !(message.timestamp instanceof Date) || !Number.isFinite(message.timestamp.getTime())
        || message.timestamp.getTime() < startedAt || seen.has(message.id)) continue;
      const body = message.content.text;
      if (!body?.trim() || body.startsWith(ECHO_PREFIX)) continue;
      if (seen.size >= MAX_SEEN_MESSAGES) {
        logger.error("Echo message limit reached. Restart the worker to begin a new live session.");
        exitCode = 1;
        break;
      }
      // Reserve before dispatch: a failed send can have succeeded remotely and must not be retried.
      seen.add(message.id);
      try {
        const sent = await waitOrAbort(async () => {
          await space.send(`${ECHO_PREFIX}"${body.slice(0, 4_000)}"`);
          return true;
        }, options.signal);
        if (sent === null) {
          logger.error("Echo delivery interrupted. This message will not be retried.");
          exitCode = 1;
          break;
        }
        logger.log("Echo reply sent.");
      } catch {
        logger.error("Echo delivery could not be confirmed. This message will not be retried.");
        exitCode = 1;
      }
    }
  } catch {
    logger.error(app ? "Spectrum message stream stopped unexpectedly." : "Spectrum startup failed. Check the project configuration and provider connection.");
    exitCode = 1;
  } finally {
    if (app) {
      try { await stopWithTimeout(app, options.shutdownTimeoutMs ?? 10_000); }
      catch { logger.error("Spectrum could not shut down cleanly."); exitCode = 1; }
    }
  }
  return exitCode;
}

async function main(): Promise<number> {
  const controller = new AbortController();
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    // Provider initialization may not expose a client to stop yet.
    shutdownTimer = setTimeout(() => {
      console.error("Spectrum shutdown deadline exceeded.");
      process.exit(1);
    }, 10_000);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    return await runSpectrumAgent({ signal: controller.signal });
  } catch {
    console.error("Spectrum could not load its local configuration.");
    return 1;
  } finally {
    clearTimeout(shutdownTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // This standalone worker has no other work to preserve after bounded provider cleanup.
  void main().then((code) => { process.exit(code); });
}
