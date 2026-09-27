"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Building2, CalendarClock, CheckCircle2, FileImage, FileText, MessageSquare, ShieldCheck, Upload, Wrench } from "lucide-react";
import type { AuthUser, EvidenceRecord, IntegrationStatus, LandlordCase } from "@/lib/types";
import { BuildingHistoryDialog, BuildingHistorySummary, type BuildingContextState, useCaseBuildingContext } from "./building-history";
import { Button, fullDate, Modal, money, StatusBadge, time } from "./workspace-ui";
import { announceSessionChange, redirectIfSignedOut, useSessionGuard } from "./use-session-guard";
import { LandlordDesign, type LandlordView } from "./landlord-design";

type LandlordTab = LandlordView;
type PendingAction = "load" | "logout" | "message" | "schedule" | "report_complete" | "evidence" | null;


async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  redirectIfSignedOut(response);
  const result = await response.json().catch(() => null) as ({ error?: unknown } & T) | null;
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "The request could not be completed.");
  if (!result) throw new Error("The server returned an unexpected response.");
  return result;
}

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
  const [preview, setPreview] = useState<EvidenceRecord | null>(null);
  const [buildingOpen, setBuildingOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [messagingIntegration, setMessagingIntegration] = useState<IntegrationStatus>();
  const mutationBusy = useRef(false);
  const mutationVersion = useRef(0);
  const activeCase = cases.find((record) => record.id === activeId) ?? cases[0];
  const buildingContext = useCaseBuildingContext(activeCase?.id, "landlord");

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

  function navigate(next: LandlordTab) {
    setTab(next);
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

  return <>
    <LandlordDesign
      user={user} cases={cases} activeCase={activeCase} tab={tab} pending={pending}
      error={error} notice={notice} integration={messagingIntegration}
      onNavigate={navigate} onSelect={(id) => { setActiveId(id); setError(""); setNotice(""); }}
      onLogout={() => void logout()} onRetry={() => void loadCases()}
      onDismissError={() => setError("")} onDismissNotice={() => setNotice("")}
      onSend={(body) => runAction({ action: "message", body }, "message")}
      onUpload={() => setUploadOpen(true)} onPreview={setPreview}
      reviewPanel={activeCase ? <CaseReview record={activeCase} onNavigate={navigate} onPreview={setPreview} buildingContext={buildingContext} onBuilding={() => setBuildingOpen(true)} /> : null}
      repairsPanel={activeCase ? <RepairsView key={activeCase.id} record={activeCase} pending={pending} error={error} onSchedule={(scheduledFor, notes) => runAction({ action: "schedule", scheduledFor, notes }, "schedule")} onComplete={(notes) => runAction({ action: "report_complete", notes }, "report_complete")} onUpload={uploadEvidence} onPreview={setPreview} /> : null}
    />
    {uploadOpen && <RepairUploadDialog pending={pending === "evidence"} error={error} onClose={() => { if (pending !== "evidence") setUploadOpen(false); }} onUpload={async (form) => { const ok = await uploadEvidence(form); if (ok) setUploadOpen(false); return ok; }} />}
    {preview && <EvidencePreview evidence={preview} onClose={() => setPreview(null)} />}
    {buildingOpen && activeCase && <BuildingHistoryDialog context={buildingContext} issue={activeCase.issue} address={activeCase.property.address} borough={activeCase.property.borough} onClose={() => setBuildingOpen(false)} />}
  </>;
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
