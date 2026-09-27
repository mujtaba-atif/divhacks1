"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FileCheck2,
  FilePlus2,
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
import type { ContractPolicy, ContractRole, DigitalContract } from "@/lib/contract-types";
import type { AuthUser } from "@/lib/types";
import { Modal } from "./workspace-ui";
import { redirectIfSignedOut } from "./use-session-guard";
import "./tenant-contracts.css";

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
  return date.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function displayDateOnly(value?: string) {
  if (!value) return "Not recorded";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function ContractsHeading({ description, status }: { description: string; status?: { complete: boolean; label: string } }) {
  return <header className="tct-page-heading">
    <div><h1 id="tct-heading">Contracts</h1><p>{description}</p></div>
    {status && <span className={`tct-status ${status.complete ? "tct-status-complete" : "tct-status-waiting"}`}><i />{status.label}</span>}
  </header>;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  redirectIfSignedOut(response);
  const result = await response.json().catch(() => null) as ({ error?: unknown } & T) | null;
  if (!response.ok) {
    throw new Error(typeof result?.error === "string" ? result.error : "The contract request could not be completed.");
  }
  if (!result) throw new Error("The server returned an unexpected response.");
  return result;
}

function PolicyDetails({ policy, technical = false }: { policy: ContractPolicy; technical?: boolean }) {
  return <>
    <section className="tct-paper-section">
      <h3>{technical ? "Settlement authority" : "Agreement and payment details"}</h3>
      <dl className="tct-paper-grid">
        {!technical && <>
          <div><dt>Tenant</dt><dd>{policy.tenantDisplayName}</dd></div>
          <div><dt>Landlord</dt><dd>{policy.landlordDisplayName}</dd></div>
          <div className="tct-paper-wide"><dt>Property</dt><dd>{policy.property.address}, {policy.property.borough}<small>Property ID: {policy.property.id}</small></dd></div>
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
          <div><dt>Currency code</dt><dd className="tct-mono">{policy.settlement.currency}</dd></div>
          <div><dt>Agent</dt><dd className="tct-mono">{policy.agentId}</dd></div>
          <div><dt>Policy version</dt><dd className="tct-mono">{policy.policyVersion}</dd></div>
          <div><dt>Policy contract</dt><dd className="tct-mono">{policy.contractId}</dd></div>
          <div><dt>Tenant account</dt><dd className="tct-mono">{policy.tenantUserId}</dd></div>
          <div><dt>Landlord account</dt><dd className="tct-mono">{policy.landlordUserId}</dd></div>
          <div className="tct-paper-wide"><dt>Source account</dt><dd className="tct-mono">{policy.settlement.source}</dd></div>
          <div className="tct-paper-wide"><dt>Destination account</dt><dd className="tct-mono">{policy.settlement.destination}</dd></div>
          <div className="tct-paper-wide"><dt>Issuer</dt><dd className="tct-mono">{policy.settlement.issuer}</dd></div>
        </>}
      </dl>
    </section>
    {!technical && <section className="tct-paper-section">
      <h3>Repair and release conditions</h3>
      <ul className="tct-rule-list">
        <li><ShieldCheck size={15} />Repair reported: <strong>{policy.repairRules.repairReportedRequired ? "required" : "not required"}</strong></li>
        <li><ShieldCheck size={15} />Verified evidence: <strong>{policy.repairRules.evidenceVerifiedRequired ? "required" : "not required"}</strong></li>
        <li><ShieldCheck size={15} />Tenant factual confirmation: <strong>{policy.repairRules.tenantConfirmationRequired ? "required" : "not required"}</strong></li>
        <li><LockKeyhole size={15} />Non-monetary obligation: <strong>repair by deadline</strong></li>
      </ul>
    </section>}
  </>;
}

function AgreementDocument({ contract, compact = false }: { contract: DigitalContract; compact?: boolean }) {
  return <article className={`tct-paper ${compact ? "tct-paper-compact" : ""}`} aria-label="Rendered agreement with complete terms and policy">
    <header className="tct-paper-heading">
      <div><span>RENTESCROW CONTRACT</span><h2>RentEscrow agreement</h2><p>Contract {contract.contractId || contract.id}</p></div>
      <span className="tct-paper-mark"><FileText size={18} /></span>
    </header>
    <section className="tct-paper-section">
      <h3>Contract terms</h3>
      <p className="tct-terms">{contract.terms}</p>
    </section>
    {contract.policy ? <>
      <PolicyDetails policy={contract.policy} />
      <PolicyDetails policy={contract.policy} technical />
    </> : <section className="tct-paper-section tct-paper-note">
      <AlertCircle size={16} />
      <div><h3>No machine-readable policy</h3><p>This tenant record contains only the stored terms shown above. It does not grant settlement authority.</p></div>
    </section>}
    <section className="tct-paper-section tct-integrity">
      <h3>Version integrity</h3>
      <dl>
        <div><dt>Terms hash</dt><dd>{contract.termsHash}</dd></div>
        <div><dt>Policy version</dt><dd>{contract.policyVersion || "Not configured"}</dd></div>
        <div><dt>Policy hash</dt><dd>{contract.policyHash || "Not available"}</dd></div>
      </dl>
    </section>
    <p className="tct-disclaimer"><strong>Prototype notice:</strong> This agreement uses simulated contractual rules for the demo. It does not claim that its late-fee, default, withholding, or remedy terms are legally valid. Testnet assets have no monetary value.</p>
  </article>;
}

function SignerCard({ role, name, contract, currentUser, showReminder = false }: {
  role: ContractRole;
  name: string;
  contract: DigitalContract;
  currentUser: boolean;
  showReminder?: boolean;
}) {
  const acceptance = exactAcceptance(contract, role);
  return <article className={`tct-signer ${acceptance ? "tct-signer-signed" : ""}`}>
    <header>
      <span className="tct-avatar">{initials(name)}</span>
      <div><strong>{name}</strong><span>{role === "tenant" ? "Tenant" : "Landlord"}</span></div>
      <span className={`tct-status ${acceptance ? "tct-status-complete" : currentUser ? "tct-status-ready" : "tct-status-waiting"}`}>
        <i />{acceptance ? "Signed" : currentUser ? "Ready to sign" : "Awaiting signature"}
      </span>
    </header>
    <dl><div><dt>Signature date</dt><dd>{acceptance ? displayDate(acceptance.acceptedAt) : "Not signed"}</dd></div></dl>
    {showReminder && !acceptance && <button type="button" className="tct-secondary-action" disabled title="Signature reminders are not available in this workspace." aria-label="Send reminder unavailable: signature reminders are not supported in this workspace"><Send size={15} />Send reminder</button>}
    <footer>{currentUser ? <><ShieldCheck size={14} /><span>You can sign only for your authenticated tenant account.</span></> : <><UserRound size={14} /><span>The landlord must sign from their own authenticated account. Signature reminders are not available.</span></>}</footer>
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
    <div className="tct-dialog-document" role="region" aria-label="Terms and policy to review" tabIndex={0}><AgreementDocument contract={contract} compact /></div>
    {error && <div className="tct-alert tct-alert-error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
    <label className="tct-confirmation">
      <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />
      <span>I am the assigned tenant and I accept the complete terms and policy shown above for this exact contract version.</span>
    </label>
    <div className="tct-dialog-actions">
      <button type="button" className="tct-button tct-button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="tct-button tct-button-primary" onClick={() => void onConfirm()} disabled={!confirmed || busy}>
        {busy ? <LoaderCircle className="spin" size={16} /> : <PenLine size={16} />}
        {busy ? "Recording signature" : "Accept and sign as tenant"}
      </button>
    </div>
  </Modal>;
}

export function TenantContracts({ user }: { user: AuthUser }) {
  const [contracts, setContracts] = useState<DigitalContract[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState("");
  const requestVersion = useRef(0);
  const mutationBusy = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    try {
      const result = await request<ContractsResponse>("/api/contracts", { signal });
      if (signal?.aborted || version !== requestVersion.current) return;
      const ordered = [...result.contracts].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      setContracts(ordered);
      setActiveId((current) => ordered.some((contract) => contract.id === current) ? current : ordered[0]?.id ?? "");
    } catch (cause) {
      if (!signal?.aborted && version === requestVersion.current) {
        setLoadFailed(true);
        setError(cause instanceof Error ? cause.message : "Contracts could not be loaded.");
      }
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
    return {
      tenantSigned,
      landlordSigned,
      complete: activeContract.case_type === "self_documentation" ? tenantSigned : tenantSigned && landlordSigned,
    };
  }, [activeContract]);

  async function createAgreement() {
    if (mutationBusy.current || user.role !== "tenant") return;
    mutationBusy.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const version = ++requestVersion.current;
    try {
      const result = await request<ContractResponse>("/api/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_type: "bilateral", terms: "RentEscrow prototype bilateral rent and repair settlement agreement." }),
      });
      if (version !== requestVersion.current) return;
      setContracts((current) => [result.contract, ...current.filter((contract) => contract.id !== result.contract.id)]);
      setActiveId(result.contract.id);
      setNotice("Draft agreement created. Review its complete terms and policy before signing.");
    } catch (cause) {
      if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : "The agreement could not be created.");
    } finally {
      mutationBusy.current = false;
      if (version === requestVersion.current) setBusy(false);
    }
  }

  async function accept() {
    if (!activeContract || mutationBusy.current || user.role !== "tenant") return;
    const signingId = activeContract.id;
    mutationBusy.current = true;
    setBusy(true);
    setSignError("");
    setNotice("");
    const version = ++requestVersion.current;
    try {
      const result = await request<ContractResponse>(`/api/contracts/${encodeURIComponent(signingId)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "tenant", termsHash: activeContract.termsHash, policyHash: activeContract.policyHash }),
      });
      if (version !== requestVersion.current) return;
      setContracts((current) => current.map((contract) => contract.id === result.contract.id ? result.contract : contract));
      setNotice("Your tenant signature was recorded for this exact agreement version.");
      setSigning(false);
    } catch (cause) {
      if (version === requestVersion.current) setSignError(cause instanceof Error ? cause.message : "Your signature could not be recorded.");
    } finally {
      mutationBusy.current = false;
      if (version === requestVersion.current) setBusy(false);
    }
  }

  if (loading) return <section className="tct-root" aria-labelledby="tct-heading"><ContractsHeading description="Review your stored agreements and signature status." /><section className="tct-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={25} /><h2>Loading contracts</h2><p>Retrieving your agreements and signature status.</p></section></section>;

  if (loadFailed && !contracts.length) return <section className="tct-root" aria-labelledby="tct-heading"><ContractsHeading description="Review your stored agreements and signature status." /><section className="tct-state tct-state-error" role="alert"><AlertCircle size={25} /><h2>Contracts could not be loaded</h2><p>{error}</p><button type="button" className="tct-button tct-button-secondary" onClick={() => void load()}><RefreshCw size={16} />Try again</button></section></section>;

  if (!contracts.length) return <section className="tct-root" aria-labelledby="tct-heading"><ContractsHeading description="Create and review agreements with your assigned landlord." /><section className="tct-empty"><span><FileText size={25} /></span><h2>No contracts yet</h2><p>Create a prototype agreement, then review and sign its exact stored terms and policy.</p><button type="button" className="tct-button tct-button-primary" onClick={() => void createAgreement()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <FilePlus2 size={16} />}{busy ? "Creating agreement" : "Create prototype agreement"}</button>{error && <p className="tct-empty-error" role="alert">{error}</p>}</section></section>;

  if (!activeContract || !status) return null;

  const tenantAcceptance = exactAcceptance(activeContract, "tenant");
  const isSelfDocumentation = activeContract.case_type === "self_documentation";
  const canSign = user.role === "tenant" && Boolean(activeContract.policy && activeContract.policyHash)
    && activeContract.case_type === "bilateral" && activeContract.status !== "used" && !tenantAcceptance
    && activeContract.tenantUserId === user.id;
  const tenantName = activeContract.policy?.tenantDisplayName || activeContract.tenantDisplayName || user.displayName;
  const landlordName = activeContract.policy?.landlordDisplayName || activeContract.landlordDisplayName || "Assigned landlord";
  const contractStatus = activeContract.status === "used" ? "Agreement used"
    : isSelfDocumentation ? "Tenant record"
      : status.complete ? "Fully signed" : "Awaiting signatures";
  const signedCount = isSelfDocumentation ? Number(status.tenantSigned) : Number(status.tenantSigned) + Number(status.landlordSigned);
  const signerCount = isSelfDocumentation ? 1 : 2;

  return <section className="tct-root" aria-labelledby="tct-heading">
    <ContractsHeading description={isSelfDocumentation ? "This tenant-only record stores the terms you accepted and does not grant settlement authority." : "Both tenant and landlord must review and sign the same contract version before it becomes active."} status={{ complete: status.complete, label: contractStatus }} />

    {error && <div className="tct-alert tct-alert-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
    {notice && <div className="tct-alert tct-alert-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={15} /></button></div>}

    <div className="tct-layout">
      <section className="tct-viewer" aria-label="Contract document viewer">
        <header className="tct-document-header">
          <span className="tct-file-icon"><FileText size={18} /></span>
          <div><strong>Rendered agreement</strong><span>Complete stored terms and policy &middot; {activeContract.contractId || activeContract.id}</span></div>
          {contracts.length > 1 && <label className="tct-contract-select"><span className="sr-only">Choose contract</span><select value={activeContract.id} onChange={(event) => { setActiveId(event.target.value); setNotice(""); setError(""); setSignError(""); setSigning(false); }}>{contracts.map((contract) => <option key={contract.id} value={contract.id}>{displayDateOnly(contract.createdAt)} - {contract.id.slice(0, 8)}</option>)}</select></label>}
          <span className="tct-replace-control"><button type="button" className="tct-secondary-action" disabled title="PDF replacement is not available. Agreements are rendered from immutable stored terms." aria-label="Replace PDF unavailable: agreements are rendered from immutable stored terms"><Upload size={15} />Replace PDF</button><small>Stored terms are immutable.</small></span>
        </header>
        <div className="tct-toolbar">
          <span><FileCheck2 size={15} />Agreement preview</span>
          <span>Complete terms and policy</span>
        </div>
        <div className="tct-canvas" role="region" aria-label="Agreement document" tabIndex={0}><AgreementDocument contract={activeContract} /></div>
      </section>

      <aside className="tct-summary" aria-label="Contract summary and signers">
        <section>
          <h2>Contract summary</h2>
          <dl className="tct-summary-grid">
            <div><dt>Contract type</dt><dd>{isSelfDocumentation ? "Self-documentation" : "Bilateral"}</dd></div>
            <div><dt>Policy version</dt><dd>{activeContract.policyVersion || "Not configured"}</dd></div>
            <div><dt>Created</dt><dd>{displayDate(activeContract.createdAt)}</dd></div>
            <div><dt>Case association</dt><dd>{activeContract.caseId ? <a href={`/tenant?case=${encodeURIComponent(activeContract.caseId)}`}>{activeContract.caseId}</a> : "Not linked yet"}</dd></div>
            <div className="tct-summary-wide"><dt>Contract ID</dt><dd className="tct-mono">{activeContract.contractId || activeContract.id}</dd></div>
          </dl>
        </section>
        <section className="tct-signers">
          <header><h2>Signers</h2><span>{signedCount} of {signerCount} signed</span></header>
          <SignerCard role="tenant" name={tenantName} contract={activeContract} currentUser={activeContract.tenantUserId === user.id} />
          {!isSelfDocumentation && <SignerCard role="landlord" name={landlordName} contract={activeContract} currentUser={false} showReminder />}
        </section>
        <footer className="tct-summary-actions">
          {canSign ? <button type="button" className="tct-button tct-button-primary" onClick={() => { setSignError(""); setSigning(true); }}><PenLine size={16} />Sign contract</button> : <button type="button" className="tct-button tct-button-primary" disabled title={tenantAcceptance ? "Your signature is already recorded for this version." : activeContract.status === "used" ? "This agreement has already been used." : isSelfDocumentation ? "This tenant record was accepted when it was created." : !activeContract.policy ? "Legacy agreements without a machine-readable policy cannot be signed from this page." : "This agreement cannot be signed by this account."} aria-label={tenantAcceptance ? "Tenant signed: your signature is already recorded for this version" : "Sign unavailable for this agreement"}>{tenantAcceptance ? <Check size={16} /> : <LockKeyhole size={16} />}{tenantAcceptance ? "Tenant signed" : "Sign unavailable"}</button>}
          <button type="button" className="tct-button tct-button-secondary" disabled title="Finalization is automatic after both authenticated parties sign the same version." aria-label="Finalize agreement unavailable: finalization is automatic after both parties sign"><LockKeyhole size={16} />Finalize agreement</button>
        </footer>
        <p className="tct-auto-note">{isSelfDocumentation ? "This record is complete after the tenant acceptance. It does not grant payment or settlement authority." : "The agreement becomes active automatically after both authenticated parties sign this exact version."}</p>
        <Link href="/agreements" className="tct-details-link">View agreement details and governed actions</Link>
        <div className="tct-version-action"><div><strong>Need another agreement?</strong><span>Create a separate draft with the prototype terms for both parties to review.</span></div><button type="button" className="tct-button tct-button-secondary" onClick={() => void createAgreement()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <FilePlus2 size={15} />}Create new agreement</button></div>
      </aside>
    </div>
    {signing && <SignDialog contract={activeContract} busy={busy} error={signError} onClose={() => { if (!busy) { setSigning(false); setSignError(""); } }} onConfirm={accept} />}
  </section>;
}
