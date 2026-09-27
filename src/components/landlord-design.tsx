"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Bookmark, Building2, Check, CheckCheck, ChevronLeft, ChevronRight, CircleAlert, CircleHelp, CloudUpload, Expand, FileSignature, FileText, Filter, Fingerprint, ImagePlus, KeyRound, LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Menu, MessageCircle, Paperclip, Search, Send, ShieldCheck, UserRound, Wrench, X } from "lucide-react";
import type { AuthUser, EvidenceRecord, IntegrationStatus, LandlordCase } from "@/lib/types";
import { fullDate, Modal, money, shortDate, time } from "./workspace-ui";
import { messageDeliveryLabel, messageRoleLabel, photonModeLabel } from "./case-panels";
import { LandlordAccount, LandlordProperties } from "./landlord-account-properties";
import { LandlordContracts } from "./landlord-contracts";
import "./landlord-design.css";

export type LandlordView = "operations" | "property" | "cases" | "detail" | "messages" | "repairs" | "account" | "contracts";
type CaseTab = "overview" | "evidence" | "conversation" | "activity" | "escrow";
const navigation = [
  { id: "operations", label: "Overview", icon: LayoutDashboard },
  { id: "property", label: "Properties", icon: Building2 },
  { id: "cases", label: "Repair Cases", icon: Wrench },
  { id: "messages", label: "Messages", icon: MessageCircle },
  { id: "account", label: "Account", icon: UserRound },
  { id: "contracts", label: "Contracts", icon: FileSignature },
] as const;
const caseTabs: { id: CaseTab; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "evidence", label: "Evidence" },
  { id: "conversation", label: "Conversation" }, { id: "activity", label: "Activity & completion" },
  { id: "escrow", label: "Escrow & timeline" },
];
const initials = (name: string) => name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const stateFor = (record: LandlordCase) => record.status === "resolved" ? { label: "Resolved", tone: "green", action: "View record" }
  : record.repairReported || ["verification", "verified"].includes(record.status) ? { label: "Tenant review", tone: "green", action: "Await tenant" }
  : record.status === "awaiting_repair" || record.repairs.length ? { label: "In progress", tone: "blue", action: "Post update" }
  : { label: "New request", tone: "amber", action: "Acknowledge" };

export function LandlordDesign({ user, cases, activeCase, tab, pending, error, notice, integration, onNavigate, onSelect, onLogout, onRetry, onDismissError, onDismissNotice, onSend, onUpload, onPreview, reviewPanel, repairsPanel }: {
  user: AuthUser; cases: LandlordCase[]; activeCase?: LandlordCase; tab: LandlordView;
  pending: string | null; error: string; notice: string; integration?: IntegrationStatus;
  onNavigate: (tab: LandlordView) => void; onSelect: (id: string) => void;
  onLogout: () => void; onRetry: () => void; onDismissError: () => void; onDismissNotice: () => void;
  onSend: (body: string) => Promise<boolean>; onUpload: () => void; onPreview: (item: EvidenceRecord) => void;
  reviewPanel: ReactNode; repairsPanel: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [caseTab, setCaseTab] = useState<CaseTab>("overview");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const isCase = ["detail", "messages", "repairs"].includes(tab);
  const currentCaseTab = tab === "messages" ? "conversation" : tab === "repairs" ? "activity" : caseTab;
  const activeNav = tab === "detail" || tab === "repairs" ? "cases" : tab;
  const breadcrumb = isCase ? "Repair case" : tab === "account" ? "Account & Access" : navigation.find((item) => item.id === tab)?.label;

  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebar.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMobileOpen(false); menuButton.current?.focus(); }
      if (event.key !== "Tab") return;
      const controls = sidebar.current?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled)");
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", keydown); };
  }, [mobileOpen]);

  function navigate(view: LandlordView) { onNavigate(view); setMobileOpen(false); }
  function openCase(id: string, next: CaseTab = "overview") {
    onSelect(id); setCaseTab(next);
    navigate(next === "conversation" ? "messages" : next === "activity" ? "repairs" : "detail");
  }
  function selectCaseTab(next: CaseTab) {
    setCaseTab(next); onNavigate(next === "conversation" ? "messages" : next === "activity" ? "repairs" : "detail");
  }
  function acknowledge() {
    if (!activeCase) return;
    setDrafts((current) => ({ ...current, [activeCase.id]: current[activeCase.id] || `Hi ${activeCase.tenant.displayName}, I have received your repair request for ${activeCase.title.toLowerCase()}. I will follow up with the next steps.` }));
    selectCaseTab("conversation");
  }

  return <div className={`ld-design ${tab === "contracts" ? "ld-contract-mode" : ""}`}>
    <a className="skip-link" href="#landlord-main">Skip to landlord workspace</a>
    {mobileOpen && <button className="ld-backdrop" aria-label="Close navigation" onClick={() => { setMobileOpen(false); menuButton.current?.focus(); }} />}
    <aside ref={sidebar} className={`ld-sidebar ${mobileOpen ? "is-open" : ""}`} aria-label="Property manager navigation">
      <a href="/landlord" className="ld-brand"><span><ShieldCheck size={20} /></span>RentEscrow</a>
      <button className="ld-mobile-close" aria-label="Close navigation" onClick={() => { setMobileOpen(false); menuButton.current?.focus(); }}><X size={20} /></button>
      <div className="ld-workspace-label"><small>LANDLORD WORKSPACE</small><strong>{user.displayName}</strong></div>
      <nav aria-label="Landlord workspace">{navigation.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)} aria-current={activeNav === id ? "page" : undefined}><Icon size={19} /><span>{label}</span></button>)}</nav>
      <div className="ld-profile"><span className="ld-avatar">{initials(user.displayName)}</span><div><strong>{user.displayName}</strong><small>Landlord account</small></div><button onClick={onLogout} disabled={!!pending} aria-label="Sign out" title="Sign out">{pending === "logout" ? <LoaderCircle className="spin" size={18} /> : <LogOut size={18} />}</button></div>
    </aside>
    <div className="ld-body">
      <header className="ld-topbar"><div><button ref={menuButton} className="ld-mobile-menu" aria-label="Open workspace navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Menu size={21} /></button><span>Landlord</span><ChevronRight size={14} /><strong>{breadcrumb}</strong></div><button className="ld-help" onClick={() => setHelp(true)}><CircleHelp size={16} />Help</button></header>
      <main id="landlord-main" className="ld-main">
        {error && <div className="ld-note error" role="alert"><CircleAlert size={18} /><p>{error}</p><button aria-label="Dismiss error" onClick={onDismissError}><X size={16} /></button></div>}
        {notice && <div className="ld-note" role="status"><Check size={18} /><p>{notice}</p><button aria-label="Dismiss notification" onClick={onDismissNotice}><X size={16} /></button></div>}
        {pending === "load" ? <div className="ld-loading" role="status"><LoaderCircle className="spin" size={26} /><h1>Opening your landlord workspace</h1></div>
          : error && !cases.length ? <div className="ld-empty"><CircleAlert size={26} /><h1>The workspace could not load</h1><button className="ld-button" onClick={onRetry}>Try again</button></div>
          : <>
            {tab === "operations" && <Overview cases={cases} onOpen={openCase} onCases={() => navigate("cases")} />}
            {tab === "cases" && <RepairCases cases={cases} onOpen={openCase} />}
            {tab === "property" && <LandlordProperties cases={cases} onOpenCase={(id) => openCase(id)} />}
            {tab === "account" && <LandlordAccount user={user} cases={cases} onOpenProperty={() => navigate("property")} />}
            {tab === "contracts" && <LandlordContracts user={user} />}
            {isCase && (activeCase ? <>
              <div className="ld-heading"><div><h1>Repair case</h1><p>{currentCaseTab === "evidence" ? "Evidence attached to the shared case record." : currentCaseTab === "conversation" ? "Case-scoped conversation with explicit account identities." : "Review the request and coordinate the next repair step."}</p></div>{cases.length > 1 && <label className="ld-case-select"><span className="sr-only">Current case</span><select value={activeCase.id} onChange={(event) => onSelect(event.target.value)}>{cases.map((record) => <option key={record.id} value={record.id}>{record.id} · {record.tenant.displayName}</option>)}</select></label>}</div>
              <div className="ld-case-heading"><div><h2>{activeCase.title}</h2><p>{activeCase.property.address} · Unit {activeCase.property.apartment} · Tenant {activeCase.tenant.displayName}</p></div><button className="ld-button primary" onClick={acknowledge} disabled={!!pending || activeCase.status === "resolved"}><Check size={17} />Acknowledge request</button></div>
              <div className="ld-case-tabs" role="tablist" aria-label="Repair case sections" onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = caseTabs.findIndex((item) => item.id === currentCaseTab);
                const next = event.key === "Home" ? 0 : event.key === "End" ? caseTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + caseTabs.length) % caseTabs.length;
                selectCaseTab(caseTabs[next].id); document.getElementById(`ld-tab-${caseTabs[next].id}`)?.focus();
              }}>{caseTabs.map(({ id, label }) => <button key={id} id={`ld-tab-${id}`} role="tab" aria-selected={currentCaseTab === id} aria-controls="ld-case-panel" tabIndex={currentCaseTab === id ? 0 : -1} onClick={() => selectCaseTab(id)}>{label}</button>)}</div>
              <div id="ld-case-panel" className="ld-case-panel" role="tabpanel" aria-labelledby={`ld-tab-${currentCaseTab}`}>
                {currentCaseTab === "overview" && reviewPanel}
                {currentCaseTab === "evidence" && <CaseEvidence record={activeCase} user={user} busy={!!pending} onUpload={onUpload} onPreview={onPreview} onAudit={() => selectCaseTab("escrow")} />}
                {currentCaseTab === "conversation" && <Conversation record={activeCase} user={user} integration={integration} busy={!!pending} body={drafts[activeCase.id] || ""} onBody={(body) => setDrafts((current) => ({ ...current, [activeCase.id]: body }))} onSend={onSend} onAttach={onUpload} onAccess={() => selectCaseTab("activity")} />}
                {currentCaseTab === "activity" && repairsPanel}
                {currentCaseTab === "escrow" && <EscrowTimeline record={activeCase} />}
              </div>
            </> : <div className="ld-empty"><MessageCircle size={28} /><h1>No assigned cases</h1><p>Assigned repair cases and conversations will appear here.</p></div>)}
          </>}
      </main>
    </div>
    {help && <Modal title="Landlord workspace" onClose={() => setHelp(false)}><div className="ld-help-copy"><p>Review assigned repair cases, share case notes, schedule maintenance, and upload repair evidence.</p><p>Tenant accounts remain separate. Only the tenant can confirm a repair; landlord actions cannot release escrow funds.</p><button className="ld-button" onClick={() => setHelp(false)}>Back to workspace</button></div></Modal>}
  </div>;
}

function Overview({ cases, onOpen, onCases }: { cases: LandlordCase[]; onOpen: (id: string, tab?: CaseTab) => void; onCases: () => void }) {
  const needsAction = cases.filter((record) => stateFor(record).tone === "amber");
  const units = new Set(cases.map((record) => `${record.property.id}:${record.property.apartment}`)).size;
  const upcoming = cases.flatMap((record) => record.repairs.filter((repair) => repair.kind === "scheduled" && repair.scheduledFor && Date.parse(repair.scheduledFor) >= Date.now() && Date.parse(repair.scheduledFor) <= Date.now() + 7 * 86400000).map((repair) => ({ record, repair }))).sort((a, b) => a.repair.scheduledFor!.localeCompare(b.repair.scheduledFor!));
  const recent = cases.flatMap((record) => record.messages.filter((message) => message.sender === "tenant").map((message) => ({ record, message }))).sort((a, b) => b.message.createdAt.localeCompare(a.message.createdAt)).slice(0, 3);
  return <>
    <div className="ld-heading"><div><h1>Overview</h1><p>Repairs requiring your attention across {units} {units === 1 ? "unit" : "units"}.</p></div><button className="ld-button" onClick={onCases}><ArrowRight size={17} />View all repair cases</button></div>
    <div className={`ld-note ${needsAction.length ? "amber" : ""}`}><CircleAlert size={18} /><div><strong>{needsAction.length ? `${needsAction.length} ${needsAction.length === 1 ? "repair needs" : "repairs need"} your attention` : "Your repair work queue is up to date"}</strong><p>{needsAction.length ? `Review ${needsAction[0].id} and coordinate the next repair step. ` : "No new repair requests. "}AI summaries are advisory only; review the original case record before acting.</p></div></div>
    <section className="ld-panel ld-queue" aria-labelledby="ld-work-queue"><header className="ld-queue-heading"><h2 id="ld-work-queue">Repair work queue</h2><dl className="ld-metrics">{[
      { label: "New", tone: "amber", count: needsAction.length },
      { label: "In progress", tone: "blue", count: cases.filter((record) => stateFor(record).label === "In progress").length },
      { label: "Tenant review", tone: "green", count: cases.filter((record) => stateFor(record).label === "Tenant review").length },
      { label: "Resolved", tone: "muted", count: cases.filter((record) => record.status === "resolved").length },
    ].map((metric) => <div key={metric.label} className={metric.tone}><dt>{metric.label}</dt><dd>{metric.count}</dd></div>)}</dl></header>
      <div className="ld-table-scroll"><table className="ld-table"><thead><tr><th>Case</th><th>Repair / property</th><th>Tenant</th><th>Status</th><th>Last update</th><th>Next action</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{cases.slice(0, 5).map((record) => <tr key={record.id}><td><button className="ld-text-button strong" onClick={() => onOpen(record.id)}>{record.id}</button></td><td><strong className="ld-repair-title">{record.title}</strong><small>{record.property.address} · {record.property.apartment}</small></td><td>{record.tenant.displayName}</td><td><CaseStatus record={record} /></td><td className="ld-muted">{shortDate(record.updatedAt)}</td><td><button className="ld-text-button" onClick={() => onOpen(record.id, record.status === "resolved" ? "overview" : "conversation")}>{stateFor(record).action}</button></td><td><button className="ld-icon" aria-label={`Open case ${record.id}`} title="Open case" onClick={() => onOpen(record.id)}><ArrowUpRight size={17} /></button></td></tr>)}</tbody></table></div>
      {!cases.length && <p className="ld-table-empty">No assigned repair requests yet.</p>}
      <footer className="ld-table-footer"><span>Showing {Math.min(cases.length, 5)} of {cases.length} repair cases</span><button className="ld-text-button strong" onClick={onCases}>View complete queue <ArrowRight size={15} /></button></footer>
    </section>
    <div className="ld-overview-bottom"><section className="ld-panel"><header className="ld-section-heading"><h2>Upcoming access</h2><span>Next 7 days</span></header>{upcoming.length ? upcoming.slice(0, 3).map(({ record, repair }) => <button className="ld-list-row" key={repair.id} onClick={() => onOpen(record.id, "activity")}><span className="ld-date-block">{shortDate(repair.scheduledFor!)}</span><span><strong>{record.title}</strong><small>{record.property.address} · {record.property.apartment} · {time(repair.scheduledFor!)}</small></span></button>) : <p className="ld-muted ld-no-items">No upcoming appointments.</p>}</section>
      <section className="ld-panel"><header className="ld-section-heading"><h2>Recent messages</h2><span>{recent.length} recent</span></header>{recent.length ? recent.map(({ record, message }) => <button className="ld-list-row" key={`${record.id}:${message.id}`} onClick={() => onOpen(record.id, "conversation")}><span className="ld-avatar">{initials(record.tenant.displayName)}</span><span><strong>{record.tenant.displayName}</strong><small className="ld-message-snippet">{message.body}</small></span><time>{shortDate(message.createdAt)}</time></button>) : <p className="ld-muted ld-no-items">No tenant messages yet.</p>}</section></div>
  </>;
}

function CaseStatus({ record }: { record: LandlordCase }) { const state = stateFor(record); return <span className={`ld-badge ${state.tone}`}><span />{state.label}</span>; }

function RepairCases({ cases, onOpen }: { cases: LandlordCase[]; onOpen: (id: string, tab?: CaseTab) => void }) {
  const [search, setSearch] = useState("");
  const [property, setProperty] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    try { const value = JSON.parse(sessionStorage.getItem("landlord-case-view") || "null"); if (value && typeof value.search === "string" && typeof value.property === "string" && typeof value.status === "string") { setSearch(value.search); setProperty(value.property); setStatus(value.status); } } catch { /* Ignore unavailable or stale browser view preferences. */ }
  }, []);
  const properties = [...new Map(cases.map((record) => [record.property.id, record.property.address])).entries()];
  const filtered = cases.filter((record) => (!property || record.property.id === property) && (!status || stateFor(record).label === status) && `${record.id} ${record.title} ${record.property.address} ${record.property.apartment} ${record.tenant.displayName}`.toLowerCase().includes(search.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 7) - 1));
  const displayed = filtered.slice(currentPage * 7, currentPage * 7 + 7);
  function changed() { setPage(0); setSaved(false); setSaveError(""); }
  return <>
    <div className="ld-heading"><div><h1>Repair Cases</h1><p>Find, triage, and progress repairs across all associated properties.</p></div></div>
    <div className="ld-filters"><label className="ld-search"><span>Search cases</span><div><Search size={18} /><input placeholder="Search case, issue, tenant, or unit" value={search} onChange={(event) => { setSearch(event.target.value); changed(); }} /></div></label><label><span>Property</span><select aria-label="Property" value={property} onChange={(event) => { setProperty(event.target.value); changed(); }}><option value="">All properties</option>{properties.map(([id, address]) => <option key={id} value={id}>{address}</option>)}</select></label><label><span>Status</span><select aria-label="Status" value={status} onChange={(event) => { setStatus(event.target.value); changed(); }}><option value="">All statuses</option>{["New request", "In progress", "Tenant review", "Resolved"].map((label) => <option key={label}>{label}</option>)}</select></label><button className="ld-text-button" onClick={() => { setSearch(""); setProperty(""); setStatus(""); changed(); }}>Clear</button></div>
    <div className="ld-filter-summary"><span><Filter size={17} />{filtered.length} {filtered.length === 1 ? "case" : "cases"} shown</span><button className="ld-text-button" onClick={() => { try { sessionStorage.setItem("landlord-case-view", JSON.stringify({ search, property, status })); setSaved(true); setSaveError(""); } catch { setSaveError("This browser could not save the view."); } }}><Bookmark size={15} />{saved ? "View saved" : "Save view"}</button></div>
    {saveError && <p role="alert" className="ld-muted">{saveError}</p>}
    <section className="ld-panel ld-case-table"><div className="ld-table-scroll"><table className="ld-table"><thead><tr>{["Case", "Property", "Unit", "Tenant", "Issue", "Status", "Last update", "Next action"].map((label) => <th key={label}>{label}</th>)}<th><span className="sr-only">Open</span></th></tr></thead><tbody>{displayed.map((record) => <tr key={record.id}><td><button className="ld-text-button" onClick={() => onOpen(record.id)}>{record.id}</button></td><td>{record.property.address}</td><td className="ld-muted">{record.property.apartment}</td><td>{record.tenant.displayName}</td><td><strong>{record.title}</strong></td><td><CaseStatus record={record} /></td><td className="ld-muted">{shortDate(record.updatedAt)}</td><td><button className="ld-text-button" onClick={() => onOpen(record.id, record.status === "resolved" ? "overview" : "conversation")}>{stateFor(record).action}</button></td><td><button className="ld-icon" aria-label={`Open case ${record.id}`} title="Open case" onClick={() => onOpen(record.id)}><ChevronRight size={18} /></button></td></tr>)}</tbody></table></div>
      {!displayed.length && <p className="ld-table-empty">{cases.length ? "No cases match these filters." : "No repair cases assigned yet."}</p>}
      <footer className="ld-table-footer"><span>{filtered.length ? `${currentPage * 7 + 1}-${Math.min(currentPage * 7 + 7, filtered.length)}` : "0"} of {filtered.length} cases</span><div><button className="ld-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} />Previous</button><button className="ld-button" disabled={(currentPage + 1) * 7 >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next<ChevronRight size={16} /></button></div></footer>
    </section>
    <div className="ld-legend"><strong>OPERATIONAL STATUS</strong><span className="ld-badge amber">Needs landlord</span><span className="ld-badge blue">In progress</span><span className="ld-badge green">Tenant review</span><span className="ld-badge green">Resolved</span></div>
  </>;
}

function CaseEvidence({ record, user, busy, onUpload, onPreview, onAudit }: { record: LandlordCase; user: AuthUser; busy: boolean; onUpload: () => void; onPreview: (item: EvidenceRecord) => void; onAudit: () => void }) {
  const landlordEvidence = record.evidence.filter((item) => item.uploadedByRole === "landlord" || record.repairs.some((repair) => repair.evidenceId === item.id));
  const tenantEvidence = record.evidence.filter((item) => !landlordEvidence.includes(item));
  function tiles(items: EvidenceRecord[]) { return <div className="ld-evidence-grid">{items.map((item) => {
    const source = item.dataUrl || (item.isDemo && item.stage === "before" ? "/evidence-before.png" : item.isDemo && item.stage === "after" ? "/evidence-after.png" : null);
    return <article key={item.id} className="ld-evidence-tile"><button onClick={() => onPreview(item)} aria-label={`Preview ${item.name}`}><div className="ld-evidence-image">{source && item.mimeType.startsWith("image/") ? <img src={source} alt={item.name} /> : <FileText size={29} />}</div><div className="ld-evidence-info"><span>{item.name}<Expand size={15} /></span><small>{time(item.createdAt)} · Submitted by {landlordEvidence.includes(item) ? user.displayName : record.tenant.displayName}</small><small className="ld-evidence-lock"><LockKeyhole size={12} />{item.isDemo ? "Demo evidence" : "Original retained"} · Read only</small></div></button></article>;
  })}</div>; }
  return <div className="ld-evidence-view"><section className="ld-panel"><header className="ld-section-heading"><h2>Tenant-submitted evidence</h2><span>{tenantEvidence.length} items</span></header>{tenantEvidence.length ? tiles(tenantEvidence) : <p className="ld-no-items ld-muted">No tenant evidence has been shared.</p>}<div className="ld-evidence-audit"><Fingerprint size={17} /><p>Original files retained with upload time and submitting account.</p><button className="ld-text-button" onClick={onAudit}>View evidence activity</button></div></section><section className="ld-panel"><header className="ld-section-heading"><div><h2>Landlord after-repair evidence <span className="ld-optional">Optional</span></h2><p className="ld-muted">{landlordEvidence.length ? `${landlordEvidence.length} files uploaded` : "No files uploaded"}</p></div></header>{landlordEvidence.length > 0 && tiles(landlordEvidence)}<div className="ld-upload-zone"><span><CloudUpload size={22} /></span><strong>Upload after-repair photos or documents</strong><p>Optional - skip if no file is needed</p><p>JPG, PNG, WebP, or PDF · up to 5 MiB each</p><button className="ld-button" onClick={onUpload} disabled={busy || record.status === "resolved" || !!record.verification?.verified}><Paperclip size={17} />Choose files</button></div><p className="ld-upload-caption">Add clear photos of the completed work, an invoice or contractor note, and any relevant access record. Files remain attributed to {user.displayName}.</p></section></div>;
}

function Conversation({ record, user, integration, busy, body, onBody, onSend, onAttach, onAccess }: { record: LandlordCase; user: AuthUser; integration?: IntegrationStatus; busy: boolean; body: string; onBody: (body: string) => void; onSend: (body: string) => Promise<boolean>; onAttach: () => void; onAccess: () => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!body.trim() || busy) return; if (await onSend(body.trim())) onBody(""); }
  return <section className="ld-conversation ld-panel"><header className="ld-conversation-heading"><div><span className="ld-avatar">{initials(record.tenant.displayName)}</span><div><small>VIEWING PARTICIPANT</small><strong>{record.tenant.displayName} · Tenant</strong></div><span className="ld-provider" role="status">{photonModeLabel(integration)}</span></div><p><MessageCircle size={14} />{record.title} · {record.id}</p></header><div className="ld-thread">
    {!record.messages.length && <p className="ld-no-items ld-muted">No messages yet. Add a case-related note below.</p>}
    {record.messages.map((message, index) => <div key={message.id}>{(index === 0 || fullDate(message.createdAt) !== fullDate(record.messages[index - 1].createdAt)) && <div className="ld-date-divider"><span>{fullDate(message.createdAt)}</span></div>}<article className={`ld-message ${message.sender === "landlord" || (message.sender === "agent" && message.originatingAgent === "landlord") ? "outgoing" : ""}`}><header><strong>{messageRoleLabel(message, record.tenant.displayName, user.displayName, "landlord")}</strong><time>{time(message.createdAt)}</time></header><p>{message.body}</p>{message.interpretation && <p className="ld-interpretation"><strong>Agent interpretation:</strong> {message.interpretation.summary}</p>}<small><CheckCheck size={14} />{messageDeliveryLabel(message)}</small>{message.failureReason && <p className="ld-message-error">{message.failureReason}</p>}</article></div>)}
    <div className="ld-message-info"><CircleHelp size={15} /><p>Provider acceptance does not confirm delivery or reading. Case notes remain in RentEscrow.</p></div>
    </div><form className="ld-message-compose" onSubmit={submit}><div className="ld-message-address"><small>FROM</small>{user.displayName} · Landlord<ArrowRight size={13} /><small>TO</small>{record.tenant.displayName} · Tenant</div>{record.status === "resolved" && <p className="ld-read-only">This resolved case is read only.</p>}<label htmlFor="landlord-message" className="sr-only">Case message</label><textarea id="landlord-message" value={body} onChange={(event) => onBody(event.target.value)} placeholder="Write a case-related message..." maxLength={2000} rows={3} disabled={busy || record.status === "resolved"} required /><div className="ld-composer-actions"><button type="button" className="ld-button" onClick={onAttach} disabled={busy || record.status === "resolved" || !!record.verification?.verified}><ImagePlus size={16} />Attach photo</button><button type="button" className="ld-button" onClick={onAccess} disabled={busy || record.status === "resolved"}><KeyRound size={16} />Schedule access</button><button type="submit" className="ld-button primary" disabled={busy || record.status === "resolved" || !body.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}Add case message</button></div></form></section>;
}

function EscrowTimeline({ record }: { record: LandlordCase }) {
  return <div className="ld-escrow-view"><section className="ld-panel"><header className="ld-section-heading"><h2>Escrow summary</h2><LockKeyhole size={18} /></header><dl className="ld-financial-summary"><div><dt>Disputed amount</dt><dd>{money(record.financialSummary.disputedAmountCents)}</dd></div><div><dt>Escrow</dt><dd>{record.financialSummary.escrowStatus}</dd></div><div><dt>Settlement</dt><dd>{record.financialSummary.settlementStatus}</dd></div></dl><p className="ld-muted">High-level case status only. Tenant banking details and settlement controls remain private.</p></section><section className="ld-panel"><header className="ld-section-heading"><h2>Case activity</h2></header>{record.timeline.length ? <ol className="ld-timeline">{[...record.timeline].reverse().map((event) => <li key={event.id}><span /><div><strong>{event.title}</strong><p>{event.detail}</p><time>{fullDate(event.createdAt)} · {time(event.createdAt)}</time></div></li>)}</ol> : <p className="ld-muted">No case activity yet.</p>}</section></div>;
}
