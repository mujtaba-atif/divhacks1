import "server-only";
import type { AnyPlatformDef, PlatformProviderConfig } from "spectrum-ts";

export function withoutIMessageProfileSharing<Def extends AnyPlatformDef>(
  provider: PlatformProviderConfig<Def>,
): PlatformProviderConfig<Def> {
  const definition = provider.__definition;
  if (provider.__name !== "imessage" || definition.name !== "imessage") {
    throw new Error("The reply listener requires the iMessage provider.");
  }

  // Spectrum 12.10.1 compatibility boundary: createClient registers a refreshed
  // profile-sharing gate, while messages also reads the initial profile toggle.
  // Hide metadata from both hooks without removing credentials or token renewal.
  return {
    ...provider,
    __definition: {
      ...definition,
      lifecycle: {
        ...definition.lifecycle,
        createClient: (context) => definition.lifecycle.createClient({ ...context, projectConfig: undefined }),
      },
      messages: (context) => definition.messages({ ...context, projectConfig: undefined }),
    },
  };
}
