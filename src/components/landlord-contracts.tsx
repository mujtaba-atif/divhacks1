"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FileCheck2,
  FileText,
  LoaderCircle,
  LockKeyhole,
  PenLine,
  RefreshCw,
  Send,
  ShieldCheck,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import type { DigitalContract, ContractPolicy, ContractRole } from "@/lib/contract-types";
import type { AuthUser } from "@/lib/types";
import { Modal } from "./workspace-ui";
import { redirectIfSignedOut, useSessionGuard } from "./use-session-guard";
import "./landlord-contracts.css";

type ContractsResponse = { contracts: DigitalContract[] };
type ContractResponse = { contract: DigitalContract };

function exactAcceptance(contract: DigitalContract, role: ContractRole) {
  return contract.acceptances.find((acceptance) => acceptance.role === role
    && acceptance.termsHash === contract.termsHash
    && (!contract.policyHash || acceptance.policyHash === contract.policyHash));
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "--";
}

function displayDate(value?: string) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not recorded";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function displayDateOnly(value?: string) {
  if (!value) return "Not recorded";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  redirectIfSignedOut(response);
  const result = await response.json().catch(() => null) as ({ error?: unknown } & T) | null;
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "The contract request could not be completed.");
  if (!result) throw new Error("The server returned an unexpected response.");
  return result;
}

function PolicyDetails({ policy, technical = false }: { policy: ContractPolicy; technical?: boolean }) {
  return <>
    <section className="ldc-paper-section">
      <h3>{technical ? "Settlement authority" : "Agreement and payment details"}</h3>
      <dl className="ldc-paper-grid">
        {!technical && <>
          <div><dt>Landlord</dt><dd>{policy.landlordDisplayName}</dd></div>
          <div><dt>Tenant</dt><dd>{policy.tenantDisplayName}</dd></div>
          <div className="ldc-paper-wide"><dt>Property</dt><dd>{policy.property.address}, {policy.property.borough}<small>Property ID: {policy.property.id}</small></dd></div>
          <div><dt>Monthly rent</dt><dd>{money(policy.monthlyRentCents)}</dd></div>
          <div><dt>Obligation period</dt><dd>{policy.obligationPeriod}</dd></div>
          <div><dt>Effective date</dt><dd>{displayDateOnly(policy.effectiveDate)}</dd></div>
          <div><dt>Rent due day</dt><dd>Day {policy.dueDay} of the obligation period</dd></div>
          <div><dt>Grace period</dt><dd>{policy.gracePeriodDays} days</dd></div>
          <div><dt>Late fee</dt><dd>{money(policy.lateFeeRule.feeCents)}<small>Maximum: {money(policy.lateFeeRule.maxLateFeeCents)}</small></dd></div>
          <div><dt>Disputed funds</dt><dd>Hold all disputed funds<small>Undisputed release: {policy.disputedFunds.allowUndisputedRelease ? "Allowed" : "Not allowed"}</small></dd></div>
          <div><dt>Monetary default</dt><dd>After {policy.monetaryDefault.afterDays} days<small>Remedy: record only</small></dd></div>
          <div><dt>Repair deadline</dt><dd>{policy.nonMonetaryDefault.deadlineDays} days<small>Remedy: record only</small></dd></div>
        </>}
        {technical && <>
          <div><dt>Settlement asset</dt><dd>{policy.settlement.asset}</dd></div>
          <div><dt>Network</dt><dd>{policy.settlement.network}</dd></div>
          <div><dt>Settlement amount</dt><dd>{policy.settlement.amountRlusd} {policy.settlement.asset}</dd></div>
          <div><dt>Maximum autonomous amount</dt><dd>{policy.settlement.maxAutonomousAmountRlusd} {policy.settlement.asset}</dd></div>
          <div><dt>Agent</dt><dd className="ldc-mono">{policy.agentId}</dd></div>
          <div><dt>Policy version</dt><dd className="ldc-mono">{policy.policyVersion}</dd></div>
          <div><dt>Policy contract</dt><dd className="ldc-mono">{policy.contractId}</dd></div>
        </>}
      </dl>
    </section>
    {!technical && <section className="ldc-paper-section">
      <h3>Repair and release conditions</h3>
      <ul className="ldc-rule-list">
        <li><ShieldCheck size={15} />Repair reported: <strong>{policy.repairRules.repairReportedRequired ? "required" : "not required"}</strong></li>
        <li><ShieldCheck size={15} />Verified evidence: <strong>{policy.repairRules.evidenceVerifiedRequired ? "required" : "not required"}</strong></li>
        <li><ShieldCheck size={15} />Tenant factual confirmation: <strong>{policy.repairRules.tenantConfirmationRequired ? "required" : "not required"}</strong></li>
        <li><LockKeyhole size={15} />Non-monetary obligation: <strong>repair by deadline</strong></li>
      </ul>
    </section>}
  </>;
}

function AgreementDocument({ contract, compact = false }: { contract: DigitalContract; compact?: boolean }) {
  const policy = contract.policy;
  return <article className={`ldc-paper ${compact ? "ldc-paper-compact" : ""}`} aria-label="Rendered agreement terms and policy summary">
    <header className="ldc-paper-heading">
      <div><span>RENTESCROW CONTRACT</span><h2>RentEscrow agreement</h2><p>Contract {contract.contractId || contract.id}</p></div>
      <span className="ldc-paper-mark"><FileText size={18} /></span>
    </header>
    <section className="ldc-paper-section">
      <h3>Contract terms</h3>
      <p className="ldc-terms">{contract.terms}</p>
    </section>
    {policy ? <>
      <PolicyDetails policy={policy} />
      <PolicyDetails policy={policy} technical />
    </> : <section className="ldc-paper-section ldc-paper-note">
      <AlertCircle size={16} />
      <div><h3>No machine-readable policy</h3><p>This legacy contract contains only the terms shown above. It does not include settlement-policy fields.</p></div>
    </section>}
    <section className="ldc-paper-section ldc-integrity">
      <h3>Version integrity</h3>
      <dl>
        <div><dt>Terms hash</dt><dd>{contract.termsHash}</dd></div>
        <div><dt>Policy version</dt><dd>{contract.policyVersion || "Not configured"}</dd></div>
        <div><dt>Policy hash</dt><dd>{contract.policyHash || "Not available"}</dd></div>
      </dl>
    </section>
    <p className="ldc-disclaimer"><strong>Prototype notice:</strong> This agreement uses simulated contractual rules for the demo. It does not claim that its late-fee, default, withholding, or remedy terms are legally valid. Testnet assets have no monetary value.</p>
  </article>;
}

function SignerCard({ role, name, contract, currentUser, reminder }: {
  role: ContractRole;
  name: string;
  contract: DigitalContract;
  currentUser: boolean;
  reminder?: boolean;
}) {
  const acceptance = exactAcceptance(contract, role);
  return <article className={`ldc-signer ${acceptance ? "ldc-signer-signed" : ""}`}>
    <header>
      <span className="ldc-avatar">{initials(name)}</span>
      <div><strong>{name}</strong><span>{role === "landlord" ? "Landlord" : "Tenant"}</span></div>
      <span className={`ldc-status ${acceptance ? "ldc-status-complete" : "ldc-status-waiting"}`}><i />{acceptance ? "Signed" : currentUser ? "Ready to sign" : "Awaiting signature"}</span>
    </header>
    <dl><div><dt>Signature date</dt><dd>{acceptance ? displayDate(acceptance.acceptedAt) : "Not signed"}</dd></div></dl>
    {reminder && !acceptance && <button type="button" className="ldc-secondary-action" disabled title="Signature reminders are not available in this workspace." aria-label="Send reminder unavailable: signature reminders are not supported in this workspace"><Send size={15} />Send reminder</button>}
    <footer>{currentUser ? <><ShieldCheck size={14} /><span>You can sign only for your authenticated landlord account.</span></> : <><UserRound size={14} /><span>The tenant must sign from their own authenticated account.</span></>}</footer>
  </article>;
}

function SignDialog({ contract, busy, error, onClose, onConfirm }: {
  contract: DigitalContract;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return <Modal title="Review and sign contract" subtitle="Your acceptance is recorded against this exact terms and policy version." onClose={onClose} wide>
    <div className="ldc-dialog-document"><AgreementDocument contract={contract} compact /></div>
    {error && <div className="ldc-alert ldc-alert-error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
    <label className="ldc-confirmation">
      <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />
      <span>I am the assigned landlord and I accept the contract terms and policy summary shown above for this exact contract version.</span>
    </label>
    <div className="ldc-dialog-actions">
      <button type="button" className="ldc-button ldc-button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="ldc-button ldc-button-primary" onClick={() => void onConfirm()} disabled={!confirmed || busy}>
        {busy ? <LoaderCircle className="spin" size={16} /> : <PenLine size={16} />}
        {busy ? "Recording signature" : "Accept and sign as landlord"}
      </button>
    </div>
  </Modal>;
}

export function LandlordContracts({ user }: { user: AuthUser }) {
  useSessionGuard(user);
  const [contracts, setContracts] = useState<DigitalContract[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState("");
  const requestVersion = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const result = await request<ContractsResponse>("/api/contracts", { signal });
      if (signal?.aborted || version !== requestVersion.current) return;
      const ordered = [...result.contracts].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      setContracts(ordered);
      setActiveId((current) => ordered.some((contract) => contract.id === current) ? current : ordered[0]?.id ?? "");
    } catch (cause) {
      if (!signal?.aborted && version === requestVersion.current) setError(cause instanceof Error ? cause.message : "Contracts could not be loaded.");
    } finally {
      if (!signal?.aborted && version === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const activeContract = contracts.find((contract) => contract.id === activeId) ?? contracts[0];
  const status = useMemo(() => {
    if (!activeContract) return null;
    const tenantSigned = Boolean(exactAcceptance(activeContract, "tenant"));
    const landlordSigned = Boolean(exactAcceptance(activeContract, "landlord"));
    return { tenantSigned, landlordSigned, complete: tenantSigned && landlordSigned };
  }, [activeContract]);

  async function accept() {
    if (!activeContract || busy || user.role !== "landlord") return;
    setBusy(true);
    setSignError("");
    setNotice("");
    requestVersion.current += 1;
    try {
      const result = await request<ContractResponse>(`/api/contracts/${encodeURIComponent(activeContract.id)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "landlord", termsHash: activeContract.termsHash, policyHash: activeContract.policyHash }),
      });
      setContracts((current) => current.map((contract) => contract.id === result.contract.id ? result.contract : contract));
      setNotice("Your landlord signature was recorded for this exact agreement version.");
      setSigning(false);
    } catch (cause) {
      setSignError(cause instanceof Error ? cause.message : "Your signature could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <section className="ldc-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={25} /><h2>Loading contracts</h2><p>Retrieving your assigned agreements and signature status.</p></section>;

  if (error && !contracts.length) return <section className="ldc-state ldc-state-error"><AlertCircle size={25} /><h2>Contracts could not be loaded</h2><p>{error}</p><button type="button" className="ldc-button ldc-button-secondary" onClick={() => void load()}><RefreshCw size={16} />Try again</button></section>;

  if (!contracts.length) return <section className="ldc-empty"><span><FileText size={25} /></span><h2>No contracts yet</h2><p>A tenant must create an agreement and assign it to your landlord account before it appears here for review.</p></section>;

  if (!activeContract || !status) return null;
  const landlordAcceptance = exactAcceptance(activeContract, "landlord");
  const canSign = user.role === "landlord" && activeContract.case_type === "bilateral" && activeContract.status !== "used" && !landlordAcceptance
    && activeContract.landlordUserId === user.id;
  const landlordName = activeContract.policy?.landlordDisplayName || activeContract.landlordDisplayName || user.displayName;
  const tenantName = activeContract.policy?.tenantDisplayName || activeContract.tenantDisplayName || "Assigned tenant";
  const contractStatus = activeContract.status === "used" ? "Agreement used" : status.complete ? "Fully signed" : "Awaiting signatures";

  return <section className="ldc-root" aria-labelledby="ldc-heading">
    <header className="ldc-page-heading">
      <div><h1 id="ldc-heading">Contracts</h1><p>Both tenant and landlord must review and sign the same contract version before it becomes active.</p></div>
      <span className={`ldc-status ${status.complete ? "ldc-status-complete" : "ldc-status-waiting"}`}><i />{contractStatus}</span>
    </header>

    {error && <div className="ldc-alert ldc-alert-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
    {notice && <div className="ldc-alert ldc-alert-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={15} /></button></div>}

    <div className="ldc-layout">
      <section className="ldc-viewer" aria-label="Contract document viewer">
        <header className="ldc-document-header">
          <span className="ldc-file-icon"><FileText size={18} /></span>
          <div><strong>Rendered agreement</strong><span>Terms and policy summary &middot; {activeContract.contractId || activeContract.id}</span></div>
          {contracts.length > 1 && <label className="ldc-contract-select"><span className="sr-only">Choose contract</span><select value={activeContract.id} onChange={(event) => { setActiveId(event.target.value); setNotice(""); setError(""); }}>{contracts.map((contract) => <option key={contract.id} value={contract.id}>{displayDateOnly(contract.createdAt)} - {contract.id.slice(0, 8)}</option>)}</select></label>}
          <button type="button" className="ldc-secondary-action" disabled title="PDF replacement is not available. Agreements are rendered from immutable stored terms." aria-label="Replace PDF unavailable: agreements are rendered from immutable stored terms"><Upload size={15} />Replace PDF</button>
        </header>
        <div className="ldc-toolbar">
          <span><FileCheck2 size={15} />Agreement preview</span>
          <span>Terms and policy summary</span>
        </div>
        <div className="ldc-canvas">
          <AgreementDocument contract={activeContract} />
        </div>
      </section>

      <aside className="ldc-summary" aria-label="Contract summary and signers">
        <section>
          <h2>Contract summary</h2>
          <dl className="ldc-summary-grid">
            <div><dt>Contract type</dt><dd>{activeContract.case_type === "bilateral" ? "Bilateral" : "Self-documentation"}</dd></div>
            <div><dt>Policy version</dt><dd>{activeContract.policyVersion || "Not configured"}</dd></div>
            <div><dt>Created</dt><dd>{displayDate(activeContract.createdAt)}</dd></div>
            <div><dt>Contract status</dt><dd>{contractStatus}</dd></div>
            <div className="ldc-summary-wide"><dt>Contract ID</dt><dd className="ldc-mono">{activeContract.contractId || activeContract.id}</dd></div>
          </dl>
        </section>
        <section className="ldc-signers">
          <header><h2>Signers</h2><span>{Number(status.tenantSigned) + Number(status.landlordSigned)} of 2 signed</span></header>
          <SignerCard role="landlord" name={landlordName} contract={activeContract} currentUser={activeContract.landlordUserId === user.id} />
          <SignerCard role="tenant" name={tenantName} contract={activeContract} currentUser={false} reminder />
        </section>
        <footer className="ldc-summary-actions">
          {canSign ? <button type="button" className="ldc-button ldc-button-primary" onClick={() => { setSignError(""); setSigning(true); }}><PenLine size={16} />Sign contract</button> : <button type="button" className="ldc-button ldc-button-primary" disabled title={landlordAcceptance ? "Your signature is already recorded for this version." : activeContract.status === "used" ? "This agreement has already been used." : "This agreement cannot be signed by this account."} aria-label={landlordAcceptance ? "Landlord signed: your signature is already recorded for this version" : "Sign unavailable for this account"}>{landlordAcceptance ? <Check size={16} /> : <LockKeyhole size={16} />}{landlordAcceptance ? "Landlord signed" : "Sign unavailable"}</button>}
          <button type="button" className="ldc-button ldc-button-secondary" disabled title="Finalization is automatic after both authenticated parties sign the same version." aria-label="Finalize agreement unavailable: finalization is automatic after both parties sign"><LockKeyhole size={16} />Finalize agreement</button>
        </footer>
      </aside>
    </div>
    {signing && <SignDialog contract={activeContract} busy={busy} error={signError} onClose={() => { if (!busy) { setSigning(false); setSignError(""); } }} onConfirm={accept} />}
  </section>;
}
