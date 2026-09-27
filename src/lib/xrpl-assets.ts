/** Public protocol definitions, verified against Ripple's docs on 2026-09-27.
 * https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
 * This module contains no wallet credentials and is safe for presentation code.
 */
export const RLUSD_TESTNET_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
export const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
export const SETTLEMENT_AGENT_ID = "rentescrow-settlement-v1";
export const SETTLEMENT_POLICY_VERSION = "CASE_SETTLEMENT_V1";
export const MAX_RLUSD_AMOUNT = "1000";

export interface SettlementAssetFields {
  asset?: string;
  amount?: string;
  amountDrops: string;
  currency?: string;
  issuer?: string;
}

/** Exact decimal arithmetic for ledger values, including scientific notation. */
function decimal(value: string): { coefficient: bigint; scale: number } {
  if (typeof value !== "string" || value.length > 100) throw new Error("Invalid decimal");
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match) throw new Error("Invalid decimal");
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (Math.abs(scale) > 100) throw new Error("Invalid decimal scale");
  return { coefficient: BigInt(`${match[1]}${match[2]}${match[3] ?? ""}`), scale };
}

export function compareDecimal(left: string, right: string): number {
  const a = decimal(left), b = decimal(right);
  const scale = Math.max(a.scale, b.scale);
  const av = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bv = b.coefficient * 10n ** BigInt(scale - b.scale);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

export function addDecimal(left: string, right: string): string {
  const a = decimal(left), b = decimal(right), scale = Math.max(a.scale, b.scale, 0);
  const total = a.coefficient * 10n ** BigInt(scale - a.scale) + b.coefficient * 10n ** BigInt(scale - b.scale);
  const sign = total < 0n ? "-" : "", digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  return scale ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}` : `${sign}${digits}`;
}

/** Approved demo amounts use up to six decimals, never floats or exponents. */
export function canonicalSettlementAmount(value: string, maximum: string): string {
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/.test(value)
    || compareDecimal(value, "0") <= 0 || compareDecimal(value, maximum) > 0) throw new Error("Amount outside authorization");
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

export function dropsAsXrp(drops: string): string {
  if (!/^\d+$/.test(drops)) return "0";
  const value = BigInt(drops);
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
}

export function settlementAmount(value: SettlementAssetFields): string {
  return value.amount ?? (value.asset === "RLUSD" ? "0" : dropsAsXrp(value.amountDrops));
}

export function formatSettlementAsset(value: SettlementAssetFields): string {
  return `${settlementAmount(value)} ${value.asset === "RLUSD" ? "Testnet RLUSD" : "Test XRP"}`;
}

export function validAssetPermission(value: SettlementAssetFields): boolean {
  try {
    if (value.asset === "RLUSD") {
      return value.issuer === RLUSD_TESTNET_ISSUER && value.currency === RLUSD_CURRENCY
        && value.amountDrops === "0" && !!value.amount
        && canonicalSettlementAmount(value.amount, MAX_RLUSD_AMOUNT) === value.amount;
    }
    if (value.asset !== undefined && value.asset !== "XRP") return false;
    if (!/^[1-9]\d{0,8}$/.test(value.amountDrops) || BigInt(value.amountDrops) > 100_000_000n || value.issuer !== undefined) return false;
    if (value.asset === undefined) return value.amount === undefined && value.currency === undefined;
    return value.currency === "XRP" && value.amount === dropsAsXrp(value.amountDrops);
  } catch { return false; }
}

export function sameAssetPermission(a: SettlementAssetFields, b: SettlementAssetFields): boolean {
  return (a.asset ?? "XRP") === (b.asset ?? "XRP") && settlementAmount(a) === settlementAmount(b)
    && a.amountDrops === b.amountDrops && a.issuer === b.issuer
    && (a.currency ?? "XRP") === (b.currency ?? "XRP");
}

export function expectedPaymentAmount(value: SettlementAssetFields) {
  return value.asset === "RLUSD"
    ? { currency: value.currency!, issuer: value.issuer!, value: value.amount! }
    : value.amountDrops;
}

export function matchesDeliveredAmount(actual: unknown, expected: SettlementAssetFields): boolean {
  if (expected.asset !== "RLUSD") return actual === expected.amountDrops;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const amount = actual as Record<string, unknown>;
  try {
    return Object.keys(amount).length === 3 && amount.currency === expected.currency && amount.issuer === expected.issuer
      && typeof amount.value === "string" && compareDecimal(amount.value, expected.amount!) === 0;
  } catch { return false; }
}
