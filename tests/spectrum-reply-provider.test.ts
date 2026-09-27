import assert from "node:assert/strict";
import { test } from "node:test";
import { imessage } from "spectrum-ts/providers/imessage";
import { withoutIMessageProfileSharing } from "../src/lib/integrations/spectrum-reply-provider";

interface HookContext {
  config: object;
  projectConfig?: { profile: { imessageSynced: boolean } };
  projectId?: string;
  projectSecret?: string;
  client?: object;
  store: object;
}

function fakeProvider() {
  const original = imessage.config();
  const contexts: { create: HookContext[]; messages: HookContext[] } = { create: [], messages: [] };
  const client = {};
  let refreshedProfileGate = false;
  let shares = 0;
  const provider = {
    ...original,
    __definition: {
      ...original.__definition,
      lifecycle: {
        ...original.__definition.lifecycle,
        createClient: async (context: HookContext) => {
          contexts.create.push(context);
          refreshedProfileGate = Boolean(context.projectId && context.projectSecret && context.projectConfig);
          return client;
        },
      },
      messages: async function* (context: HookContext) {
        contexts.messages.push(context);
        if (refreshedProfileGate || context.projectConfig?.profile.imessageSynced) shares++;
        yield { id: "offline-inbound" };
      },
    },
  };
  return { provider, contexts, client, shares: () => shares, gateRegistered: () => refreshedProfileGate };
}

test("reply provider hides initial and refreshed sharing metadata from both SDK hooks", async () => {
  for (const initiallySynced of [false, true]) {
    const fake = fakeProvider();
    const wrapped = withoutIMessageProfileSharing(fake.provider);
    const metadata = { profile: { imessageSynced: initiallySynced } };
    const context: HookContext = {
      config: {}, projectConfig: metadata, projectId: "offline-project", projectSecret: "offline-secret", store: {},
    };
    const client = await wrapped.__definition.lifecycle.createClient(context);
    const messagesContext = { ...context, client };
    for await (const message of wrapped.__definition.messages(messagesContext)) {
      assert.equal(message.id, "offline-inbound");
    }
    metadata.profile.imessageSynced = true;
    for await (const message of wrapped.__definition.messages(messagesContext)) {
      assert.equal(message.id, "offline-inbound");
    }
    assert.equal(fake.gateRegistered(), false);
    assert.equal(fake.shares(), 0);
    assert.equal(fake.contexts.create[0].projectConfig, undefined);
    assert.equal(fake.contexts.messages.length, 2);
    for (const received of fake.contexts.messages) assert.equal(received.projectConfig, undefined);
    assert.equal(context.projectConfig, metadata);
    assert.equal(messagesContext.projectConfig, metadata);
    assert.equal(metadata.profile.imessageSynced, true);
  }
});

test("reply provider preserves authentication, config, client, store and lifecycle behavior", async () => {
  const fake = fakeProvider();
  const wrapped = withoutIMessageProfileSharing(fake.provider);
  const context: HookContext = {
    config: {}, projectConfig: { profile: { imessageSynced: true } },
    projectId: "offline-project", projectSecret: "offline-secret", store: {},
  };
  const client = await wrapped.__definition.lifecycle.createClient(context);
  for await (const message of wrapped.__definition.messages({ ...context, client })) {
    assert.equal(message.id, "offline-inbound");
  }
  assert.equal(client, fake.client);
  assert.notEqual(fake.contexts.create[0], context);
  for (const received of [...fake.contexts.create, ...fake.contexts.messages]) {
    assert.equal(received.projectId, context.projectId);
    assert.equal(received.projectSecret, context.projectSecret);
    assert.equal(received.config, context.config);
    assert.equal(received.store, context.store);
  }
  assert.equal(fake.contexts.messages[0].client, client);
  assert.equal(wrapped.config, fake.provider.config);
  assert.equal(wrapped.__tag, "PlatformProviderConfig");
  assert.equal(wrapped.__name, "imessage");
  assert.notEqual(wrapped.__definition, fake.provider.__definition);
  assert.notEqual(wrapped.__definition.lifecycle, fake.provider.__definition.lifecycle);
  assert.equal(wrapped.__definition.lifecycle.destroyClient, fake.provider.__definition.lifecycle.destroyClient);
  assert.equal(wrapped.__definition.send, fake.provider.__definition.send);
  assert.equal(wrapped.__definition.space, fake.provider.__definition.space);
  assert.equal(wrapped.__definition.user, fake.provider.__definition.user);
  assert.equal(wrapped.__definition.events, fake.provider.__definition.events);

  // The original provider still sees metadata, proving the wrapper did not
  // globally alter SDK definitions or the account's cloud settings.
  await fake.provider.__definition.lifecycle.createClient(context);
  assert.equal(fake.gateRegistered(), true);
});

test("reply provider accepts the installed typed config without starting a client", () => {
  const original = imessage.config();
  const wrapped: ReturnType<typeof imessage.config> = withoutIMessageProfileSharing(original);
  assert.equal(wrapped.__definition.name, "imessage");
  assert.equal(wrapped.__definition.config, original.__definition.config);
  assert.throws(() => withoutIMessageProfileSharing({ ...original, __definition: { ...original.__definition, name: "other" } }),
    /requires the iMessage provider/);
});
