"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { BellRing, Building2, CalendarClock, CheckCircle2, ChevronRight, CircleHelp, FileImage, FileText, Hammer, LayoutDashboard, LoaderCircle, LogOut, Menu, MessageSquare, ShieldCheck, Upload, UsersRound, Wrench, X } from "lucide-react";
import type { AuthUser, EvidenceRecord, IntegrationStatus, LandlordCase } from "@/lib/types";
import { BuildingHistoryDialog, BuildingHistorySummary, type BuildingContextState, useCaseBuildingContext } from "./building-history";
import { messageDeliveryLabel, messageRoleLabel, photonModeLabel } from "./case-panels";
import { LandlordOperations } from "./landlord-operations";
import { Button, EmptyState, fullDate, Modal, money, StatusBadge, time } from "./workspace-ui";
import { announceSessionChange, redirectIfSignedOut, useSessionGuard } from "./use-session-guard";

type LandlordTab = "operations" | "cases" | "messages" | "repairs" | "property";
type PendingAction = "load" | "logout" | "message" | "schedule" | "report_complete" | "evidence" | null;

const landlordTabs = [
  { id: "operations" as const, label: "Operations", icon: BellRing },
  { id: "cases" as const, label: "Open cases", icon: LayoutDashboard },
  { id: "messages" as const, label: "Messages", icon: MessageSquare },
  { id: "repairs" as const, label: "Repairs", icon: Hammer },
  { id: "property" as const, label: "Property", icon: Building2 },
];

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  redirectIfSignedOut(response);
  const result = await response.json().catch(() => null) as ({ error?: unknown } & T) | null;
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "The request could not be completed.");
  if (!result) throw new Error("The server returned an unexpected response.");
  return result;
}

const initials = (name: string) => name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const evidenceSource = (record: EvidenceRecord) => record.dataUrl
  || (record.isDemo && record.stage === "before" ? "/evidence-before.png" : null)
  || (record.isDemo && record.stage === "after" ? "/evidence-after.png" : null);
const localDateMinimum = () => {
  const value = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return value.toISOString().slice(0, 16);
};

export default function LandlordWorkspace({ user }: { user: AuthUser }) {
  useSessionGuard(user);
  const [cases, setCases] = useState<LandlordCase[]>([]);
  const [activeId, setActiveId] = useState("");
  const [tab, setTab] = useState<LandlordTab>("operations");
  const [pending, setPending] = useState<PendingAction>("load");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [preview, setPreview] = useState<EvidenceRecord | null>(null);
  const [buildingOpen, setBuildingOpen] = useState(false);
  const [messagingIntegration, setMessagingIntegration] = useState<IntegrationStatus>();
  const mutationBusy = useRef(false);
  const mutationVersion = useRef(0);
  const activeCase = cases.find((record) => record.id === activeId) ?? cases[0];
  const buildingContext = useCaseBuildingContext(activeCase?.id, "landlord");

  const reviewOperationCase = useCallback((caseId: string) => {
    setActiveId(caseId);
    setTab("cases");
    setError("");
    setNotice("");
  }, []);

  const loadCases = useCallback(async () => {
    setPending("load");
    setError("");
    try {
      const result = await request<{ cases: LandlordCase[]; user: AuthUser; integration?: IntegrationStatus }>("/api/landlord/cases");
      setCases(result.cases);
      setMessagingIntegration(result.integration);
      setActiveId((current) => result.cases.some((record) => record.id === current) ? current : result.cases[0]?.id ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The property workspace could not load.");
    } finally {
      setPending(null);
    }
  }, []);

  useEffect(() => { void loadCases(); }, [loadCases]);
  useEffect(() => {
    if (pending || tab !== "messages") return;
    let cancelled = false;
    let refreshing = false;
    async function refreshCases() {
      if (document.visibilityState !== "visible" || mutationBusy.current || refreshing) return;
      const version = mutationVersion.current;
      refreshing = true;
      try {
        const result = await request<{ cases: LandlordCase[]; integration?: IntegrationStatus }>("/api/landlord/cases");
        if (!cancelled && !mutationBusy.current && version === mutationVersion.current) {
          setCases(result.cases);
          setMessagingIntegration(result.integration);
          setActiveId((current) => result.cases.some((record) => record.id === current) ? current : result.cases[0]?.id ?? "");
        }
      } catch { /* Keep the current thread and draft available during a refresh outage. */ }
      finally { refreshing = false; }
    }
    const timer = window.setInterval(() => { void refreshCases(); }, 5_000);
    const onVisibilityChange = () => { void refreshCases(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [pending, tab]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 6000); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!mobileNav) return; const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileNav(false); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [mobileNav]);

  function navigate(next: LandlordTab) {
    setTab(next);
    setMobileNav(false);
    setError("");
  }

  function updateCase(updated: LandlordCase) {
    setCases((current) => current.map((record) => record.id === updated.id ? updated : record));
  }

  async function runAction(action: { action: "message"; body: string } | { action: "schedule"; scheduledFor: string; notes: string } | { action: "report_complete"; notes: string }, pendingAction: Exclude<PendingAction, "load" | "logout" | "evidence" | null>) {
    if (!activeCase || mutationBusy.current) return false;
    mutationBusy.current = true;
    mutationVersion.current += 1;
    setPending(pendingAction);
    setError("");
    setNotice("");
    try {
      const result = await request<{ case: LandlordCase }>(`/api/landlord/cases/${encodeURIComponent(activeCase.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      updateCase(result.case);
      setNotice(action.action === "message" ? "Message added to the case conversation." : action.action === "schedule" ? "Maintenance appointment recorded and shared with the tenant." : "Repair completion reported. The case now awaits tenant evidence and confirmation.");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed.");
      return false;
    } finally {
      mutationBusy.current = false;
      setPending(null);
    }
  }

  async function uploadEvidence(form: FormData) {
    if (!activeCase || mutationBusy.current) return false;
    mutationBusy.current = true;
    mutationVersion.current += 1;
    setPending("evidence");
    setError("");
    setNotice("");
    try {
      form.set("stage", "other");
      const result = await request<{ case: LandlordCase }>(`/api/landlord/cases/${encodeURIComponent(activeCase.id)}/evidence`, { method: "POST", body: form });
      updateCase(result.case);
      setNotice("Repair evidence uploaded to the case record. Tenant after-repair evidence is still required for verification.");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The repair evidence could not be uploaded.");
      return false;
    } finally {
      mutationBusy.current = false;
      setPending(null);
    }
  }

  async function logout() {
    if (mutationBusy.current) return;
    mutationBusy.current = true;
    setPending("logout");
    setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Sign out could not be completed.");
      announceSessionChange();
      window.location.assign("/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign out could not be completed.");
      mutationBusy.current = false;
      setPending(null);
    }
  }

  return <div className="workspace-shell landlord-shell">
    <a href="#landlord-main" className="skip-link">Skip to property operations</a>
    {mobileNav && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar landlord-sidebar ${mobileNav ? "sidebar-open" : ""}`} aria-label="Property manager navigation">
      <a className="brand" href="/" aria-label="RentEscrow NYC home"><span className="brand-mark"><Building2 size={23} /><span /></span><span>RentEscrow<span className="brand-city">NYC</span></span></a>
      <div className="workspace-switch"><div className="workspace-symbol"><Building2 size={18} /></div><div><strong>Property workspace</strong><span>Manager account</span></div><ShieldCheck size={16} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav className="main-nav">{landlordTabs.filter(({ id }) => id !== "property").map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? "active" : ""} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span>{id === "cases" && <span className="nav-count">{cases.length}</span>}</button>)}</nav>
      <div className="sidebar-divider" />
      <div className="nav-label">PROPERTIES</div>
      <nav className="main-nav"><button className={tab === "property" ? "active" : ""} onClick={() => navigate("property")}><Building2 size={18} /><span>{activeCase?.property.address ?? "123 Example Street"}</span></button></nav>
      <div className="sidebar-bottom">
        <div className="manager-note"><ShieldCheck size={16} /><div><strong>Privacy-aware view</strong><p>Only case details and high-level settlement status are shown.</p></div></div>
        <div className="tenant-profile"><span className="tenant-avatar">{initials(user.displayName)}</span><div><strong>{user.displayName}</strong><span>Property manager</span>{user.maskedPhone && <span>{user.maskedPhone}</span>}</div><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void logout()} disabled={pending === "logout"}>{pending === "logout" ? <LoaderCircle className="spin" size={17} /> : <LogOut size={17} />}</button></div>
      </div>
    </aside>

    <div className="workspace-body">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open workspace navigation" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}><Menu size={21} /></button><a className="mobile-brand" href="/">RentEscrow <span>NYC</span></a><span>Property workspace</span><ChevronRight size={14} /><strong>{landlordTabs.find((item) => item.id === tab)?.label}</strong></div><div className="topbar-right"><span className="header-identity"><span>{user.displayName}</span><small>{user.email}</small></span><span className="topbar-avatar">{initials(user.displayName)}</span><button className="button button-secondary header-logout" onClick={() => void logout()} disabled={pending === "logout"}>{pending === "logout" ? <LoaderCircle className="spin" size={15} /> : <LogOut size={15} />}<span>Sign out</span></button></div></header>
      <main id="landlord-main" className="main-content landlord-main">
        {pending === "load" ? <div className="workspace-loading" role="status"><LoaderCircle className="spin" size={27} /><h1>Opening the property workspace</h1><p>Loading assigned cases and repair records.</p></div> : error && cases.length === 0 && tab !== "operations" ? <div className="workspace-loading"><EmptyState icon={CircleHelp} title="The workspace could not load" action={<Button icon={LoaderCircle} onClick={() => void loadCases()}>Try again</Button>}>{error}</EmptyState></div> : cases.length === 0 && tab !== "operations" ? <EmptyState icon={FileText} title="No assigned cases">Cases for your managed properties will appear here when a tenant opens one.</EmptyState> : <>
          <header className="landlord-page-heading"><div><span className="eyebrow">PROPERTY MANAGER</span><h1>{tab === "operations" ? "Operations overview" : tab === "cases" ? "Assigned repair cases" : tab === "messages" ? "Tenant messages" : tab === "repairs" ? "Repair coordination" : "Managed property"}</h1><p>{tab === "operations" ? "See what needs your decision while RentEscrow handles routine coordination." : tab === "cases" ? "Review tenant reports and keep each repair moving." : tab === "messages" ? "Keep case communication in one accountable thread." : tab === "repairs" ? "Schedule work, document repairs, and report completion." : "Cases assigned to your property portfolio."}</p></div>{tab !== "operations" && activeCase && <label className="landlord-case-select"><span>Current case</span><select value={activeCase.id} onChange={(event) => { setActiveId(event.target.value); setError(""); setNotice(""); }}>{cases.map((record) => <option key={record.id} value={record.id}>{record.id} · {record.title}</option>)}</select></label>}</header>
          {error && <div className="error-banner" role="alert"><CircleHelp size={18} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button></div>}
          {notice && <div className="landlord-notice" role="status"><CheckCircle2 size={18} /><span>{notice}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={16} /></button></div>}
          {tab === "operations" && <LandlordOperations fallbackCases={cases} onReviewCase={reviewOperationCase} />}
          {tab === "cases" && <CasesView cases={cases} activeCase={activeCase} onSelect={(id) => { setActiveId(id); setNotice(""); }} onNavigate={navigate} onPreview={setPreview} buildingContext={buildingContext} onBuilding={() => setBuildingOpen(true)} />}
          {tab === "messages" && activeCase && <MessagesView key={activeCase.id} record={activeCase} landlordName={user.displayName} integration={messagingIntegration} pending={pending === "message"} onSend={(body) => runAction({ action: "message", body }, "message")} />}
          {tab === "repairs" && activeCase && <RepairsView key={activeCase.id} record={activeCase} pending={pending} error={error} onSchedule={(scheduledFor, notes) => runAction({ action: "schedule", scheduledFor, notes }, "schedule")} onComplete={(notes) => runAction({ action: "report_complete", notes }, "report_complete")} onUpload={uploadEvidence} onPreview={setPreview} />}
          {tab === "property" && activeCase && <PropertyView cases={cases} record={activeCase} onSelect={(id) => { setActiveId(id); setTab("cases"); }} buildingContext={buildingContext} onBuilding={() => setBuildingOpen(true)} />}
        </>}
      </main>
    </div>
    {preview && <EvidencePreview evidence={preview} onClose={() => setPreview(null)} />}
    {buildingOpen && activeCase && <BuildingHistoryDialog context={buildingContext} issue={activeCase.issue} address={activeCase.property.address} borough={activeCase.property.borough} onClose={() => setBuildingOpen(false)} />}
  </div>;
}

function CasesView({ cases, activeCase, onSelect, onNavigate, onPreview, buildingContext, onBuilding }: { cases: LandlordCase[]; activeCase?: LandlordCase; onSelect: (id: string) => void; onNavigate: (tab: LandlordTab) => void; onPreview: (record: EvidenceRecord) => void; buildingContext: BuildingContextState; onBuilding: () => void }) {
  if (!activeCase) return null;
  return <div className="landlord-cases-layout">
    <section className="landlord-case-list" aria-label="Assigned cases">
      <div className="landlord-section-title"><span>Open cases</span><span className="count">{cases.length}</span></div>
      {cases.map((record) => <button key={record.id} className={`landlord-case-card ${record.id === activeCase.id ? "selected" : ""}`} onClick={() => onSelect(record.id)} aria-pressed={record.id === activeCase.id}>
        <span className="case-card-top"><strong>{record.id}</strong><StatusBadge status={record.status} /></span>
        <span className="case-card-title">{record.title}</span>
        <span className="case-card-property">{record.property.address} · Apt {record.property.apartment}</span>
        <span className="case-card-meta"><span>Tenant: {record.tenant.displayName}</span><span>Reported {fullDate(record.createdAt)}</span></span>
      </button>)}
    </section>
    <CaseReview record={activeCase} onNavigate={onNavigate} onPreview={onPreview} buildingContext={buildingContext} onBuilding={onBuilding} />
  </div>;
}

function CaseReview({ record, onNavigate, onPreview, buildingContext, onBuilding }: { record: LandlordCase; onNavigate: (tab: LandlordTab) => void; onPreview: (record: EvidenceRecord) => void; buildingContext: BuildingContextState; onBuilding: () => void }) {
  return <article className="landlord-case-detail">
    <header className="landlord-case-detail-heading"><div><div className="case-detail-meta"><span>{record.id}</span><StatusBadge status={record.status} /></div><h2>{record.title}</h2><p><Building2 size={14} />{record.property.address}, Apt {record.property.apartment} · {record.property.borough}</p></div><div className="landlord-case-actions"><Button icon={MessageSquare} onClick={() => onNavigate("messages")}>Message tenant</Button><Button variant="primary" icon={Wrench} onClick={() => onNavigate("repairs")}>Manage repair</Button></div></header>
    <div className="landlord-detail-grid">
      <section><span className="eyebrow">TENANT REPORT</span><h3>{record.issue.replaceAll("_", " ")}</h3><p>{record.description}</p><dl className="landlord-facts"><div><dt>Tenant</dt><dd>{record.tenant.displayName}</dd></div><div><dt>First noticed</dt><dd>{fullDate(record.noticedAt)}</dd></div><div><dt>Repair status</dt><dd>{record.repairReported ? "Reported complete" : "Action needed"}</dd></div></dl></section>
      <section className="settlement-summary"><span className="eyebrow">CASE FINANCIAL SUMMARY</span><p>High-level case status only. Tenant banking details stay private.</p><div className="settlement-metrics"><div><span>Disputed amount</span><strong>{money(record.financialSummary.disputedAmountCents)}</strong></div><div><span>Escrow</span><strong className="capitalize">{record.financialSummary.escrowStatus}</strong></div><div><span>Settlement</span><strong className="capitalize">{record.financialSummary.settlementStatus}</strong></div></div></section>
    </div>
    <BuildingHistorySummary building={buildingContext.building} issue={record.issue} address={record.property.address} borough={record.property.borough} loading={buildingContext.loading} error={buildingContext.error} onOpen={onBuilding} />
    <section className="landlord-evidence-section"><div className="landlord-section-title"><span>Relevant evidence</span><span className="count">{record.evidence.length}</span></div>{record.evidence.length ? <div className="landlord-evidence-grid">{record.evidence.slice(0, 4).map((evidence) => <EvidenceTile key={evidence.id} evidence={evidence} onPreview={onPreview} />)}</div> : <p className="landlord-empty-copy">No evidence has been added to this case yet.</p>}</section>
    <div className="landlord-detail-grid landlord-lower-grid">
      <Timeline record={record} />
      <section><div className="landlord-section-title"><span>Latest messages</span><Button variant="ghost" onClick={() => onNavigate("messages")}>Open thread</Button></div>{record.messages.length ? <div className="landlord-message-preview">{record.messages.slice(-3).map((message) => <div key={message.id}><span><strong>{message.sender === "landlord" ? "You" : message.sender === "tenant" ? record.tenant.displayName : "RentEscrow"}</strong><time>{fullDate(message.createdAt)}</time></span><p>{message.body}</p></div>)}</div> : <p className="landlord-empty-copy">No case messages yet.</p>}</section>
    </div>
  </article>;
}

function MessagesView({ record, landlordName, integration, pending, onSend }: { record: LandlordCase; landlordName: string; integration: IntegrationStatus | undefined; pending: boolean; onSend: (body: string) => Promise<boolean> }) {
  const [body, setBody] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = body.trim();
    if (!message) return;
    if (await onSend(message)) setBody("");
  }
  return <div className="landlord-message-layout">
    <section className="landlord-thread"><header><span className="demo-account-avatar">{initials(record.tenant.displayName)}</span><div><strong>{record.tenant.displayName}</strong><span>{record.id} · {record.property.address}, Apt {record.property.apartment}</span></div><span className="subtle-badge" role="status">{photonModeLabel(integration)}</span></header><div className="landlord-thread-messages">{record.messages.length ? record.messages.map((message) => <LandlordMessage key={message.id} message={message} record={record} landlordName={landlordName} />) : <EmptyState icon={MessageSquare} title="No messages yet">Start the case conversation with a clear repair update.</EmptyState>}</div></section>
    <form className="landlord-composer" onSubmit={submit}><span className="eyebrow">CASE RECORD</span><h2>Add case message</h2><p>This form saves a note in RentEscrow. For iMessage coordination and agent interpretation, reply to the case conversation on your phone.</p><label htmlFor="landlord-message">Message</label><textarea id="landlord-message" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Add a scheduling update or repair note…" rows={8} maxLength={2000} disabled={pending} required /><div className="composer-count"><span>Case {record.id} · visible to {record.tenant.displayName}</span><span>{body.length}/2000</span></div><Button type="submit" variant="primary" icon={MessageSquare} busy={pending} disabled={!body.trim()}>Add case message</Button><p className="panel-footnote">{integration?.detail || "Photon messaging is unavailable. Phone replies cannot be received right now."}</p>{integration?.status === "configured" && <p className="panel-footnote">Phone messages show provider acceptance separately from delivery and reading.</p>}{integration?.status === "demo" && <p className="panel-footnote">Photon demo activity stays within this workspace.</p>}</form>
  </div>;
}

function LandlordMessage({ message, record, landlordName }: { message: LandlordCase["messages"][number]; record: LandlordCase; landlordName: string }) {
  return <article className={message.sender === "landlord" || (message.sender === "agent" && message.originatingAgent === "landlord") ? "from-manager" : ""}>
    <div><strong>{messageRoleLabel(message, record.tenant.displayName, landlordName, "landlord")}</strong><time>{fullDate(message.createdAt)} · {time(message.createdAt)}</time></div>
    <p>{message.body}</p>
    {message.interpretation && <p className="message-interpretation"><strong>Agent interpretation · {message.interpretation.source === "gemini" ? "Gemini" : "Rules"}:</strong> {message.interpretation.summary}{message.interpretation.scheduledFor ? ` · ${message.interpretation.scheduledFor}` : ""}</p>}
    <span className="message-delivery">{messageDeliveryLabel(message)}</span>
    {message.delivery === "sent" && <p className="message-state-note">Accepted by the provider; delivery and reading are not confirmed.</p>}
    {message.delivery === "pending" && <p className="message-state-note">Awaiting provider confirmation. Do not resend.</p>}
    {message.delivery === "uncertain" && <p className="message-state-note">Provider acceptance could not be confirmed.</p>}
    {message.failureReason && <p className="message-state-note message-state-error" role="status">{message.failureReason}</p>}
  </article>;
}

function RepairsView({ record, pending, error, onSchedule, onComplete, onUpload, onPreview }: { record: LandlordCase; pending: PendingAction; error: string; onSchedule: (date: string, notes: string) => Promise<boolean>; onComplete: (notes: string) => Promise<boolean>; onUpload: (form: FormData) => Promise<boolean>; onPreview: (record: EvidenceRecord) => void }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const latestSchedule = [...record.repairs].reverse().find((repair) => repair.kind === "scheduled");
  return <div className="repair-workspace">
    <section className="repair-status-card"><div className={`repair-status-icon ${record.repairReported ? "complete" : ""}`}>{record.repairReported ? <CheckCircle2 size={25} /> : <Wrench size={25} />}</div><div><span className="eyebrow">CURRENT REPAIR STATUS</span><h2>{record.repairReported ? "Repair reported complete" : latestSchedule ? "Maintenance scheduled" : "Awaiting repair action"}</h2><p>{record.repairReported ? "The tenant must upload after-repair evidence and confirm the resolution. Reporting completion does not release funds or resolve the case." : latestSchedule?.scheduledFor ? `Scheduled for ${fullDate(latestSchedule.scheduledFor)}. Keep the tenant updated if timing changes.` : "Schedule maintenance or coordinate the next repair step with the tenant."}</p></div></section>
    <div className="repair-action-grid">
      <ScheduleForm pending={pending === "schedule"} disabled={record.repairReported || record.status === "resolved"} onSchedule={onSchedule} />
      <CompleteForm pending={pending === "report_complete"} reported={record.repairReported} onComplete={onComplete} />
      <section className="repair-action-card"><span className="repair-action-number">03</span><div><span className="eyebrow">DOCUMENT THE WORK</span><h2>Upload repair evidence</h2><p>{record.verification?.verified ? "Tenant evidence verification is complete. Send a case message to discuss any further documents." : "Add a work-order photo, invoice, or repair document. It remains landlord evidence and does not replace the tenant’s after-repair proof."}</p></div><Button icon={Upload} onClick={() => setUploadOpen(true)} disabled={!!pending || record.status === "resolved" || !!record.verification?.verified}>Upload evidence</Button></section>
    </div>
    <section className="repair-record"><div className="landlord-section-title"><span>Repair record</span><span className="count">{record.repairs.length}</span></div>{record.repairs.length ? <div className="repair-history">{[...record.repairs].reverse().map((repair) => <article key={repair.id}><span className="timeline-dot" /><div><strong>{repair.kind === "scheduled" ? "Maintenance scheduled" : repair.kind === "reported_complete" ? "Repair reported complete" : "Repair evidence uploaded"}</strong><p>{repair.notes || "No additional notes."}</p>{repair.scheduledFor && <span>Appointment: {fullDate(repair.scheduledFor)} · {time(repair.scheduledFor)}</span>}<time>{fullDate(repair.createdAt)} · {time(repair.createdAt)}</time></div></article>)}</div> : <p className="landlord-empty-copy">No repair actions have been recorded.</p>}</section>
    {record.evidence.some((item) => record.repairs.some((repair) => repair.evidenceId === item.id)) && <section className="landlord-evidence-section"><div className="landlord-section-title"><span>Repair uploads</span></div><div className="landlord-evidence-grid">{record.evidence.filter((item) => record.repairs.some((repair) => repair.evidenceId === item.id)).map((evidence) => <EvidenceTile key={evidence.id} evidence={evidence} onPreview={onPreview} />)}</div></section>}
    {uploadOpen && <RepairUploadDialog pending={pending === "evidence"} error={error} onClose={() => setUploadOpen(false)} onUpload={async (form) => { const ok = await onUpload(form); if (ok) setUploadOpen(false); return ok; }} />}
  </div>;
}

function ScheduleForm({ pending, disabled, onSchedule }: { pending: boolean; disabled: boolean; onSchedule: (date: string, notes: string) => Promise<boolean> }) {
  const [validation, setValidation] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setValidation("");
    const data = new FormData(form);
    const raw = String(data.get("scheduledFor") || "");
    const scheduled = new Date(raw);
    if (!raw || Number.isNaN(scheduled.getTime()) || scheduled.getTime() <= Date.now()) { setValidation("Choose a valid future date and time."); return; }
    if (await onSchedule(scheduled.toISOString(), String(data.get("notes") || "").trim())) form.reset();
  }
  return <form className="repair-action-card" onSubmit={submit}><span className="repair-action-number">01</span><div><span className="eyebrow">PLAN THE VISIT</span><h2>Schedule maintenance</h2><p>Record a future appointment so the tenant has a clear date and time.</p></div><label>Appointment<input name="scheduledFor" type="datetime-local" min={localDateMinimum()} required disabled={pending || disabled} /></label><label>Notes<textarea name="notes" rows={3} maxLength={2000} placeholder="Who is coming and what should the tenant expect?" required disabled={pending || disabled} /></label>{validation && <p className="form-error" role="alert">{validation}</p>}<Button type="submit" icon={CalendarClock} busy={pending} disabled={disabled}>{disabled ? "Repair already reported" : "Save appointment"}</Button></form>;
}

function CompleteForm({ pending, reported, onComplete }: { pending: boolean; reported: boolean; onComplete: (notes: string) => Promise<boolean> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const notes = String(new FormData(form).get("notes") || "").trim();
    if (await onComplete(notes)) form.reset();
  }
  return <form className="repair-action-card" onSubmit={submit}><span className="repair-action-number">02</span><div><span className="eyebrow">AFTER THE WORK</span><h2>Report repair complete</h2><p>This alerts the tenant to upload after-repair evidence. The case stays open until tenant verification and confirmation.</p></div><label>Completion notes<textarea name="notes" rows={4} maxLength={2000} placeholder="Describe the work completed…" required disabled={pending || reported} /></label><Button type="submit" icon={CheckCircle2} busy={pending} disabled={reported}>{reported ? "Completion reported" : "Report complete"}</Button></form>;
}

function RepairUploadDialog({ pending, error, onClose, onUpload }: { pending: boolean; error: string; onClose: () => void; onUpload: (form: FormData) => Promise<boolean> }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  function select(next?: File) {
    setFileError("");
    if (!next) return;
    if (next.size > 5 * 1024 * 1024) { setFile(null); setFileError("Choose a file smaller than 5 MiB."); return; }
    if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(next.type)) { setFile(null); setFileError("Choose a JPG, PNG, WebP, or PDF file."); return; }
    setFile(next);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) { setFileError("Choose a file to upload."); return; }
    const form = new FormData(event.currentTarget);
    form.set("file", file);
    form.set("stage", "other");
    await onUpload(form);
  }
  return <Modal title="Upload repair evidence" subtitle="Add a photo, invoice, work order, or repair document." onClose={onClose}><form onSubmit={submit}><label className={`upload-zone ${file ? "upload-selected" : ""}`}><span><Upload size={26} /></span><strong>{file?.name ?? "Choose a repair file"}</strong><p>{file ? `${Math.ceil(file.size / 1024)} KB · Ready to upload` : "JPG, PNG, WebP, or PDF · Up to 5 MiB"}</p><input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(event) => select(event.target.files?.[0])} disabled={pending} /></label><label className="field landlord-upload-note">Repair note<textarea name="note" rows={4} maxLength={2000} placeholder="What does this document show?" disabled={pending} /></label>{(fileError || error) && <p className="form-error" role="alert">{fileError || error}</p>}<div className="inline-note note-neutral"><ShieldCheck size={17} /><p>This upload documents the landlord&apos;s work. Only tenant-submitted after-repair evidence can satisfy the tenant verification step.</p></div><div className="modal-footer"><Button onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" variant="primary" icon={Upload} busy={pending} disabled={!file}>Upload evidence</Button></div></form></Modal>;
}

function PropertyView({ cases, record, onSelect, buildingContext, onBuilding }: { cases: LandlordCase[]; record: LandlordCase; onSelect: (id: string) => void; buildingContext: BuildingContextState; onBuilding: () => void }) {
  const propertyCases = cases.filter((item) => item.property.id === record.property.id);
  return <div className="property-view"><section className="property-hero"><span className="property-icon"><Building2 size={28} /></span><div><span className="eyebrow">MANAGED PROPERTY</span><h2>{record.property.address}</h2><p>{record.property.borough}, New York · Property ID {record.property.id}</p></div><span className="subtle-badge badge-green">{propertyCases.length} assigned {propertyCases.length === 1 ? "case" : "cases"}</span></section><BuildingHistorySummary building={buildingContext.building} issue={record.issue} address={record.property.address} borough={record.property.borough} loading={buildingContext.loading} error={buildingContext.error} onOpen={onBuilding} /><section className="property-cases"><div className="landlord-section-title"><span>Cases at this property</span></div>{propertyCases.map((item) => <article key={item.id}><span className="property-case-icon"><Wrench size={18} /></span><div><strong>{item.id} · {item.title}</strong><p>Apt {item.property.apartment} · {item.tenant.displayName} · Opened {fullDate(item.createdAt)}</p></div><StatusBadge status={item.status} /><Button onClick={() => onSelect(item.id)}>Review case</Button></article>)}</section><section className="privacy-card"><ShieldCheck size={21} /><div><strong>Tenant privacy is built into this view</strong><p>You can review repair records and high-level escrow status. Bank accounts, transactions, identifiers, and settlement controls remain available only to the tenant.</p></div></section></div>;
}

function EvidenceTile({ evidence, onPreview }: { evidence: EvidenceRecord; onPreview: (record: EvidenceRecord) => void }) {
  const source = evidenceSource(evidence);
  return <article className="landlord-evidence-card"><button onClick={() => onPreview(evidence)} aria-label={`Preview ${evidence.name}`}>{source && evidence.mimeType.startsWith("image/") ? <img src={source} alt="" /> : <span><FileImage size={24} /><small>{evidence.mimeType === "application/pdf" ? "PDF" : "Document"}</small></span>}</button><div><span className="evidence-card-title"><strong>{evidence.name}</strong><small className="capitalize">{evidence.stage}</small></span><p>{evidence.analysis?.summary ?? evidence.note ?? "No summary available."}</p>{evidence.analysis && <span className="gemini-summary"><ShieldCheck size={13} />{evidence.analysis.source === "gemini" ? "Gemini evidence summary" : "Sample evidence summary"}</span>}</div></article>;
}

function Timeline({ record }: { record: LandlordCase }) {
  return <section><div className="landlord-section-title"><span>Case timeline</span></div>{record.timeline.length ? <div className="landlord-timeline">{[...record.timeline].reverse().slice(0, 6).map((event) => <article key={event.id}><span className="timeline-dot" /><div><strong>{event.title}</strong><p>{event.detail}</p><time>{fullDate(event.createdAt)} · {time(event.createdAt)}</time></div></article>)}</div> : <p className="landlord-empty-copy">No timeline activity yet.</p>}</section>;
}

function EvidencePreview({ evidence, onClose }: { evidence: EvidenceRecord; onClose: () => void }) {
  const source = evidenceSource(evidence);
  return <Modal title={evidence.name} subtitle={`${evidence.stage.replaceAll("_", " ")} evidence · ${fullDate(evidence.createdAt)}`} onClose={onClose} wide>{source && evidence.mimeType.startsWith("image/") ? <img className="evidence-full-preview" src={source} alt={evidence.name} /> : source ? <a className="button button-secondary" href={source} download={evidence.name}><FileText size={16} />Download document</a> : <p className="muted">A preview is not available for this document.</p>}{evidence.note && <p className="preview-note">{evidence.note}</p>}{evidence.analysis && <div className="inline-note note-green"><ShieldCheck size={18} /><div><strong>{evidence.analysis.source === "gemini" ? "Gemini evidence summary" : "Sample evidence summary"}</strong><p>{evidence.analysis.summary}</p>{evidence.analysis.observations?.length ? <p><strong>Observed:</strong> {evidence.analysis.observations.join("; ")}</p> : null}<p className="muted small">AI observations support review and do not authorize settlement or replace tenant confirmation.</p></div></div>}</Modal>;
}
