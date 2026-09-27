import { expect, test } from "@playwright/test";
import { demoUsers } from "./auth-fixtures";
import { origin } from "./environment";

// These integration tests exercise the rendered routes and API without a browser.
test("public homepage renders the Figma landing and role-specific entry", async ({ request }) => {
  for (const path of ["/", "/login", "/?role=landlord", "/login?role=landlord"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain("Build your case and protect disputed rent with Escrow");
    expect(html).toContain("Welcome back");
    expect(html).toContain("landing-skyline");
    expect(html).toContain(encodeURIComponent("/figma/door-brand.png"));
    const role = path.includes("role=landlord") ? "landlord" : "tenant";
    const checkedRadio = html.match(/<input[^>]*type="radio"[^>]*>/g)?.find((input) => input.includes("checked="));
    expect(checkedRadio).toContain(`value="${role}"`);
    expect(html).toContain(`Sign in as ${role === "tenant" ? "Tenant" : "Landlord"}`);
  }
});

test("original Figma assets and the locally hosted font are served", async ({ request }) => {
  for (const [file, width, height] of [["nyc-skyline.png", 1024, 1024], ["door.png", 1024, 1024], ["door-brand.png", 196, 180]] as const) {
    const response = await request.get(`/figma/${file}`);
    expect(response.ok()).toBeTruthy();
    const body = await response.body();
    expect(body.readUInt32BE(16)).toBe(width);
    expect(body.readUInt32BE(20)).toBe(height);
  }
  for (const file of ["folder-check.svg", "message.svg", "shield.svg", "lock.svg"]) {
    const response = await request.get(`/figma/${file}`);
    expect(response.ok()).toBeTruthy();
    expect(await response.text()).toContain("<path");
  }
  const html = await (await request.get("/")).text();
  const stylesheets = [...html.matchAll(/href="([^\"]+\.css)"/g)].map((match) => match[1]);
  const fontUrls = (await Promise.all(stylesheets.map(async (url) => {
    const css = await (await request.get(url)).text();
    const font = css.match(/url\(["']?([^\s"')]+\.woff2)["']?\)/);
    return font ? new URL(font[1], new URL(url, origin)).href : null;
  }))).filter((url): url is string => url !== null);
  expect(fontUrls.length).toBeGreaterThan(0);
  for (const url of fontUrls) expect((await request.get(url)).ok()).toBeTruthy();
});

test("each landing role signs in to its authorized workspace and mismatches issue no session", async ({ playwright, baseURL }) => {
  for (const role of ["tenant", "landlord"] as const) {
    const context = await playwright.request.newContext({ baseURL });
    const credentials = role === "tenant" ? demoUsers.tenant1 : demoUsers.landlord;
    try {
      const mismatch = await context.post("/api/auth/login", {
        headers: { Origin: origin },
        data: { email: credentials.email, password: credentials.password, expectedRole: role === "tenant" ? "landlord" : "tenant" },
      });
      expect(mismatch.status()).toBe(403);
      expect(await mismatch.json()).toMatchObject({ code: "ROLE_MISMATCH" });
      expect(mismatch.headers()["set-cookie"]).toBeUndefined();
      expect((await context.get("/api/dashboard")).status()).toBe(401);

      const login = await context.post("/api/auth/login", {
        headers: { Origin: origin }, data: { email: credentials.email, password: credentials.password, expectedRole: role },
      });
      expect(login.ok(), await login.text()).toBeTruthy();
      expect(await login.json()).toMatchObject({ user: { role }, redirectTo: `/${role}` });
      expect((await context.get(`/${role}`)).status()).toBe(200);
      const otherWorkspace = await context.get(role === "tenant" ? "/landlord" : "/tenant", { maxRedirects: 0 });
      expect(otherWorkspace.status()).toBe(307);
      expect(otherWorkspace.headers().location).toBe(`/${role}`);
      const dashboard = await context.get(role === "tenant" ? "/api/dashboard" : "/api/landlord/cases");
      expect(dashboard.ok()).toBeTruthy();
      expect(await dashboard.json()).toHaveProperty("cases");
      expect((await context.post("/api/auth/logout", { headers: { Origin: origin } })).ok()).toBeTruthy();
      expect((await context.get("/api/dashboard")).status()).toBe(401);
    } finally { await context.dispose(); }
  }
});
