export const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:3100";
export const origin = new URL(baseURL).origin;
