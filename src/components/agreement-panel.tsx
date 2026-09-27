"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Building2, CalendarDays, Check, Circle, FileSignature, LoaderCircle, LockKeyhole, ShieldCheck, Wallet, Wrench } from "lucide-react";
import type { AuthUser } from "@/lib/types";
import type { ContractPolicyDecision, ContractRole, DigitalContract } from "@/lib/contract-types";
import { Button, fullDate, money } from "./workspace-ui";
import { redirectIfSignedOut, useSessionGuard } from "./use-session-guard";

function accepted(contract: DigitalContract, role: ContractRole) {
  return contract.acceptances.some((acceptance) => acceptance.role === role
    && acceptance.termsHash === contract.termsHash
    && (!contract.policyHash || acceptance.policyHash === contract.policyHash));
}

type ContractPreview = { scenario: string; label: string; decision: ContractPolicyDecision };

function obligationDueDate(period: string, day: number) {
  return fullDate(`${period}-${String(day).padStart(2, "0")}T12:00:00.000Z`);
}

function contractDate(value: string) {
  return fullDate(value.includes("T") ? value : `${value}T12:00:00.000Z`);
}

function Signature({ label, signed }: { label: string; signed: boolean }) {
  return <div className={`agreement-signature ${signed ? "is-signed" : ""}`}><span>{signed ? <Check size={15} strokeWidth={3} /> : <Circle size={9} />}</span><div><strong>{label} signature</strong><small>{signed ? "Accepted by authenticated account" : "Awaiting acceptance"}</small></div></div>;
}

export function AgreementPanel({ contract, user, busy, onAccept, onCreateCase, onReportRepair, previews }: {
  contract: DigitalContract;
  user: AuthUser;
  busy: boolean;
  onAccept: (contract: DigitalContract) => Promise<void>;
  onCreateCase: (contract: DigitalContract, mode: "rent" | "dispute") => Promise<void>;
  onReportRepair: (contract: DigitalContract) => Promise<void>;
  previews?: ContractPreview[];
}) {
  const tenantSigned = accepted(contract, "tenant");
  const landlordSigned = accepted(contract, "landlord");
  const bilateralActive = contract.case_type === "bilateral" && contract.status === "active" && tenantSigned && landlordSigned;
  const signedByCurrentUser = user.role === "tenant" ? tenantSigned : landlordSigned;
  const policy = contract.policy;
  const canSign = contract.case_type === "bilateral" && !signedByCurrentUser && contract.status !== "used"
    && (user.id === contract.tenantUserId || user.id === contract.landlordUserId);

  return <article className="agreement-card" aria-labelledby={`agreement-${contract.id}`}>
    <header className="agreement-heading"><span className="agreement-icon"><FileSignature size={22} /></span><div><span className="eyebrow">PROTOTYPE AGREEMENT</span><h2 id={`agreement-${contract.id}`}>RentEscrow Agreement</h2><p className="mono">{contract.contractId || contract.id}</p></div><span className={`subtle-badge ${bilateralActive ? "badge-green" : ""}`}>{bilateralActive ? "ACTIVE" : "AWAITING SIGNATURES"}</span></header>

    {policy ? <>
      <dl className="agreement-terms">
        <div><dt>Tenant</dt><dd>{policy.tenantDisplayName}</dd></div>
        <div><dt>Landlord</dt><dd>{policy.landlordDisplayName}</dd></div>
        <div><dt>Property</dt><dd>{policy.property.address}, {policy.property.borough}<small>Property ID {policy.property.id}</small></dd></div>
        <div><dt>Rent</dt><dd>{money(policy.monthlyRentCents)} simulated USD</dd></div>
        <div><dt>Due date</dt><dd>{obligationDueDate(policy.obligationPeriod, policy.dueDay)}<small>Prototype obligation period {policy.obligationPeriod}</small></dd></div>
        <div><dt>Grace period</dt><dd>{policy.gracePeriodDays} days</dd></div>
        <div><dt>Late fee</dt><dd>{money(policy.lateFeeRule.feeCents)} · maximum {money(policy.lateFeeRule.maxLateFeeCents)}</dd></div>
        <div><dt>Dispute rules</dt><dd>Hold disputed funds; undisputed release disabled</dd></div>
        <div><dt>Repair conditions</dt><dd>Reported repair, verified evidence{policy.repairRules.tenantConfirmationRequired ? ", and tenant factual confirmation" : ""}</dd></div>
        <div><dt>Settlement asset</dt><dd>{policy.settlement.amountRlusd} Testnet RLUSD<small>XRPL Testnet · Payment</small></dd></div>
        <div><dt>Maximum autonomous settlement</dt><dd>{policy.settlement.maxAutonomousAmountRlusd} Testnet RLUSD</dd></div>
        <div><dt>Agent</dt><dd className="mono break-word">{policy.agentId}</dd></div>
        <div><dt>Effective date</dt><dd>{contractDate(policy.effectiveDate)}</dd></div>
      </dl>

      <section className="agreement-policy" aria-label="Contract-configured policy rules"><h3>Contract-configured demo policy</h3><ul><li><ShieldCheck size={15} />Release rent only when the due-date, funding, dispute, recipient, asset, and network rules pass.</li><li><LockKeyhole size={15} />Hold disputed funds until the contract’s repair conditions pass.</li><li><CalendarDays size={15} />After {policy.gracePeriodDays} grace days, record only the configured late fee, capped at {money(policy.lateFeeRule.maxLateFeeCents)}.</li><li><FileSignature size={15} />Record monetary and repair-deadline defaults only; no legal consequence is inferred.</li></ul></section>
      {previews?.length ? <section className="agreement-previews" aria-label="Simulated policy previews"><div><span className="subtle-badge">SIMULATED POLICY PREVIEW</span><p>Read-only evaluations of the signed policy. Nothing signed. Nothing submitted.</p></div><div className="agreement-preview-grid">{previews.map((preview) => <article key={preview.scenario}><span>{preview.label}</span><strong className={preview.decision.allowed ? "green" : "red"}>{preview.decision.allowed ? `ALLOWED · ${preview.decision.action}` : `BLOCKED · ${preview.decision.reason}`}</strong><small>{preview.decision.evaluatedRules.map((rule) => `${rule.passed ? "✓" : "○"} ${rule.code}`).join(" · ")}</small></article>)}</div></section> : null}
    </> : <div className="inline-note note-neutral"><FileSignature size={18} /><p>This legacy contract has no machine-readable settlement policy. Create a new bilateral RentEscrow Agreement to delegate scoped agent authority.</p></div>}

    <div className="agreement-signatures" aria-label="Agreement signatures"><Signature label="Tenant" signed={tenantSigned} /><Signature label="Landlord" signed={landlordSigned} /></div>

    <dl className="agreement-authority"><div><dt>Contract Status</dt><dd className={bilateralActive ? "green" : "muted"}>{bilateralActive ? "ACTIVE" : "DRAFT"}</dd></div><div><dt>Agent Authority</dt><dd className={bilateralActive ? "green" : "muted"}>{bilateralActive ? "ACTIVE" : "INACTIVE"}</dd></div><div><dt>Policy</dt><dd className="mono">{contract.policyVersion || "Not configured"}</dd></div><div><dt>Policy Hash</dt><dd className="mono break-word">{contract.policyHash || "Not available"}</dd></div></dl>

    <p className="agreement-disclaimer">This prototype agreement uses simulated contractual rules for the demo. It does not claim that these late-fee, default, withholding, or remedy terms are legally valid in New York City. Testnet RLUSD has no monetary value.</p>

    <footer className="agreement-actions">
      <div>{bilateralActive ? <span className="agreement-active-note"><ShieldCheck size={17} /><span><strong>Scoped delegated authority is active</strong><small>Eligible events can be evaluated without per-payment approval.</small></span></span> : <span className="agreement-active-note is-inactive"><LockKeyhole size={17} /><span><strong>Autonomous settlement is blocked</strong><small>Both authenticated parties must accept this exact policy hash.</small></span></span>}</div>
      {canSign && <Button variant="primary" icon={FileSignature} busy={busy} onClick={() => void onAccept(contract)}>Accept and sign as {user.role}</Button>}
      {signedByCurrentUser && !bilateralActive && <span className="subtle-badge badge-green">Your signature is recorded</span>}
    </footer>

    {bilateralActive && user.role === "tenant" && (contract.caseId ? <div className="agreement-demo-actions"><div><strong>This agreement governs an existing case</strong><p>The obligation can be created only once for this contract period.</p></div><Link className="button button-secondary" href={`/tenant?case=${encodeURIComponent(contract.caseId)}&tab=escrow`}>View governed case</Link></div> : <div className="agreement-demo-actions"><div><strong>Start a contract-governed demo event</strong><p>The server derives every case and settlement field from this signed agreement.</p></div><Button icon={Wallet} disabled={busy} onClick={() => void onCreateCase(contract, "rent")}>Create due-date case</Button><Button icon={LockKeyhole} disabled={busy} onClick={() => void onCreateCase(contract, "dispute")}>Create disputed case</Button></div>)}
    {bilateralActive && user.role === "landlord" && contract.caseId && <div className="agreement-demo-actions"><div><strong>Report the agreed repair fact</strong><p>This records repair completion for the linked case. It does not approve or configure a payment.</p></div><Button icon={Wrench} busy={busy} onClick={() => void onReportRepair(contract)}>Report agreed repair complete</Button></div>}
  </article>;
}

async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  redirectIfSignedOut(response);
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(result?.error || "The agreement request could not be completed.");
  return result as T;
}

export function AgreementsWorkspace({ user }: { user: AuthUser }) {
  useSessionGuard(user);
  const [contracts, setContracts] = useState<DigitalContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previews, setPreviews] = useState<Record<string, ContractPreview[]>>({});
  const requestVersion = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    try {
      const result = await apiRequest<{ contracts: DigitalContract[] }>("/api/contracts", { signal });
      if (!signal?.aborted && version === requestVersion.current) { setContracts(result.contracts); setError(""); }
      const governed = result.contracts.filter((contract) => contract.policy && contract.status === "active");
      const loaded = await Promise.all(governed.map(async (contract) => {
        try {
          const preview = await apiRequest<{ previews: ContractPreview[] }>(`/api/contracts/${encodeURIComponent(contract.id)}/preview`, { signal });
          return [contract.id, preview.previews] as const;
        } catch { return [contract.id, []] as const; }
      }));
      if (!signal?.aborted && version === requestVersion.current) setPreviews(Object.fromEntries(loaded));
    } catch (cause) {
      if (!signal?.aborted && version === requestVersion.current) setError(cause instanceof Error ? cause.message : "Agreements could not be loaded.");
    } finally { if (!signal?.aborted && version === requestVersion.current) setLoading(false); }
  }, []);

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function mutate<T>(work: () => Promise<T>, message: string) {
    if (busy) return null;
    setBusy(true); setError(""); setNotice(""); requestVersion.current += 1;
    try { const result = await work(); setNotice(message); await load(); return result; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The agreement could not be updated."); return null; }
    finally { setBusy(false); }
  }

  async function createAgreement() {
    const result = await mutate(() => apiRequest<{ contract: DigitalContract }>("/api/contracts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_type: "bilateral", terms: "RentEscrow prototype bilateral rent and repair settlement agreement." }) }), "Draft agreement created. Review the policy, then sign with this authenticated tenant account.");
    if (result) setContracts((current) => current.some((item) => item.id === result.contract.id) ? current : [...current, result.contract]);
  }

  async function acceptAgreement(contract: DigitalContract) {
    const result = await mutate(() => apiRequest<{ contract: DigitalContract }>(`/api/contracts/${encodeURIComponent(contract.id)}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: user.role, termsHash: contract.termsHash, policyHash: contract.policyHash }) }), user.role === "tenant" ? "Tenant signature recorded." : "Landlord signature recorded. Agent authority is active when both signatures are present.");
    if (result) setContracts((current) => current.map((item) => item.id === result.contract.id ? result.contract : item));
  }

  async function createCase(contract: DigitalContract, mode: "rent" | "dispute") {
    const result = await mutate(() => apiRequest<{ case: { id: string } }>("/api/contracts/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contractId: contract.id, mode }) }), mode === "rent" ? "Due-date case created from the signed agreement." : "Disputed repair case created from the signed agreement.");
    if (result) window.location.assign(`/tenant?case=${encodeURIComponent(result.case.id)}&tab=escrow`);
  }

  async function reportRepair(contract: DigitalContract) {
    if (!contract.caseId) return;
    await mutate(() => apiRequest<{ case: { id: string } }>(`/api/landlord/cases/${encodeURIComponent(contract.caseId!)}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "report_complete", notes: "The property manager reports that the contract-governed demo repair is complete." }) }), "Repair completion recorded as a factual contract event. No payment was approved by this action.");
  }

  return <main className="agreements-page" id="main-content">
    <header className="agreements-page-header"><div><Link href={user.role === "tenant" ? "/tenant" : "/landlord"} className="agreement-back"><ArrowLeft size={16} />Back to workspace</Link><span className="eyebrow">SIGNED POLICY AUTHORITY</span><h1>RentEscrow Agreements</h1><p>Both parties accept the same canonical policy before the agent can evaluate or execute any financial action.</p></div><div className="agreement-user"><span className="tenant-avatar">{user.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><div><strong>{user.displayName}</strong><span>{user.role === "tenant" ? "Tenant" : "Landlord"} · {user.email}</span></div></div></header>
    {error && <div className="error-banner" role="alert"><span>{error}</span></div>}
    {notice && <div className="inline-note note-green" role="status"><Check size={17} /><p>{notice}</p></div>}
    {!loading && contracts.length > 0 && user.role === "tenant" && <section className="agreement-demo-actions" aria-label="Agreement versioning"><div><strong>Need different terms?</strong><p>Active agreement terms stay immutable. A new agreement starts a new policy version and requires both signatures again.</p></div><Button icon={FileSignature} busy={busy} onClick={() => void createAgreement()}>Create new agreement</Button></section>}
    {loading ? <div className="agreement-loading" role="status"><LoaderCircle className="spin" size={24} /><span>Loading signed agreements…</span></div> : contracts.length ? <div className="agreements-list">{contracts.map((contract) => <AgreementPanel key={contract.id} contract={contract} user={user} busy={busy} onAccept={acceptAgreement} onCreateCase={createCase} onReportRepair={reportRepair} previews={previews[contract.id]} />)}</div> : <section className="agreement-empty"><span><Building2 size={25} /></span><h2>No RentEscrow Agreement yet</h2><p>{user.role === "tenant" ? "Create the prototype agreement, review its policy, and sign before starting a contract-governed financial workflow." : "A tenant must create the prototype agreement before it can appear here for your authenticated signature."}</p>{user.role === "tenant" && <Button variant="primary" icon={FileSignature} busy={busy} onClick={() => void createAgreement()}>Create prototype agreement</Button>}</section>}
  </main>;
}
