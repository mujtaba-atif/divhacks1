"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, Building2, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, CircleUserRound, FileImage, FileText, FlaskConical, LayoutDashboard, LoaderCircle, LockKeyhole, Menu, MessageSquare, Plus, PlugZap, RefreshCw, Search, ShieldCheck, Upload, Wallet, X } from "lucide-react";
import type { BuildingRecord, CaseAction, CaseRecord, DashboardData, EvidenceRecord, EvidenceStage, PolicyResult } from "@/lib/types";
import { ActivityTimeline, canRelease, EscrowPanel, EvidencePanel, evidenceSource, FinancesPanel, MessagesPanel, OverviewPanel, type WorkspaceTab } from "./case-panels";
import { NewCaseDialog, type NewCaseInput } from "./new-case-dialog";
import { Button, EmptyState, fullDate, Modal, money, StatusBadge } from "./workspace-ui";

type ModalName = "new-case" | "upload" | "expense" | "building" | "integrations" | "reset" | "release" | "activity" | null;
type Toast = { message: string; tone: "success" | "info" } | null;
const tabs: { id: WorkspaceTab; label: string; icon: typeof LayoutDashboard }[] = [{ id: "overview", label: "Overview", icon: LayoutDashboard }, { id: "evidence", label: "Evidence", icon: FileImage }, { id: "messages", label: "Messages", icon: MessageSquare }, { id: "finances", label: "Finances", icon: Wallet }, { id: "escrow", label: "Escrow", icon: LockKeyhole }];

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  let result;
  try { result = await response.json(); } catch { throw new Error("The server returned an unexpected response. Please try again."); }
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result as T;
}

function actionMessage(action: CaseAction, record: CaseRecord, policy?: PolicyResult): string {
  switch (action.action) {
    case "add_demo_evidence": return `${action.stage === "before" ? "Before" : "After"}-repair sample added to the case.`;
    case "analyze_evidence": return "Evidence analysis added to the case record.";
    case "send_message": return "Your approved message was recorded.";
    case "simulate_landlord_reply": return action.variant === "completed" ? "Sample repair completion recorded. Add and analyze after-repair evidence next." : "Sample repair appointment recorded.";
    case "create_escrow": return `${money(record.escrow.amountCents)} set aside in simulated escrow.`;
    case "verify_repair": return record.verification?.verified ? "Repair verification passed. Your confirmation is the next step." : "Verification needs further evidence. Review the analysis before continuing.";
    case "confirm_resolution": return "Your repair confirmation has been recorded.";
    case "release_escrow": return "Simulated funds released. Your case is now resolved.";
    case "add_expense": return "Expense added to your financial record.";
    case "sync_finances": return "Sample financial records synced.";
    case "policy_check": return policy?.approved ? "Release policy checks passed." : "The transaction was blocked by the policy checks. No funds moved.";
  }
}

export default function RentWorkspace() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [activeId, setActiveId] = useState("");
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [modal, setModal] = useState<ModalName>(null);
  const [preview, setPreview] = useState<EvidenceRecord | null>(null);
  const [policy, setPolicy] = useState<PolicyResult | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const mutationBusy = useRef(false);
  const record = data?.cases.find((item) => item.id === activeId) || data?.cases[0];

  const loadDashboard = useCallback(async () => {
    try {
      setError(null);
      const result = await request<DashboardData>("/api/dashboard");
      setData(result);
      setActiveId((id) => result.cases.some((item) => item.id === id) ? id : result.cases[0]?.id || "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The workspace could not load."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(null), 6500); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => { if (!mobileNav) return; const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileNav(false); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, [mobileNav]);

  function updateRecord(updated: CaseRecord) {
    setData((current) => current ? { ...current, cases: current.cases.map((item) => item.id === updated.id ? updated : item.status !== "resolved" ? { ...item, accountBalanceCents: updated.accountBalanceCents } : item) } : current);
  }

  async function runAction(action: CaseAction): Promise<CaseRecord | null> {
    if (!record || mutationBusy.current) return null;
    mutationBusy.current = true; setPending(action.action); setError(null); setToast(null);
    try {
      const result = await request<{ case: CaseRecord; policy?: PolicyResult }>(`/api/cases/${encodeURIComponent(record.id)}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
      updateRecord(result.case);
      setPolicy(result.policy ?? null);
      setToast({ message: actionMessage(action, result.case, result.policy), tone: result.policy?.approved === false || (action.action === "verify_repair" && !result.case.verification?.verified) ? "info" : "success" });
      return result.case;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed.");
      try { const latest = await request<DashboardData>("/api/dashboard"); setData(latest); } catch { /* Keep the current case visible if refresh fails. */ }
      return null;
    } finally { mutationBusy.current = false; setPending(null); }
  }

  async function createCase(input: NewCaseInput) {
    if (mutationBusy.current) return false;
    mutationBusy.current = true; setPending("create_case"); setError(null);
    try {
      const result = await request<{ case: CaseRecord }>("/api/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      setData((current) => current ? { ...current, cases: [...current.cases, result.case] } : current);
      setActiveId(result.case.id); setTab("overview"); setPolicy(null); setToast({ message: "Your repair case is open.", tone: "success" });
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The case could not be created."); return false; }
    finally { mutationBusy.current = false; setPending(null); }
  }

  async function uploadEvidence(form: FormData) {
    if (!record || mutationBusy.current) return false;
    mutationBusy.current = true; setPending("upload_evidence"); setError(null);
    try {
      const result = await request<{ case: CaseRecord }>(`/api/cases/${encodeURIComponent(record.id)}/evidence`, { method: "POST", body: form });
      updateRecord(result.case); setPolicy(null); setModal(null); setTab("evidence"); setToast({ message: "Evidence uploaded. Any earlier repair confirmation has been cleared for a fresh review.", tone: "success" }); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The evidence could not be uploaded."); return false; }
    finally { mutationBusy.current = false; setPending(null); }
  }

  async function resetDemo() {
    if (mutationBusy.current) return;
    mutationBusy.current = true; setPending("reset"); setError(null);
    try {
      const result = await request<DashboardData>("/api/demo/reset", { method: "POST" });
      setData(result); setActiveId(result.cases[0]?.id || ""); setTab("overview"); setModal(null); setPolicy(null); setToast({ message: "The demo workspace has been reset to its sample case.", tone: "success" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The demo could not be reset."); }
    finally { mutationBusy.current = false; setPending(null); }
  }

  function navigate(next: WorkspaceTab) { setTab(next); setMobileNav(false); }
  function openModal(next: ModalName) { setError(null); setModal(next); setMobileNav(false); }
  function closeModal() { if (!mutationBusy.current) { setModal(null); setError(null); } }

  return <div className="workspace-shell">
    <a href="#main-content" className="skip-link">Skip to case content</a>
    {mobileNav && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`} aria-label="Workspace navigation">
      <a className="brand" href="/" aria-label="RentEscrow NYC home"><span className="brand-mark"><Building2 size={23} /><span /></span><span>RentEscrow<span className="brand-city">NYC</span></span></a>
      <div className="workspace-switch"><div className="workspace-symbol"><Building2 size={18} /></div><div><strong>My workspace</strong><span>Personal tenant account</span></div><ShieldCheck size={16} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav className="main-nav"><button className={tab === "overview" ? "active" : ""} onClick={() => navigate("overview")}><LayoutDashboard size={18} /><span>My cases</span><span className="nav-count">{data?.cases.length || 1}</span></button><button className={tab === "evidence" ? "active" : ""} onClick={() => navigate("evidence")}><FileImage size={18} /><span>Evidence</span></button><button className={tab === "messages" ? "active" : ""} onClick={() => navigate("messages")}><MessageSquare size={18} /><span>Messages</span></button><button className={tab === "finances" ? "active" : ""} onClick={() => navigate("finances")}><Wallet size={18} /><span>Finances</span></button><button className={tab === "escrow" ? "active" : ""} onClick={() => navigate("escrow")}><LockKeyhole size={18} /><span>Rent escrow</span></button></nav>
      <div className="sidebar-divider" />
      <div className="nav-label">YOUR HOME</div>
      <button className="home-context" onClick={() => openModal("building")} disabled={!record}><Building2 size={18} /><div><strong>{record?.building.address || "Your building"}</strong><span>{record ? `${record.building.borough} · Apt ${record.apartment}` : "NYC housing records"}</span></div><ChevronRight size={15} /></button>
      <Button className="new-case-button" icon={Plus} onClick={() => openModal("new-case")} disabled={!data}>New case</Button>
      <div className="sidebar-bottom"><button className="sidebar-utility" onClick={() => openModal("integrations")} disabled={!data}><PlugZap size={17} /><span>Connections</span><span className="green-dot" /></button><button className="sidebar-utility" onClick={() => openModal("reset")} disabled={!data || !!pending}><RefreshCw size={16} /><span>Reset demo</span></button><div className="demo-mode-note"><FlaskConical size={16} /><div><strong>Demo workspace</strong><p>Sample data. No real funds moved.</p></div></div><div className="tenant-profile"><span className="tenant-avatar">T</span><div><strong>Tenant account</strong><span>New York City</span></div><CircleUserRound size={18} /></div></div>
    </aside>

    <div className="workspace-body"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open workspace navigation" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}><Menu size={21} /></button><a className="mobile-brand" href="/">RentEscrow <span>NYC</span></a><span>Workspace</span><ChevronRight size={14} /><span>My cases</span>{record && <><ChevronRight size={14} /><strong>{record.id}</strong></>}</div><div className="topbar-right"><span className="demo-pill"><span />Demo mode</span><button className="icon-button" title="View connections" aria-label="View integration connections" onClick={() => openModal("integrations")} disabled={!data}><PlugZap size={18} /></button><span className="topbar-avatar">T</span></div></header>
      <main id="main-content" className="main-content">
        {loading ? <div className="workspace-loading" role="status"><LoaderCircle className="spin" size={27} /><h1>Opening your workspace</h1><p>Loading your repair cases and records.</p></div> : !data ? <div className="workspace-loading"><EmptyState icon={CircleHelp} title="Your workspace could not load" action={<Button icon={RefreshCw} onClick={() => { setLoading(true); void loadDashboard(); }}>Try again</Button>}>{error || "Please try again in a moment."}</EmptyState></div> : !record ? <EmptyState icon={FileText} title="No repair cases yet" action={<Button variant="primary" icon={Plus} onClick={() => openModal("new-case")}>Open a case</Button>}>Your cases will appear here.</EmptyState> : <>
          <div className="case-meta-line"><div><span className="eyebrow">REPAIR CASE</span><span className="case-id">{record.id}</span><StatusBadge status={record.status} /></div><label className="case-switcher"><span className="sr-only">Select case</span><select aria-label="Select case" value={record.id} onChange={(event) => { setActiveId(event.target.value); setPolicy(null); setTab("overview"); setError(null); }} disabled={!!pending}>{data.cases.map((item) => <option value={item.id} key={item.id}>{item.id} · {item.title}</option>)}</select><ChevronDown size={14} /></label></div>
          <div className="case-header"><div><h1>{record.title}</h1><div className="case-location"><span><Building2 size={15} />{record.building.address}, Apt {record.apartment}</span><span className="location-divider" /><span>Opened {fullDate(record.createdAt)}</span></div></div><div className="case-header-actions"><a className="button button-secondary icon-only-mobile" href={`/api/cases/${encodeURIComponent(record.id)}/export`} download aria-label="Export case dossier" title="Export case dossier"><ArrowDownToLine size={16} /><span>Export case</span></a><Button variant="primary" icon={Plus} onClick={() => openModal("upload")} disabled={!!pending || record.status === "resolved"}>Add evidence</Button></div></div>
          <div className="case-tabs" role="tablist" aria-label="Case sections">{tabs.map(({ id, label, icon: Icon }) => <button role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)} onKeyDown={(event) => { const index = tabs.findIndex((item) => item.id === id); let next: number | null = null; if (event.key === "ArrowRight") next = (index + 1) % tabs.length; if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length; if (event.key === "Home") next = 0; if (event.key === "End") next = tabs.length - 1; if (next !== null) { event.preventDefault(); setTab(tabs[next].id); document.getElementById(`tab-${tabs[next].id}`)?.focus(); } }}><Icon size={16} />{label}{id === "evidence" && <span>{record.evidence.length}</span>}</button>)}</div>
          {error && !modal && <div className="error-banner" role="alert"><CircleHelp size={18} /><span>{error}</span><button className="icon-button" onClick={() => setError(null)} title="Dismiss error" aria-label="Dismiss error"><X size={16} /></button></div>}
          {record.status === "resolved" && <div className="resolved-banner"><CheckCircle2 size={19} /><div><strong>Repair resolved. Case complete.</strong><span>Your evidence, messages, and simulated transaction receipts remain available for export.</span></div></div>}
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="tab-panel">
            {tab === "overview" && <OverviewPanel record={record} pending={pending} onAction={runAction} onTab={setTab} onUpload={() => openModal("upload")} onPreview={setPreview} onActivity={() => openModal("activity")} onBuilding={() => openModal("building")} />}
            {tab === "evidence" && <EvidencePanel record={record} pending={pending} onAction={runAction} onUpload={() => openModal("upload")} onPreview={setPreview} />}
            {tab === "messages" && <MessagesPanel record={record} pending={pending} onAction={runAction} liveDelivery={data.integrations.some((item) => item.id === "photon" && item.status === "configured")} />}
            {tab === "finances" && <FinancesPanel record={record} pending={pending} onAction={runAction} onExpense={() => openModal("expense")} />}
            {tab === "escrow" && <EscrowPanel record={record} pending={pending} onAction={runAction} onRelease={() => openModal("release")} policy={policy} />}
          </div>
          <footer className="workspace-footer"><span><ShieldCheck size={13} />Your case. Your evidence. Your approval.</span><span>{record.building.source === "demo" ? "Sample NYC case" : "NYC repair case"} · Simulated funds</span></footer>
        </>}
      </main>
    </div>

    {toast && <div className={`toast toast-${toast.tone}`} role="status"><span>{toast.tone === "success" ? <CheckCircle2 size={19} /> : <ShieldCheck size={19} />}</span><p>{toast.message}</p><button className="icon-button" title="Dismiss notification" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16} /></button></div>}
    {modal === "new-case" && <NewCaseDialog onClose={closeModal} onCreate={createCase} busy={pending === "create_case"} />}
    {modal === "upload" && record && <UploadDialog record={record} onClose={closeModal} onUpload={uploadEvidence} pending={pending === "upload_evidence"} error={error} />}
    {modal === "expense" && record && <ExpenseDialog onClose={closeModal} onAction={runAction} pending={pending === "add_expense"} error={error} />}
    {modal === "building" && record && <BuildingDialog building={record.building} onClose={closeModal} />}
    {modal === "activity" && record && <Modal title="Case activity" subtitle={`Complete history for ${record.id}`} onClose={closeModal}><ActivityTimeline record={record} /></Modal>}
    {modal === "integrations" && data && <Modal title="Workspace connections" subtitle="Integration status for this environment." onClose={closeModal}><div className="integration-list">{data.integrations.map((integration) => <div className="integration-row" key={integration.id}><span className="integration-icon"><PlugZap size={19} /></span><div><strong>{integration.name}</strong><p>{integration.detail}</p></div><span className={`subtle-badge ${integration.status === "configured" || integration.status === "public" ? "badge-green" : ""}`}>{integration.status === "demo" ? "Demo" : integration.status === "configured" ? "Configured" : integration.status === "public" ? "Public data" : "Unavailable"}</span></div>)}</div><div className="inline-note note-amber"><FlaskConical size={18} /><p>Escrow remains a local simulation. No bank transfers or real ledger transactions are submitted.</p></div></Modal>}
    {modal === "reset" && <Modal title="Reset the demo workspace?" subtitle="This removes cases, uploads, messages, and expense records in this browser session and restores the sample case." onClose={closeModal}><div className="inline-note note-amber"><FileText size={19} /><p>Export any case records you want to keep before resetting.</p></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><Button onClick={closeModal} disabled={!!pending}>Keep workspace</Button><Button variant="danger" icon={RefreshCw} busy={pending === "reset"} onClick={() => { void resetDemo(); }}>Reset demo</Button></div></Modal>}
    {modal === "release" && record && <Modal title="Approve simulated rent release" subtitle="The repair review passed and your confirmation is recorded." onClose={closeModal}><div className="release-confirm-amount"><LockKeyhole size={24} /><strong>{money(record.escrow.amountCents)}</strong><span>SIMULATED USD</span></div><dl className="escrow-details"><div><dt>To</dt><dd>{record.landlordName}</dd></div><div><dt>Destination</dt><dd className="mono break-word">{record.escrow.destination}</dd></div><div><dt>Case</dt><dd>{record.id}</dd></div></dl><p className="muted">Approving releases the simulated escrow balance and closes this repair case.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><Button onClick={closeModal} disabled={!!pending}>Cancel</Button><Button variant="primary" icon={ShieldCheck} busy={pending === "release_escrow"} disabled={!canRelease(record)} onClick={async () => { const updated = await runAction({ action: "release_escrow" }); if (updated) setModal(null); }}>Approve release</Button></div></Modal>}
    {preview && <Modal title={preview.name} subtitle={`${preview.isDemo ? "Sample evidence" : "Uploaded evidence"} · ${fullDate(preview.createdAt)}`} onClose={() => setPreview(null)} wide>{preview.mimeType.startsWith("image/") && evidenceSource(preview) ? <img className="evidence-full-preview" src={evidenceSource(preview)} alt={preview.name} /> : preview.dataUrl ? <a href={preview.dataUrl} download={preview.name} className="button button-secondary"><ArrowDownToLine size={17} />Download document</a> : <p className="muted">A preview is not available for this document.</p>}{preview.note && <p className="preview-note">{preview.note}</p>}{preview.analysis && <div className="inline-note note-green"><ScanResult /><div><strong>{preview.analysis.source === "demo" ? "Sample analysis" : "Evidence analysis"}</strong><p>{preview.analysis.summary}</p></div></div>}</Modal>}
  </div>;
}

function ScanResult() { return <ShieldCheck size={20} />; }

function UploadDialog({ record, onClose, onUpload, pending, error }: { record: CaseRecord; onClose: () => void; onUpload: (data: FormData) => Promise<boolean>; pending: boolean; error: string | null }) {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<EvidenceStage>(record.repairReported ? "after" : "before");
  const [fileError, setFileError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  function chooseFile(next?: File) {
    setFileError("");
    if (!next) return;
    if (next.size > 5 * 1024 * 1024) { setFileError("Choose a file smaller than 5 MiB."); return; }
    if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(next.type)) { setFileError("Choose a JPG, PNG, WebP, or PDF file."); return; }
    setFile(next);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) { setFileError("Choose a file to upload."); return; }
    const form = new FormData(event.currentTarget); form.set("file", file); form.set("stage", stage);
    if (!String(form.get("temperatureF")).trim()) form.delete("temperatureF");
    await onUpload(form);
  }
  return <Modal title="Add case evidence" subtitle="Photos, documents, and receipts for your repair record." onClose={onClose}><form onSubmit={submit}><div className={`upload-zone ${file ? "upload-selected" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files[0]); }}><span><Upload size={26} /></span><strong>{file ? file.name : "Choose a file or drop it here"}</strong><p>{file ? `${(file.size / 1024).toFixed(0)} KB · Ready to upload` : "JPG, PNG, WebP, or PDF · Up to 5 MiB"}</p><Button onClick={() => inputRef.current?.click()} disabled={pending}>{file ? "Choose another file" : "Browse files"}</Button><input ref={inputRef} type="file" aria-label="Evidence file" className="sr-only" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(event) => chooseFile(event.target.files?.[0])} /></div><div className="form-grid"><label className="field">Evidence stage<select name="stage" value={stage} onChange={(event) => setStage(event.target.value as EvidenceStage)}><option value="before">Before repair</option><option value="after">After repair</option><option value="receipt">Expense receipt</option><option value="other">Other document</option></select></label><label className="field">Temperature (°F, optional)<input name="temperatureF" type="number" min="-50" max="150" step="0.1" placeholder="e.g. 54" /></label><label className="field field-wide">Notes<textarea name="note" rows={3} maxLength={2000} placeholder="Where and when was this captured? What does it show?" /></label></div>{(fileError || error) && <p className="form-error" role="alert">{fileError || error}</p>}<div className="inline-note note-neutral"><CircleHelp size={17} /><p>Uploaded evidence requires a configured analyzer for automated verification. Sample evidence is available in the Evidence tab.</p></div><div className="modal-footer"><Button onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" icon={Upload} variant="primary" disabled={!file} busy={pending}>Add to case</Button></div></form></Modal>;
}

function ExpenseDialog({ onClose, onAction, pending, error }: { onClose: () => void; onAction: (action: CaseAction) => Promise<CaseRecord | null>; pending: boolean; error: string | null }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    const result = await onAction({ action: "add_expense", label: String(values.get("label")).trim(), amountCents: Math.round(Number(values.get("amount")) * 100), category: String(values.get("category")) });
    if (result) onClose();
  }
  return <Modal title="Record an expense" subtitle="Add a cost associated with this repair issue." onClose={onClose}><form onSubmit={submit}><div className="form-grid"><label className="field field-wide">Description<input name="label" placeholder="e.g. Portable space heater" required maxLength={200} /></label><label className="field">Amount (USD)<input name="amount" type="number" min="0.01" max="100000" step="0.01" required placeholder="0.00" /></label><label className="field">Category<select name="category"><option value="supplies">Supplies</option><option value="utilities">Utilities</option><option value="accommodation">Accommodation</option><option value="transportation">Transportation</option><option value="other">Other</option></select></label></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><Button onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" icon={Plus} variant="primary" busy={pending}>Add expense</Button></div></form></Modal>;
}

function BuildingDialog({ building, onClose }: { building: BuildingRecord; onClose: () => void }) {
  const [result, setResult] = useState(building);
  const [address, setAddress] = useState(building.address);
  const [borough, setBorough] = useState(building.borough);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { setResult(await request<BuildingRecord>(`/api/buildings?${new URLSearchParams({ address: address.trim(), borough })}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The building lookup failed."); }
    finally { setBusy(false); }
  }
  return <Modal title="Building records" subtitle="Public housing complaint and violation records." onClose={onClose} wide><form onSubmit={search} className="building-search"><label className="field">Street address<input value={address} onChange={(event) => setAddress(event.target.value)} required maxLength={200} /></label><label className="field">Borough<select value={borough} onChange={(event) => setBorough(event.target.value)}>{["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"].map((name) => <option key={name}>{name}</option>)}</select></label><Button icon={Search} type="submit" busy={busy}>Search</Button></form>{error && <p className="form-error" role="alert">{error}</p>}<div className="records-heading"><div><h3>{result.address}</h3><p>{result.borough}, NY {result.zip}</p></div><span className="subtle-badge">{result.source === "demo" ? "Sample records" : "NYC Open Data"}</span></div>{result.warning && <div className="inline-note note-amber"><CircleHelp size={17} /><p>{result.warning}</p></div>}{[{ name: "Complaints", items: result.complaints }, { name: "Violations", items: result.violations }].map(({ name, items }) => <section className="records-section" key={name}><h3>{name}<span className="count">{items.length}</span></h3>{items.length ? <div className="housing-records">{items.map((item) => <article key={item.id}><span className="record-icon"><Building2 size={16} /></span><div><strong>{item.category}</strong><p>{item.description}</p><span>{fullDate(item.date)} · {item.id}</span></div><span className="subtle-badge">{item.status}</span></article>)}</div> : <p className="muted">No {name.toLowerCase()} returned for this address.</p>}</section>)}<p className="panel-footnote">Retrieved {fullDate(result.fetchedAt)}. Returned records are not a complete building inspection.</p></Modal>;
}
