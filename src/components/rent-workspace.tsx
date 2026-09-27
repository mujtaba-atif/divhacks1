"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { ArrowDownToLine, Bell, Building2, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, FileImage, FilePenLine, FileText, FlaskConical, LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Menu, MessageSquare, Plus, PlugZap, RefreshCw, ShieldCheck, Upload, Wallet, X } from "lucide-react";
import type { AuthUser, CaseAction, CaseRecord, DashboardData, EvidenceRecord, EvidenceStage, PolicyResult } from "@/lib/types";
import { ActivityPanel, ActivityTimeline, canRelease, canReviewXrplSettlement, EscrowPanel, EvidencePanel, EvidenceReviewPanel, findOutboundMessage, MessagesPanel, OverviewPanel, type WorkspaceTab } from "./case-panels";
import { BuildingHistoryDialog, useCaseBuildingContext } from "./building-history";
import { FinancesPanel } from "./finances-panel";
import { NewCaseDialog, type NewCaseInput } from "./new-case-dialog";
import { TenantCasesDashboard } from "./tenant-cases-dashboard";
import { TenantEmptyWorkspace } from "./tenant-empty-workspace";
import { TenantContracts } from "./tenant-contracts";
import { Button, EmptyState, Modal, money, StatusBadge } from "./workspace-ui";
import { announceSessionChange, redirectIfSignedOut, useSessionGuard } from "./use-session-guard";
import { formatSettlementAsset, SETTLEMENT_AGENT_ID, SETTLEMENT_POLICY_VERSION } from "@/lib/xrpl-assets";
import "./tenant-design.css";

type ModalName = "new-case" | "upload" | "expense" | "building" | "integrations" | "reset" | "release" | "xrpl-settle" | "xrpl-agent" | "activity" | null;
type Toast = { message: string; tone: "success" | "info" } | null;
const tabs: { id: WorkspaceTab; label: string; icon: typeof LayoutDashboard }[] = [{ id: "overview", label: "Overview", icon: LayoutDashboard }, { id: "evidence", label: "Evidence", icon: FileImage }, { id: "messages", label: "Messages", icon: MessageSquare }, { id: "finances", label: "Finances", icon: Wallet }, { id: "escrow", label: "Escrow", icon: LockKeyhole }, { id: "activity", label: "Activity", icon: RefreshCw }];

class RequestError extends Error {
  constructor(message: string, readonly code?: string, readonly record?: CaseRecord, readonly policy?: PolicyResult) { super(message); }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  redirectIfSignedOut(response);
  let result: unknown;
  try { result = await response.json(); } catch { throw new Error("The server returned an unexpected response. Please try again."); }
  if (!response.ok) {
    const body = result && typeof result === "object" ? result as { error?: unknown; code?: unknown; case?: unknown; policy?: unknown } : {};
    throw new RequestError(typeof body.error === "string" ? body.error : "The request could not be completed.", typeof body.code === "string" ? body.code : undefined, body.case as CaseRecord | undefined, body.policy as PolicyResult | undefined);
  }
  return result as T;
}

function actionMessage(action: CaseAction, record: CaseRecord, policy?: PolicyResult): string {
  switch (action.action) {
    case "add_demo_evidence": return `${action.stage === "before" ? "Before" : "After"}-repair sample added to the case.`;
    case "analyze_evidence": return "Evidence analysis added to the case record.";
    case "send_message": {
      const message = findOutboundMessage(record, action.body, action.requestId);
      if (message?.delivery === "demo") return "Message saved in the demo. No external delivery.";
      if (message?.delivery === "sent") return "The provider accepted your message. Delivery and reading are not confirmed.";
      if (message?.delivery === "failed") return "Message not sent. Your draft is kept for review.";
      if (message?.delivery === "pending") return "Message delivery is pending. Do not resend.";
      return "Message delivery is unconfirmed. Review the conversation before another attempt.";
    }
    case "simulate_landlord_reply": return action.variant === "completed" ? "Sample repair completion recorded. Add and analyze after-repair evidence next." : "Sample repair appointment recorded.";
    case "record_landlord_reply": return `Landlord reply recorded: ${record.timeline.at(-1)?.title ?? "case updated"}.`;
    case "create_escrow": return `${money(record.escrow.amountCents)} set aside in simulated escrow.`;
    case "verify_repair": return record.verification?.verified ? "Repair verification passed. Your confirmation is the next step." : "Verification needs further evidence. Review the analysis before continuing.";
    case "confirm_resolution": return record.xrplSettlement?.status === "validated" ? "Repair confirmed. The agent settled on XRPL Testnet and recorded the validated receipt." : "Your repair confirmation has been recorded.";
    case "open_contract_dispute": return "Qualifying dispute recorded. The signed policy keeps disputed funds held.";
    case "evaluate_contract": return record.contractEvaluation?.allowed ? `Signed policy allowed ${record.contractEvaluation.action}.` : `Signed policy blocked release: ${record.contractEvaluation?.reason || "contract conditions did not pass"}.`;
    case "contract_security_demo": return "Contract attack blocked before signing. Nothing signed. Nothing submitted.";
    case "release_escrow": return "Simulated funds released. Your case is now resolved.";
    case "authorize_xrpl_agent": return record.xrplSettlement?.status === "validated" ? "Agent settlement validated on XRPL Testnet." : "Agent authorized. Settlement waits for verified repair and your confirmation.";
    case "enable_xrpl": return `${formatSettlementAsset({ asset: record.xrplSettlement?.asset, amount: record.xrplSettlement?.amount, amountDrops: record.xrplSettlement?.amountDrops || "0" })} settlement pinned to this case.`;
    case "settle_xrpl": return record.xrplSettlement?.status === "validated" ? "XRPL Testnet payment validated. The settlement receipt is recorded." : "XRPL payment is awaiting a validated ledger result.";
    case "reconcile_xrpl": return record.xrplSettlement?.status === "validated" ? "XRPL ledger validation confirmed." : "The latest XRPL ledger result is recorded.";
    case "xrpl_security_demo": return policy?.approved ? "Security dry run completed." : "Attack blocked before signing. Nothing was submitted.";
    case "add_expense": return "Expense added to your financial record.";
    case "sync_finances": return record.financialProfile?.status === "verified" ? `${record.financialProfile.binding.source === "demo" ? "Demo fixture" : "Nessie sandbox"} financial profile verified.` : "Financial verification is unavailable. Review the banking status before continuing.";
    case "confirm_transaction": return "Transaction confirmed and included in the case financial impact.";
    case "dismiss_transaction": return "Transaction dismissed from the case financial impact.";
    case "check_financial_binding": return policy?.approved ? "Financial binding verified. No settlement action initiated." : "Payment authorization blocked. No settlement action initiated.";
    case "policy_check": return policy?.approved ? "Simulated USD release policy checks passed." : "The simulated transaction was blocked by the policy checks. No funds moved.";
  }
}

function caseCreationMessage(record: CaseRecord): Toast {
  const request = [...record.messages].reverse().find((message) => message.sender === "agent" && message.originatingAgent === "tenant");
  if (!request) return { message: "Your repair case is open. Review Messages for the coordination status.", tone: "success" };
  if (request.delivery === "sent") return { message: "Your case is open. Photon accepted the Tenant Agent repair request; delivery is not confirmed.", tone: "success" };
  if (request.delivery === "demo") return { message: "Your case is open. The Tenant Agent repair request was recorded in Photon demo mode.", tone: "success" };
  if (request.delivery === "pending") return { message: "Your case is open. The Tenant Agent repair request is pending provider confirmation.", tone: "info" };
  if (request.delivery === "failed") return { message: "Your case is open, but the Tenant Agent repair request was not sent. Review Messages.", tone: "info" };
  return { message: "Your case is open. The Tenant Agent repair request has an unconfirmed delivery state. Review Messages before retrying.", tone: "info" };
}

export default function RentWorkspace({ user, initialView = "cases" }: { user: AuthUser; initialView?: "cases" | "contracts" }) {
  useSessionGuard(user);
  const [data, setData] = useState<DashboardData | null>(null);
  const [activeId, setActiveId] = useState("");
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [workspaceView, setWorkspaceView] = useState<"cases" | "case" | "contracts">(initialView);
  const casesDashboard = workspaceView === "cases";
  const contractsOpen = workspaceView === "contracts";
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [modal, setModal] = useState<ModalName>(null);
  const [preview, setPreview] = useState<EvidenceRecord | null>(null);
  const [policy, setPolicy] = useState<PolicyResult | null>(null);
  const [financialPolicy, setFinancialPolicy] = useState<PolicyResult | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const mutationBusy = useRef(false);
  const mutationVersion = useRef(0);
  const record = data?.cases.find((item) => item.id === activeId) || data?.cases[0];
  const buildingContext = useCaseBuildingContext(record?.id, "tenant", record?.building);
  const xrplIntegration = data?.integrations.find((item) => item.id === "xrpl");
  const geminiIntegration = data?.integrations.find((item) => item.id === "gemini");

  const loadDashboard = useCallback(async () => {
    try {
      setError(null);
      const result = await request<DashboardData>("/api/dashboard");
      setData(result);
      const params = new URLSearchParams(window.location.search);
      const requestedCase = params.get("case");
      const requestedTab = params.get("tab");
      const validCase = requestedCase && result.cases.some((item) => item.id === requestedCase) ? requestedCase : result.cases[0]?.id || "";
      const validTab = requestedTab && tabs.some((item) => item.id === requestedTab) ? requestedTab as WorkspaceTab : "overview";
      setActiveId(validCase);
      setWorkspaceView(params.get("view") === "contracts" ? "contracts" : !requestedCase && !requestedTab ? "cases" : "case");
      setTab(validTab);
      setPreview(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The workspace could not load."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);
  useEffect(() => {
    const restoreWorkspaceLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const requestedCase = params.get("case");
      const requestedTab = params.get("tab");
      const validCase = requestedCase && data?.cases.some((item) => item.id === requestedCase) ? requestedCase : data?.cases[0]?.id || "";
      const validTab = requestedTab && tabs.some((item) => item.id === requestedTab) ? requestedTab as WorkspaceTab : "overview";
      setActiveId(validCase);
      setTab(validTab);
      setWorkspaceView(params.get("view") === "contracts" ? "contracts" : !requestedCase && !requestedTab ? "cases" : "case");
      setPreview(null);
      setPolicy(null);
      setFinancialPolicy(null);
      setError(null);
      setModal(null);
      setMobileNav(false);
    };
    window.addEventListener("popstate", restoreWorkspaceLocation);
    return () => window.removeEventListener("popstate", restoreWorkspaceLocation);
  }, [data]);
  useEffect(() => {
    if (pending || contractsOpen) return;
    let cancelled = false;
    let refreshing = false;
    async function refreshDashboard() {
      if (document.visibilityState !== "visible" || mutationBusy.current || refreshing) return;
      const version = mutationVersion.current;
      refreshing = true;
      try {
        const latest = await request<DashboardData>("/api/dashboard");
        // A background read must never overwrite a newer mutation or another view.
        if (!cancelled && !mutationBusy.current && version === mutationVersion.current) setData(latest);
      } catch { /* Keep the current conversation and draft available during a refresh outage. */ }
      finally { refreshing = false; }
    }
    const interval = window.setInterval(() => { void refreshDashboard(); }, tab === "messages" ? 5_000 : 15_000);
    const onVisibilityChange = () => { void refreshDashboard(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { cancelled = true; window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [tab, pending, contractsOpen]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(null), 6500); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => { if (!mobileNav) return; const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileNav(false); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, [mobileNav]);

  function updateRecord(updated: CaseRecord) {
    setData((current) => current ? { ...current, cases: current.cases.map((item) => item.id === updated.id ? updated : item.status !== "resolved" ? { ...item, accountBalanceCents: updated.accountBalanceCents } : item) } : current);
  }

  async function runAction(action: CaseAction): Promise<CaseRecord | null> {
    if (!record || mutationBusy.current) return null;
    mutationBusy.current = true; mutationVersion.current += 1; setPending(action.action); setError(null); setToast(null); setFinancialPolicy(null);
    try {
      const result = await request<{ case: CaseRecord; policy?: PolicyResult }>(`/api/cases/${encodeURIComponent(record.id)}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
      updateRecord(result.case);
      setPolicy(action.action === "check_financial_binding" ? null : result.policy ?? null);
      if (action.action === "check_financial_binding") setFinancialPolicy(result.policy ?? null);
      const delivery = action.action === "send_message" ? findOutboundMessage(result.case, action.body, action.requestId)?.delivery : undefined;
      setToast({ message: actionMessage(action, result.case, result.policy), tone: (action.action === "send_message" && delivery !== "demo" && delivery !== "sent") || result.policy?.approved === false || (action.action === "verify_repair" && !result.case.verification?.verified) || (action.action === "sync_finances" && result.case.financialProfile?.status !== "verified") ? "info" : "success" });
      return result.case;
    } catch (cause) {
      if (cause instanceof RequestError) {
        if (cause.record) updateRecord(cause.record);
        setPolicy(cause.policy ?? null);
        setError(`${cause.code ? `${cause.code}: ` : ""}${cause.message}`);
      } else setError(cause instanceof Error ? cause.message : "The action could not be completed.");
      try { const latest = await request<DashboardData>("/api/dashboard"); setData(latest); } catch { /* Keep the current case visible if refresh fails. */ }
      return null;
    } finally { mutationBusy.current = false; setPending(null); }
  }

  async function createCase(input: NewCaseInput) {
    if (mutationBusy.current) return false;
    mutationBusy.current = true; mutationVersion.current += 1; setPending("create_case"); setError(null);
    try {
      const result = await request<{ case: CaseRecord }>("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      setData((current) => current ? { ...current, cases: [...current.cases, result.case] } : current);
      openCase(result.case); setToast(caseCreationMessage(result.case));
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The case could not be created."); return false; }
    finally { mutationBusy.current = false; setPending(null); }
  }

  async function uploadEvidence(form: FormData) {
    if (!record || mutationBusy.current) return false;
    mutationBusy.current = true; mutationVersion.current += 1; setPending("upload_evidence"); setError(null);
    try {
      const result = await request<{ case: CaseRecord }>(`/api/cases/${encodeURIComponent(record.id)}/evidence`, { method: "POST", body: form });
      const previousIds = new Set(record.evidence.map((item) => item.id));
      const uploaded = result.case.evidence.find((item) => !previousIds.has(item.id)) ?? result.case.evidence.at(-1);
      updateRecord(result.case); setPolicy(null); setFinancialPolicy(null); setModal(null); navigate("evidence");
      setToast(uploaded?.analysisError
        ? { message: "Evidence uploaded and saved. AI analysis needs attention; retry from the evidence card.", tone: "info" }
        : uploaded?.analysis?.source === "gemini"
          ? { message: "Evidence uploaded and analyzed with Gemini. Review the detected observations and confirm them.", tone: "success" }
          : { message: "Evidence uploaded. Any earlier repair confirmation has been cleared for a fresh review.", tone: "success" });
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The evidence could not be uploaded."); return false; }
    finally { mutationBusy.current = false; setPending(null); }
  }

  async function resetDemo() {
    if (mutationBusy.current) return;
    mutationBusy.current = true; mutationVersion.current += 1; setPending("reset"); setError(null);
    try {
      const result = await request<DashboardData>("/api/demo/reset", { method: "POST" });
      setData(result); setActiveId(result.cases[0]?.id || ""); showCases(); setModal(null); setPolicy(null); setFinancialPolicy(null); setToast({ message: "The demo workspace has been reset to its sample case.", tone: "success" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The demo could not be reset."); }
    finally { mutationBusy.current = false; setPending(null); }
  }

  async function logout() {
    if (mutationBusy.current) return;
    mutationBusy.current = true; setPending("logout"); setError(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Sign out could not be completed.");
      announceSessionChange();
      window.location.assign("/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign out could not be completed.");
      mutationBusy.current = false; setPending(null);
    }
  }

  function pushWorkspaceLocation(next: { dashboard?: boolean; contracts?: boolean; caseId?: string; tab?: WorkspaceTab }) {
    const url = new URL(window.location.href);
    url.searchParams.delete("case");
    url.searchParams.delete("tab");
    url.searchParams.delete("view");
    if (next.contracts) url.searchParams.set("view", "contracts");
    else if (!next.dashboard) {
      if (next.caseId) url.searchParams.set("case", next.caseId);
      url.searchParams.set("tab", next.tab || "overview");
    }
    const nextLocation = `${url.pathname}${url.search}${url.hash}`;
    const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextLocation !== currentLocation) window.history.pushState(null, "", nextLocation);
  }

  function navigate(next: WorkspaceTab) {
    pushWorkspaceLocation({ caseId: record?.id, tab: next });
    setTab(next); setWorkspaceView("case"); setPreview(null); setMobileNav(false);
  }
  function showCases() {
    pushWorkspaceLocation({ dashboard: true });
    setWorkspaceView("cases"); setPreview(null); setMobileNav(false);
  }
  function showContracts() {
    pushWorkspaceLocation({ contracts: true });
    setWorkspaceView("contracts"); setPreview(null); setMobileNav(false); setModal(null);
  }
  function openCase(next: CaseRecord) {
    pushWorkspaceLocation({ caseId: next.id, tab: "overview" });
    setActiveId(next.id); setTab("overview"); setWorkspaceView("case"); setPreview(null); setPolicy(null); setFinancialPolicy(null); setError(null);
  }
  function reviewEvidence(item: EvidenceRecord, openEvidenceTab = false) {
    if (openEvidenceTab) navigate("evidence");
    setPreview(item);
  }
  function openModal(next: ModalName) { setError(null); setModal(next); setMobileNav(false); }
  function closeModal() { if (!mutationBusy.current) { setModal(null); setError(null); } }

  return <div className={`workspace-shell tenant-design${contractsOpen ? " tenant-contracts-active" : ""}`}>
    <a href="#main-content" className="skip-link">Skip to case content</a>
    {mobileNav && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`} aria-label="Workspace navigation">
      <a className="tenant-brand" href="/" aria-label="RentEscrow home"><Image src="/figma/door.png" alt="" width={40} height={40} sizes="40px" /><span><strong>RentEscrow</strong><small>NYC TENANT PROTECTION</small></span></a>
      <nav className="main-nav tenant-primary-nav">
        <button className={casesDashboard ? "active" : ""} onClick={showCases}><LayoutDashboard size={17} /><span>My cases</span></button>
        <button className={workspaceView === "case" && tab === "messages" ? "active" : ""} onClick={() => navigate("messages")}><MessageSquare size={17} /><span>Messages</span></button>
        <button className={workspaceView === "case" && tab === "finances" ? "active" : ""} onClick={() => navigate("finances")}><Wallet size={17} /><span>Finances</span></button>
        <button className={`tenant-contracts-nav${contractsOpen ? " active" : ""}`} aria-current={contractsOpen ? "page" : undefined} onClick={showContracts}><FilePenLine size={18} /><span>Contracts</span>{contractsOpen && <i aria-hidden="true" />}</button>
      </nav>
      <div className="sidebar-bottom tenant-sidebar-bottom">
        <button className="tenant-support" onClick={() => openModal("integrations")} disabled={!data}><CircleHelp size={16} /><span>Tenant support</span></button>
        <div className="tenant-profile"><span className="tenant-avatar">{user.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><div><strong>Your account</strong><span>{user.displayName}</span></div><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void logout()} disabled={pending === "logout"}>{pending === "logout" ? <LoaderCircle className="spin" size={17} /> : <LogOut size={17} />}</button></div>
      </div>
    </aside>

    <div className="workspace-body"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open workspace navigation" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}><Menu size={21} /></button><a className="mobile-brand" href="/">RentEscrow</a>{contractsOpen ? <nav className="tenant-contract-breadcrumb" aria-label="Breadcrumb"><span>Tenant</span><span aria-hidden="true">/</span><strong aria-current="page">Contracts</strong></nav> : <span>{casesDashboard ? "My cases" : "New York City housing"}</span>}</div><div className="topbar-right"><button className="tenant-topbar-link" type="button" onClick={() => openModal("integrations")} disabled={!data}>Help center</button><button className="tenant-topbar-link tenant-notifications" type="button" onClick={() => setToast({ message: "You’re all caught up. Case updates will appear here.", tone: "info" })}><Bell size={14} />Notifications</button></div></header>
      <main id="main-content" className="main-content">
        {contractsOpen ? <TenantContracts user={user} /> : loading ? <div className="workspace-loading" role="status"><LoaderCircle className="spin" size={27} /><h1>Opening your workspace</h1><p>Loading your repair cases and records.</p></div> : !data ? <div className="workspace-loading"><EmptyState icon={CircleHelp} title="Your workspace could not load" action={<Button icon={RefreshCw} onClick={() => { setLoading(true); void loadDashboard(); }}>Try again</Button>}>{error || "Please try again in a moment."}</EmptyState></div> : casesDashboard ? <TenantCasesDashboard cases={data.cases} onCreate={() => openModal("new-case")} onOpen={openCase} /> : !record ? <TenantEmptyWorkspace tab={tab} onTab={navigate} onCreate={() => openModal("new-case")} onCases={showCases} /> : <>
          <div className="tenant-case-breadcrumb"><button type="button" onClick={showCases}>My cases</button><span>/</span><span>{record.title}</span></div>
          <div className="case-header"><div><div className="tenant-title-row"><h1>{record.title}</h1><StatusBadge status={record.status} /></div><div className="case-location"><span>{record.id}</span><span className="location-divider" /><span>{record.building.address}, Apt {record.apartment}</span></div></div><div className="case-header-actions"><label className="case-switcher"><span className="sr-only">Select case</span><select aria-label="Select case" value={record.id} onChange={(event) => { const nextCase = data.cases.find((item) => item.id === event.target.value); if (nextCase) openCase(nextCase); }} disabled={!!pending}>{data.cases.map((item) => <option value={item.id} key={item.id}>{item.id} · {item.title}</option>)}</select><ChevronDown size={14} /></label><a className="button button-secondary icon-only-mobile" href={`/api/cases/${encodeURIComponent(record.id)}/export`} download aria-label="Export case dossier" title="Export case dossier"><ArrowDownToLine size={16} /><span>Export case</span></a><Button variant="primary" icon={Plus} onClick={() => openModal("new-case")} disabled={!!pending}>New case</Button></div></div>
          <div className="case-tabs" role="tablist" aria-label="Case sections">{tabs.map(({ id, label, icon: Icon }) => <button role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} key={id} className={tab === id ? "active" : ""} onClick={() => navigate(id)} onKeyDown={(event) => { const index = tabs.findIndex((item) => item.id === id); let next: number | null = null; if (event.key === "ArrowRight") next = (index + 1) % tabs.length; if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length; if (event.key === "Home") next = 0; if (event.key === "End") next = tabs.length - 1; if (next !== null) { event.preventDefault(); navigate(tabs[next].id); document.getElementById(`tab-${tabs[next].id}`)?.focus(); } }}><Icon size={16} />{label}{id === "evidence" && <span>{record.evidence.length}</span>}</button>)}</div>
          {error && !modal && <div className="error-banner" role="alert"><CircleHelp size={18} /><span>{error}</span><button className="icon-button" onClick={() => setError(null)} title="Dismiss error" aria-label="Dismiss error"><X size={16} /></button></div>}
          {record.status === "resolved" && <div className="resolved-banner"><CheckCircle2 size={19} /><div><strong>Repair resolved. Case complete.</strong><span>Your evidence, messages, and settlement receipts remain available for export.</span></div></div>}
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="tab-panel">
            {tab === "overview" && <OverviewPanel record={record} pending={pending} onAction={runAction} onTab={navigate} onUpload={() => openModal("upload")} onPreview={(item) => reviewEvidence(item, true)} onActivity={() => navigate("activity")} onBuilding={() => openModal("building")} buildingContext={buildingContext} />}
            {tab === "evidence" && (preview ? <EvidenceReviewPanel item={preview} onBack={() => setPreview(null)} onUpload={() => openModal("upload")} /> : <EvidencePanel record={record} pending={pending} onAction={runAction} onUpload={() => openModal("upload")} onPreview={(item) => reviewEvidence(item)} geminiIntegration={geminiIntegration} />)}
            {tab === "messages" && <MessagesPanel record={record} pending={pending} onAction={runAction} integration={data.integrations.find((item) => item.id === "photon")} />}
            {tab === "finances" && <FinancesPanel record={record} pending={pending} onAction={runAction} onExpense={() => openModal("expense")} policy={financialPolicy} nessieConfigured={data.integrations.some((item) => item.id === "nessie" && item.status !== "demo")} />}
            {tab === "escrow" && <EscrowPanel record={record} pending={pending} onAction={runAction} onRelease={() => openModal("release")} onXrplReview={() => openModal("xrpl-settle")} onXrplAgentReview={() => openModal("xrpl-agent")} policy={policy} xrplIntegration={xrplIntegration} />}
            {tab === "activity" && <ActivityPanel record={record} onUpload={() => openModal("upload")} />}
          </div>
          <footer className="workspace-footer"><span><ShieldCheck size={13} />{record.contractId ? "Your case. Your evidence. Your signed policy." : "Your case. Your evidence. Your approval."}</span><span>{record.building.source === "demo" ? "Sample NYC case" : "NYC repair case"} · Simulated USD{record.xrplSettlement ? " · XRPL Testnet" : ""}</span></footer>
        </>}
      </main>
    </div>

    {toast && <div className={`toast toast-${toast.tone}`} role="status"><span>{toast.tone === "success" ? <CheckCircle2 size={19} /> : <ShieldCheck size={19} />}</span><p>{toast.message}</p><button className="icon-button" title="Dismiss notification" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16} /></button></div>}
    {modal === "new-case" && <NewCaseDialog onClose={closeModal} onCreate={createCase} busy={pending === "create_case"} />}
    {modal === "upload" && record && <UploadDialog record={record} onClose={closeModal} onUpload={uploadEvidence} pending={pending === "upload_evidence"} error={error} geminiConfigured={geminiIntegration?.status === "configured"} />}
    {modal === "expense" && record && <ExpenseDialog onClose={closeModal} onAction={runAction} pending={pending === "add_expense"} error={error} />}
    {modal === "building" && record && <BuildingHistoryDialog context={buildingContext} issue={record.issue} address={record.building.address} borough={record.building.borough} onClose={closeModal} searchable />}
    {modal === "activity" && record && <Modal title="Case activity" subtitle={`Complete history for ${record.id}`} onClose={closeModal}><ActivityTimeline record={record} /></Modal>}
    {modal === "integrations" && data && <Modal title="Workspace connections" subtitle="Integration status for this environment." onClose={closeModal}><div className="integration-list">{data.integrations.map((integration) => <div className="integration-row" key={integration.id}><span className="integration-icon"><PlugZap size={19} /></span><div><strong>{integration.name}</strong><p>{integration.detail}</p></div><span className={`subtle-badge ${integration.status === "configured" || integration.status === "public" ? "badge-green" : ""}`}>{integration.status === "demo" ? "Demo" : integration.status === "configured" ? "Configured" : integration.status === "public" ? "Public data" : "Unavailable"}</span></div>)}</div><div className="inline-note note-amber"><FlaskConical size={18} /><p>The rent balance is simulated USD. When configured and explicitly enabled for a case, settlement uses a real Payment on XRPL Testnet with valueless Testnet RLUSD or Test XRP.</p></div></Modal>}
    {modal === "reset" && <Modal title="Reset the demo workspace?" subtitle="This removes cases, uploads, messages, expenses, registered profiles, and contracts in this browser session and restores the sample case." onClose={closeModal}><div className="inline-note note-amber"><FileText size={19} /><p>Export any case records you want to keep before resetting.</p></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><Button onClick={closeModal} disabled={!!pending}>Keep workspace</Button><Button variant="danger" icon={RefreshCw} busy={pending === "reset"} onClick={() => { void resetDemo(); }}>Reset demo</Button></div></Modal>}
    {modal === "release" && record && <Modal title="Approve simulated rent release" subtitle="The repair review passed and your confirmation is recorded." onClose={closeModal}><div className="release-confirm-amount"><LockKeyhole size={24} /><strong>{money(record.escrow.amountCents)}</strong><span>SIMULATED USD</span></div><dl className="escrow-details"><div><dt>To</dt><dd>{record.landlordName}</dd></div><div><dt>Destination</dt><dd className="mono break-word">{record.escrow.destination}</dd></div><div><dt>Case</dt><dd>{record.id}</dd></div></dl><p className="muted">Approving releases the simulated escrow balance and closes this repair case.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><Button onClick={closeModal} disabled={!!pending}>Cancel</Button><Button variant="primary" icon={ShieldCheck} busy={pending === "release_escrow"} disabled={!canRelease(record)} onClick={async () => { const updated = await runAction({ action: "release_escrow" }); if (updated) setModal(null); }}>Approve release</Button></div></Modal>}
    {(modal === "xrpl-settle" || modal === "xrpl-agent") && record?.xrplSettlement && <Modal title={modal === "xrpl-agent" ? "Authorize XRPL settlement agent" : "Review XRPL Testnet settlement"} subtitle="Confirm the exact Testnet asset amount and server-pinned recipient before signing." onClose={closeModal}><div className="release-confirm-amount"><Wallet size={24} /><strong>{formatSettlementAsset(record.xrplSettlement)}</strong><span>XRPL TESTNET · VALUELESS TEST FUNDS</span></div><dl className="escrow-details"><div><dt>Agent ID</dt><dd className="mono break-word">{record.xrplSettlement.agentId || SETTLEMENT_AGENT_ID}</dd></div><div><dt>Policy</dt><dd className="mono break-word">{record.xrplSettlement.policyVersion || SETTLEMENT_POLICY_VERSION}</dd></div><div><dt>Asset</dt><dd>{record.xrplSettlement.asset || "XRP"}</dd></div><div><dt>Recipient</dt><dd className="mono break-word">{record.xrplSettlement.destination}</dd></div><div><dt>Source</dt><dd className="mono break-word">{record.xrplSettlement.source}</dd></div><div><dt>Case / settlement</dt><dd className="mono break-word">{record.id} / {record.xrplSettlement.id}</dd></div><div><dt>Transaction</dt><dd>Payment on XRPL Testnet</dd></div><div><dt>Application amount</dt><dd>{money(record.xrplSettlement.amountUsdCents)} simulated USD</dd></div>{record.xrplSettlement.asset === "RLUSD" && <><div><dt>Currency</dt><dd className="mono break-word">{record.xrplSettlement.currency}</dd></div><div><dt>Issuer</dt><dd className="mono break-word">{record.xrplSettlement.issuer}</dd></div></>}</dl><div className="inline-note note-green"><ShieldCheck size={18} /><p>{modal === "xrpl-agent" ? "Authorize the agent to request this single payment once repair verification and your confirmation pass. If both already passed, it runs now. The agent cannot change the recipient, asset, issuer, currency, amount, network, or signing credentials. " : ""}The server rebuilds and rechecks the final payment immediately before server-side signing, then waits for a validated ledger result and matching delivered amount. Validation is required before the case is settled.</p></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><Button onClick={closeModal} disabled={!!pending}>Cancel</Button><Button variant="primary" icon={ShieldCheck} busy={pending === "settle_xrpl" || pending === "authorize_xrpl_agent"} disabled={!!pending || xrplIntegration?.status !== "configured" || (modal === "xrpl-agent" ? record.xrplSettlement.status !== "ready" || !!record.xrplSettlement.hash || !!record.xrplSettlement.agentAuthorizedAt : !canReviewXrplSettlement(record))} onClick={async () => { const updated = await runAction({ action: modal === "xrpl-agent" ? "authorize_xrpl_agent" : "settle_xrpl" }); if (updated) setModal(null); }}>{modal === "xrpl-agent" ? "Authorize agent settlement" : "Approve Testnet payment"}</Button></div></Modal>}
  </div>;
}

function UploadDialog({ record, onClose, onUpload, pending, error, geminiConfigured }: { record: CaseRecord; onClose: () => void; onUpload: (data: FormData) => Promise<boolean>; pending: boolean; error: string | null; geminiConfigured: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<EvidenceStage>(record.repairReported ? "after" : "before");
  const [fileError, setFileError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  function chooseFile(next?: File) {
    setFileError("");
    if (!next) return;
    if (next.size > 5 * 1024 * 1024) { setFile(null); setFileError("Choose a file smaller than 5 MiB."); return; }
    if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(next.type)) { setFile(null); setFileError("Choose a JPG, PNG, WebP, or PDF file."); return; }
    setFile(next);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) { setFileError("Choose a file to upload."); return; }
    const form = new FormData(event.currentTarget); form.set("file", file); form.set("stage", stage);
    if (!String(form.get("temperatureF")).trim()) form.delete("temperatureF");
    await onUpload(form);
  }
  return <Modal title="Add case evidence" subtitle="Photos, documents, and receipts for your repair record." onClose={onClose}><form onSubmit={submit}><div className={`upload-zone ${file ? "upload-selected" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files[0]); }}><span><Upload size={26} /></span><strong>{file ? file.name : "Choose a file or drop it here"}</strong><p>{file ? `${(file.size / 1024).toFixed(0)} KB · Ready to upload${geminiConfigured ? " for analysis" : ""}` : "JPG, PNG, WebP, or PDF · Up to 5 MiB"}</p><Button onClick={() => inputRef.current?.click()} disabled={pending}>{file ? "Choose another file" : "Browse files"}</Button><input ref={inputRef} type="file" aria-label="Evidence file" className="sr-only" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(event) => chooseFile(event.target.files?.[0])} /></div><div className="form-grid"><label className="field">Evidence stage<select name="stage" value={stage} onChange={(event) => setStage(event.target.value as EvidenceStage)} disabled={pending}><option value="before">Before repair</option><option value="after">After repair</option><option value="receipt">Expense receipt</option><option value="other">Other document</option></select></label><label className="field">Temperature (°F, optional)<input name="temperatureF" type="number" min="-50" max="150" step="0.1" placeholder="e.g. 54" disabled={pending} /></label><label className="field field-wide">Notes<textarea name="note" rows={3} maxLength={2000} placeholder="Where and when was this captured? What does it show?" disabled={pending} /></label></div>{(fileError || error) && <p className="form-error" role="alert">{fileError || error}</p>}{pending && <p className="muted small" role="status">Uploading evidence and running server-side analysis…</p>}<div className={`inline-note ${geminiConfigured ? "note-green" : "note-neutral"}`}><CircleHelp size={17} /><p>{geminiConfigured ? "The server will request Gemini analysis for this upload and report any availability errors. Detected observations require your confirmation and are not legal findings." : "Gemini is not configured. The upload will remain saved as case evidence, and clearly labeled sample analysis remains available in the Evidence tab."}</p></div><div className="modal-footer"><Button onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" icon={Upload} variant="primary" disabled={!file} busy={pending}>{geminiConfigured ? "Upload & analyze" : "Add to case"}</Button></div></form></Modal>;
}

function ExpenseDialog({ onClose, onAction, pending, error }: { onClose: () => void; onAction: (action: CaseAction) => Promise<CaseRecord | null>; pending: boolean; error: string | null }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    const result = await onAction({ action: "add_expense", label: String(values.get("label")).trim(), amountCents: Math.round(Number(values.get("amount")) * 100), category: String(values.get("category")) });
    if (result) onClose();
  }
  return <Modal title="Record an expense" subtitle="Add a cost associated with this repair issue." onClose={onClose}><form onSubmit={submit}><div className="form-grid"><label className="field field-wide">Description<input name="label" placeholder="e.g. Portable space heater" required maxLength={200} /></label><label className="field">Amount (USD)<input name="amount" type="number" min="0.01" max="100000" step="0.01" required placeholder="0.00" /></label><label className="field">Category<select name="category"><option value="supplies">Supplies</option><option value="utilities">Utilities</option><option value="accommodation">Accommodation</option><option value="transportation">Transportation</option><option value="other">Other</option></select></label></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><Button onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" icon={Plus} variant="primary" busy={pending}>Add expense</Button></div></form></Modal>;
}
