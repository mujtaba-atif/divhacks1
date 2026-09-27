import "server-only";

export interface SpectrumDirectMessage {
  id: string;
  type: string;
  phone: string;
  send(body: string): Promise<unknown>;
}

export interface SpectrumClient {
  createDirectMessage(recipient: string, sendingLine?: string): Promise<SpectrumDirectMessage>;
  stop(): Promise<void>;
}

export async function createSpectrumClient(config: { projectId: string; projectSecret: string }): Promise<SpectrumClient> {
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  const app = await Spectrum({
    projectId: config.projectId, projectSecret: config.projectSecret,
    providers: [imessage.config()], telemetry: false, options: { logLevel: "silent" },
  });
  return {
    createDirectMessage: (recipient, sendingLine) => imessage(app).space.create(recipient, sendingLine ? { phone: sendingLine } : undefined),
    stop: () => app.stop(),
  };
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
