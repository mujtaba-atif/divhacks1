"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, BadgeCheck, Building2, CalendarDays, Check, CheckCheck, CheckCircle2, ChevronRight, CircleDollarSign, ExternalLink, FileImage, FileText, FlaskConical, ImagePlus, LockKeyhole, Mail, MessageSquare, Paperclip, Plus, RefreshCw, ScanLine, Send, ShieldCheck, ShieldX, Sparkles, Thermometer, Upload, Wallet, Wrench } from "lucide-react";
import type { CaseAction, CaseMessage, CaseRecord, EvidenceRecord, EvidenceStage, IntegrationStatus, PolicyResult } from "@/lib/types";
import { normalizeMessagingContact } from "@/lib/messaging-contact";
import { Button, CheckRow, EmptyState, fullDate, money, SectionHeading, shortDate, time } from "./workspace-ui";

export type WorkspaceTab = "overview" | "evidence" | "messages" | "finances" | "escrow";
export type RunAction = (action: CaseAction) => Promise<CaseRecord | null>;

interface CommonProps {
  record: CaseRecord;
  pending: string | null;
  onAction: RunAction;
}

function latestAfterEvidence(record: CaseRecord) {
  return record.evidence.filter((item) => item.stage === "after").at(-1);
}

export function canRelease(record: CaseRecord) {
  return record.escrow.status === "locked" && record.repairReported && record.verification?.verified === true && record.tenantConfirmed && latestAfterEvidence(record)?.analysis?.verified === true;
}

export function canReviewXrplSettlement(record: CaseRecord) {
  const settlement = record.xrplSettlement;
  return canRelease(record) && !!settlement && !settlement.hash && (settlement.status === "ready" || settlement.status === "failed");
}

export function formatTestXrp(drops: string) {
  const normalized = /^\d+$/.test(drops) ? drops.replace(/^0+(?=\d)/, "") : "0";
  const padded = normalized.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} Test XRP`;
}

export function evidenceSource(item: EvidenceRecord) {
  return item.isDemo && item.mimeType.startsWith("image/") ? (item.stage === "after" ? "/evidence-after.png" : "/evidence-before.png") : item.dataUrl;
}

function EvidenceImage({ item, className = "" }: { item: EvidenceRecord; className?: string }) {
  const source = evidenceSource(item);
  return source && item.mimeType.startsWith("image/") ? <img className={className} src={source} alt={item.name} /> : <div className={`document-preview ${className}`}><FileText size={35} /><span>PDF document</span></div>;
}

function analysisSourceLabel(item: EvidenceRecord) {
  return item.analysis?.source === "demo" ? "Sample analysis" : "Gemini AI analysis";
}

function AnalysisResult({ item }: { item: EvidenceRecord }) {
  const analysis = item.analysis;
  if (!analysis) return null;
  const confidence = analysis.confidence === undefined ? null : `${Math.round(analysis.confidence * 100)}% confidence`;
  const detectedTemperature = analysis.temperatureF === undefined ? null : `${analysis.temperatureF}°F detected`;
  const evidenceType = analysis.evidenceType?.replaceAll("_", " ");
  return <div className="analysis-result">
    <span className="eyebrow"><Sparkles size={13} />{analysisSourceLabel(item).toUpperCase()}</span>
    <p>{analysis.source === "gemini" ? `AI summary: ${analysis.summary}` : analysis.summary}</p>
    {analysis.observations?.length ? <p><strong>Detected observations:</strong> {analysis.observations.join("; ")}</p> : null}
    {(detectedTemperature || evidenceType || confidence) && <p className="muted small">{[detectedTemperature, evidenceType, confidence].filter(Boolean).join(" · ")}</p>}
    {analysis.source === "gemini" && <p className="muted small">AI analysis{analysis.model ? ` by ${analysis.model}` : ""}. Appears to show the observations above; requires tenant confirmation and is not a legal finding.</p>}
    {item.stage === "after" && <span className={`text-status ${analysis.verified ? "green" : "amber"}`}><span />{analysis.verified ? "Reading available for application comparison" : "Needs further review"}</span>}
  </div>;
}

function AnalysisError({ item }: { item: EvidenceRecord }) {
  if (!item.analysisError) return null;
  return <div className="inline-note note-amber" role="alert">
    <ShieldX size={18} />
    <div>
      <strong>AI analysis needs attention</strong>
      <p>{item.analysisError.message} {item.analysisError.retryable ? "You can retry the analysis." : "Check the Gemini connection, then retry."}</p>
    </div>
  </div>;
}

function timelineIcon(kind: string) {
  switch (kind) {
    case "evidence": return FileImage;
    case "message": return MessageSquare;
    case "escrow": return LockKeyhole;
    case "verification": return ShieldCheck;
    default: return Plus;
  }
}

export function ActivityTimeline({ record, limit }: { record: CaseRecord; limit?: number }) {
  const events = [...record.timeline].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  return <ol className="activity-timeline">{events.map((event) => { const Icon = timelineIcon(event.kind); return <li key={event.id}><span className={`timeline-icon timeline-${event.kind}`}><Icon size={15} /></span><div className="timeline-copy"><div><strong>{event.title}</strong><time dateTime={event.createdAt}>{shortDate(event.createdAt)}</time></div><p>{event.detail}</p><span className="timeline-time">{time(event.createdAt)}</span></div></li>; })}</ol>;
}

export function OverviewPanel({ record, pending, onAction, onTab, onUpload, onPreview, onActivity, onBuilding }: CommonProps & { onTab: (tab: WorkspaceTab) => void; onUpload: () => void; onPreview: (item: EvidenceRecord) => void; onActivity: () => void; onBuilding: () => void }) {
  const before = record.evidence.find((item) => item.stage === "before");
  const analyzedEvidence = [...record.evidence].reverse().find((item) => item.analysis && (!record.verification || item.stage === "after"));
  const featuredEvidence = analyzedEvidence || before || record.evidence[0];
  const latestAnalysis = analyzedEvidence?.analysis;
  const notified = record.messages.some((message) => message.sender === "tenant" && (message.delivery === "demo" || message.delivery === "sent"));
  const isResolved = record.status === "resolved";
  const funded = record.escrow.status !== "unfunded";
  const phase = isResolved ? 4 : record.verification?.verified ? 3 : record.repairReported ? 2 : notified ? 1 : 0;
  const totalExpenses = record.expenses.reduce((sum, expense) => sum + expense.amountCents, 0);
  let nextTitle = "Document the issue";
  let nextDetail = "Add a photo or document to your case.";
  let nextAction = "Add evidence";
  let runNext = onUpload;
  if (before && !before.analysis) { nextTitle = "Review your evidence"; nextDetail = "Your first evidence is ready for analysis."; nextAction = "Analyze evidence"; runNext = () => { void onAction({ action: "analyze_evidence", evidenceId: before.id }); }; }
  else if (before?.analysis && !notified) { nextTitle = "Send your repair request"; nextDetail = "Review and approve a message to your property manager."; nextAction = "Review message"; runNext = () => onTab("messages"); }
  else if (before?.analysis && !funded) { nextTitle = "Set aside the disputed rent"; nextDetail = `${money(record.disputedAmountCents)} is ready to place in simulated escrow.`; nextAction = "Review escrow"; runNext = () => onTab("escrow"); }
  else if (funded && !record.repairReported) { nextTitle = "Waiting on the repair"; nextDetail = "Your case stays open while the property manager arranges a repair."; nextAction = "View messages"; runNext = () => onTab("messages"); }
  else if (record.repairReported && !record.verification?.verified) { nextTitle = "Check the completed repair"; nextDetail = "Add after-repair evidence, then verify the result."; nextAction = "Review evidence"; runNext = () => onTab("evidence"); }
  else if (record.verification?.verified && !record.tenantConfirmed) { nextTitle = "Your confirmation is needed"; nextDetail = "The evidence review passed. Confirm that the repair is complete."; nextAction = "Review resolution"; runNext = () => onTab("escrow"); }
  else if (record.tenantConfirmed && !isResolved) { nextTitle = "Ready for your final approval"; nextDetail = "Every repair check is complete. Review the simulated rent release."; nextAction = "Review release"; runNext = () => onTab("escrow"); }
  else if (isResolved) { nextTitle = "A documented resolution"; nextDetail = "The repair is confirmed and the simulated rent has been released."; nextAction = "View receipt"; runNext = () => onTab("escrow"); }

  return <div className="overview-layout">
    <div className="overview-main">
      <section className="progress-section">
        <SectionHeading title="Case progress"><span className="muted small">{phase + (phase < 4 ? 1 : 0)} of 4 stages</span></SectionHeading>
        <ol className="progress-track">{[{ name: "Documented", icon: FileText }, { name: "Landlord notified", icon: MessageSquare }, { name: "Repair reviewed", icon: Wrench }, { name: "Resolved", icon: ShieldCheck }].map(({ name, icon: Icon }, index) => <li key={name} className={index < phase ? "complete" : index === phase ? "active" : ""}><span className="progress-step">{index < phase ? <Check size={17} /> : <Icon size={17} />}</span><span>{name}</span></li>)}</ol>
        <div className={`next-step ${isResolved ? "next-step-complete" : ""}`}><span className="next-step-icon">{isResolved ? <BadgeCheck size={22} /> : <ArrowRight size={22} />}</span><div><span className="eyebrow">{isResolved ? "CASE COMPLETE" : "UP NEXT"}</span><h3>{nextTitle}</h3><p>{nextDetail}</p></div><Button variant="secondary" icon={ArrowRight} onClick={runNext} disabled={!!pending}>{nextAction}</Button></div>
      </section>

      <section className="evidence-overview section-separated">
        <SectionHeading title="The issue, on record"><Button variant="ghost" icon={ArrowUpRight} onClick={() => onTab("evidence")}>All evidence <span className="count">{record.evidence.length}</span></Button></SectionHeading>
        <p className="section-description">{record.description}</p>
        {record.evidence.length > 0 ? <div className="evidence-summary-grid"><div className="featured-evidence"><button className="image-preview-button" onClick={() => onPreview(featuredEvidence)} aria-label="Open evidence image"><EvidenceImage item={featuredEvidence} /><span className="image-label"><FileImage size={12} />{featuredEvidence.isDemo ? "Sample evidence" : "Case evidence"}</span></button><div className="evidence-caption"><span>{featuredEvidence.name}</span><span>{shortDate(featuredEvidence.createdAt)}</span></div></div><div className="evidence-reading"><span className="eyebrow"><ScanLine size={13} /> EVIDENCE REVIEW</span>{latestAnalysis ? <><div className="temperature-reading">{latestAnalysis.temperatureF !== undefined ? <><span>{latestAnalysis.temperatureF}<span className="degree">°F</span></span><span className="reading-label">{latestAnalysis.source === "gemini" ? "AI-detected temperature" : "Sample temperature"}</span></> : <><span className="severity-label">{latestAnalysis.severity}</span><span className="reading-label">{latestAnalysis.source === "gemini" ? "AI-detected severity" : "Sample severity"}</span></>}</div><p>{latestAnalysis.source === "gemini" ? `AI summary: ${latestAnalysis.summary}` : latestAnalysis.summary}</p><span className={`text-status ${record.verification?.verified ? "green" : "amber"}`}><span />{record.verification?.verified ? "Application comparison passed" : "Requires review"}</span><span className="source-label">{latestAnalysis.source === "demo" ? "Sample analysis" : "Gemini AI analysis · requires confirmation"}</span></> : featuredEvidence.analysisError ? <><h3>AI analysis needs attention</h3><p>{featuredEvidence.analysisError.message}</p><Button icon={RefreshCw} busy={pending === "analyze_evidence"} onClick={() => { void onAction({ action: "analyze_evidence", evidenceId: featuredEvidence.id }); }} disabled={!!pending || isResolved}>Retry AI analysis</Button></> : <><h3>Evidence added</h3><p>Your evidence is part of the case record. AI analysis is still pending.</p><Button icon={Sparkles} busy={pending === "analyze_evidence"} onClick={() => { void onAction({ action: "analyze_evidence", evidenceId: (before || record.evidence[0]).id }); }} disabled={!!pending || isResolved}>Analyze evidence</Button></>}</div></div> : <EmptyState icon={FileImage} title="A clear record starts here" action={<Button icon={Upload} onClick={onUpload}>Add evidence</Button>}>No evidence has been added to this case.</EmptyState>}
      </section>

      <section className="section-separated activity-section"><SectionHeading title="Recent activity"><Button variant="ghost" icon={ArrowUpRight} onClick={onActivity}>View all</Button></SectionHeading><ActivityTimeline record={record} limit={4} /></section>
    </div>

    <aside className="overview-aside">
      <section className="rent-panel"><div className="panel-heading"><span className="small-heading"><LockKeyhole size={17} />Rent escrow</span><span className="tiny-label">SIMULATED USD</span></div><div className="rent-amount">{money(record.escrow.amountCents)}</div><div className="escrow-state"><span className={record.escrow.status === "unfunded" ? "amber-dot" : "green-dot"} />{record.escrow.status === "locked" ? "Held pending verified repair" : record.escrow.status === "released" ? "Released after your approval" : "Ready to set aside"}</div><div className="rent-detail-row"><span>Monthly rent</span><strong>{money(record.monthlyRentCents)}</strong></div><div className="rent-detail-row"><span>Disputed portion</span><strong>{Math.round(record.disputedAmountCents / record.monthlyRentCents * 100)}%</strong></div><Button className="full-width" variant="secondary" icon={ArrowRight} onClick={() => onTab("escrow")}>{record.escrow.status === "released" ? "View escrow receipt" : "Manage escrow"}</Button><p className="panel-footnote"><ShieldCheck size={13} />Tenant approval required for release</p></section>

      <section className="checklist-section"><SectionHeading title="Before funds are released"><ShieldCheck size={18} className="green" /></SectionHeading><ul className="checklist"><CheckRow done={funded} title="Rent placed in escrow" detail={funded ? `${money(record.escrow.amountCents)} in simulated escrow` : "Disputed rent only"} current={!funded} /><CheckRow done={record.repairReported} title="Repair reported complete" detail="By the property manager" current={funded && !record.repairReported} /><CheckRow done={!!record.verification?.verified} title="After-repair evidence verified" detail="Compared with the original record" current={record.repairReported && !record.verification?.verified} /><CheckRow done={record.tenantConfirmed} title="You confirm the resolution" detail="You always have the final say" current={!!record.verification?.verified && !record.tenantConfirmed} /></ul></section>

      <section className="building-summary"><div className="building-summary-icon"><Building2 size={20} /></div><div><h3>Your building</h3><p>{record.building.address}</p><span>{record.building.borough}, NY {record.building.zip}</span></div><button className="icon-button" onClick={onBuilding} aria-label="View building records" title="View building records"><ArrowUpRight size={18} /></button><div className="building-summary-bottom">{record.building.warning ? <span className="building-warning">{record.building.warning}</span> : <><span><strong>{record.building.complaints.length}</strong> complaints</span><span><strong>{record.building.violations.length}</strong> violations</span></>}<span className="source-label">{record.building.source === "demo" ? "Sample records" : "NYC Open Data"}</span></div></section>
      {totalExpenses > 0 && <button className="expense-note" onClick={() => onTab("finances")}><CircleDollarSign size={18} /><span><strong>{money(totalExpenses)}</strong> in recorded expenses</span><ChevronRight size={16} /></button>}
    </aside>
  </div>;
}

export function EvidencePanel({ record, pending, onAction, onUpload, onPreview, geminiIntegration }: CommonProps & { onUpload: () => void; onPreview: (item: EvidenceRecord) => void; geminiIntegration?: IntegrationStatus }) {
  const [filter, setFilter] = useState<"all" | EvidenceStage>("all");
  const items = record.evidence.filter((item) => filter === "all" || item.stage === filter);
  const resolved = record.status === "resolved";
  const geminiConfigured = geminiIntegration?.status === "configured";
  const comparison = record.verification?.comparison;
  const beforeTemperature = comparison?.beforeTemperatureF ?? record.evidence.filter((item) => item.stage === "before").at(-1)?.analysis?.temperatureF;
  const afterTemperature = comparison?.afterTemperatureF ?? latestAfterEvidence(record)?.analysis?.temperatureF;
  const hasTemperatureComparison = beforeTemperature !== undefined && afterTemperature !== undefined;
  return <section className="tab-content"><SectionHeading eyebrow="CASE DOCUMENTS" title="Evidence library"><Button variant="primary" icon={Upload} onClick={onUpload} disabled={resolved || !!pending}>Upload evidence</Button></SectionHeading>
    <div className={`inline-note ${geminiConfigured ? "note-green" : "note-neutral"}`} role="status"><Sparkles size={18} /><div><strong>{geminiConfigured ? "Gemini credentials configured" : "Gemini demo fallback"}</strong><p>{geminiConfigured ? "New uploads request Gemini analysis server-side; results or availability errors appear on each file. Detected observations require tenant confirmation and are not legal findings." : "Gemini credentials are not configured. Uploads remain saved as case evidence, and the labeled sample analysis below remains available."}</p></div></div>
    <div className="evidence-toolbar"><div className="segmented-control" aria-label="Filter evidence">{["all", "before", "after", "receipt"].map((value) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value as typeof filter)} className={filter === value ? "selected" : ""}>{value === "all" ? "All evidence" : value === "receipt" ? "Receipts" : `${value === "before" ? "Before" : "After"} repair`}</button>)}</div><span className="muted small">{record.evidence.length} {record.evidence.length === 1 ? "item" : "items"} in this case</span></div>
    {items.length ? <div className="evidence-grid">{items.map((item) => <article className="evidence-card" key={item.id}><button className="evidence-card-image image-preview-button" onClick={() => onPreview(item)} aria-label={`Preview ${item.name}`}><EvidenceImage item={item} /><span className={`image-label ${item.stage === "after" ? "image-label-green" : ""}`}>{item.stage === "before" ? "Before repair" : item.stage === "after" ? "After repair" : item.stage === "receipt" ? "Receipt" : "Document"}</span>{item.isDemo && <span className="sample-image-label">Sample</span>}</button><div className="evidence-card-body"><div className="evidence-card-title"><h3>{item.name}</h3><span>{shortDate(item.createdAt)}</span></div><p className="evidence-note">{item.note || "No additional notes."}</p>{item.temperatureF !== undefined && <span className="temperature-tag"><Thermometer size={14} />{item.temperatureF}°F {item.isDemo ? "sample reading" : "tenant-reported"}</span>}<AnalysisResult item={item} /><AnalysisError item={item} /><div className="evidence-card-footer"><span className="file-format">{item.mimeType.split("/")[1]?.toUpperCase() || "FILE"}</span><Button variant="ghost" icon={item.analysisError ? RefreshCw : ScanLine} busy={pending === "analyze_evidence" && !item.analysis} onClick={() => { void onAction({ action: "analyze_evidence", evidenceId: item.id }); }} disabled={!!pending || resolved || (!!item.analysis && (item.isDemo || !!item.analysis.requiresHumanConfirmation))}>{item.analysis && (item.isDemo || item.analysis.requiresHumanConfirmation) ? "Analyzed" : item.analysisError ? "Retry AI analysis" : "Analyze evidence"}</Button></div></div></article>)}</div> : <EmptyState icon={FileImage} title="No evidence in this view" action={!resolved ? <Button icon={Upload} onClick={onUpload}>Upload evidence</Button> : undefined}>Photos, documents, and receipts will appear here.</EmptyState>}
    {!resolved && <div className="demo-action-strip"><span className="demo-strip-icon"><FlaskConical size={19} /></span><div><strong>Sample evidence</strong><p>Before: 54°F indoor reading. After: 72°F after repair.</p></div><div className="demo-strip-buttons"><Button icon={ImagePlus} onClick={() => { void onAction({ action: "add_demo_evidence", stage: "before" }); }} disabled={!!pending}>Add before photo</Button><Button icon={ImagePlus} onClick={() => { void onAction({ action: "add_demo_evidence", stage: "after" }); }} disabled={!!pending}>Add after photo</Button></div></div>}
    {record.evidence.some((item) => item.stage === "after") && <div className="verification-strip"><ShieldCheck size={22} /><div><span className="eyebrow">APPLICATION CHECK</span><h3>{record.verification?.verified ? "Repair verification passed" : "Repair verification"}</h3><p>{comparison && hasTemperatureComparison ? `${beforeTemperature}°F before → ${afterTemperature}°F after. The application comparison ${comparison.passed ? "passed" : "requires more review"}.` : record.issue === "heating" ? "The application compares detected before and after temperatures when both readings are available." : "This issue requires manual review; AI observations can support the case record."}</p><p className="muted small">Tenant confirmation is required before settlement eligibility. AI analysis is not a legal finding and cannot authorize payment.</p></div><Button variant="primary" icon={ScanLine} busy={pending === "verify_repair"} disabled={!!pending || !record.repairReported || !Boolean(latestAfterEvidence(record)?.analysis) || resolved} onClick={() => { void onAction({ action: "verify_repair" }); }}>Verify repair</Button>{!record.repairReported ? <span className="full-row muted small">A completed repair must be reported before verification.</span> : !Boolean(latestAfterEvidence(record)?.analysis) ? <span className="full-row muted small">Analyze the after-repair evidence to continue.</span> : null}</div>}
  </section>;
}

export function draftNotice(record: CaseRecord) {
  return `Hello ${record.landlordName},\n\nI'm writing about the ${record.issue === "heating" ? "lack of heat" : record.issue + " issue"} in apartment ${record.apartment} at ${record.building.address}, first noticed on ${fullDate(record.noticedAt)}.\n\n${record.description}\n\nI've documented the issue and would appreciate a repair timeline. Please confirm when someone can inspect the apartment and complete the necessary repair.\n\n${record.tenant ? `Thank you,\n${record.tenant.name}` : "Thank you."}`;
}

function canonicalMessageBody(body: string, caseId: string) {
  const text = body.trim();
  const reference = `\n\nRentEscrow case: ${caseId}`;
  return text.endsWith(reference) ? text : `${text}${reference}`;
}

export function findOutboundMessage(record: CaseRecord, body: string, requestId?: string) {
  return record.messages.find((message) => message.sender === "tenant" && requestId && message.requestId === requestId)
    ?? [...record.messages].reverse().find((message) => message.sender === "tenant"
      && normalizeMessagingContact(message.recipient) === normalizeMessagingContact(record.landlordContact)
      && canonicalMessageBody(message.body, record.id) === canonicalMessageBody(body, record.id));
}

function messageDeliveryLabel(message: CaseMessage) {
  switch (message.delivery) {
    case "demo": return "Simulated delivery";
    case "sent": return message.provider === "spectrum" ? "Accepted by Spectrum" : message.provider === "photon" ? "Accepted by Photon" : "Accepted by provider";
    case "received": return "Received";
    case "pending": return "Delivery pending";
    case "failed": return "Not sent";
    case "uncertain": return "Delivery unconfirmed";
  }
}

export function MessagesPanel({ record, pending, onAction, integration }: CommonProps & { integration: IntegrationStatus | undefined }) {
  const [draft, setDraft] = useState(() => draftNotice(record));
  const [approved, setApproved] = useState(false);
  const [localError, setLocalError] = useState("");
  const requestId = useRef<string | null>(null);
  useEffect(() => { setDraft(draftNotice(record)); setApproved(false); setLocalError(""); requestId.current = null; }, [record.id, record.landlordName, record.landlordContact, record.tenant?.name]); // Changed roles or recipients require fresh approval.
  const resolved = record.status === "resolved";
  const liveDelivery = integration?.status === "configured";
  const deliveryUnavailable = !liveDelivery && integration?.status !== "demo";
  const unresolvedAttempt = record.messages.find((message) => message.sender === "tenant"
    && canonicalMessageBody(message.body, record.id) === canonicalMessageBody(draft, record.id)
    && (message.delivery === "pending" || message.delivery === "uncertain"));

  function updateDraft(value: string) {
    setDraft(value); setApproved(false); setLocalError(""); requestId.current = null;
  }
  function approveDraft(checked: boolean) {
    if (checked && record.messages.some((message) => message.requestId === requestId.current && message.delivery === "failed")) requestId.current = null;
    setApproved(checked);
  }
  async function send() {
    if (resolved || pending || deliveryUnavailable || unresolvedAttempt || !approved || !draft.trim()) return;
    const attemptId = requestId.current ?? crypto.randomUUID();
    requestId.current = attemptId;
    setApproved(false); setLocalError("");
    const result = await onAction({ action: "send_message", body: draft.trim(), approved: true, requestId: attemptId });
    const message = result ? findOutboundMessage(result, draft.trim(), attemptId) : undefined;
    if (message?.delivery === "demo" || message?.delivery === "sent") {
      setDraft(""); requestId.current = null;
    } else if (!result) {
      setLocalError("Your draft is kept. Review the delivery status before approving another attempt.");
    }
  }
  return <section className="tab-content">
    <SectionHeading eyebrow="TENANT-APPROVED COMMUNICATION" title="Conversation"><span className="muted small break-word"><Mail size={14} />{record.landlordContact}</span></SectionHeading>
    <div className="messages-layout">
      <div className="conversation">
        <div className="conversation-heading"><span className="person-avatar">{record.landlordName.charAt(0)}</span><div><strong>{record.landlordName}</strong><span>Property manager</span></div><span className="subtle-badge">{liveDelivery ? "External delivery enabled" : deliveryUnavailable ? "Delivery unavailable" : "Demo delivery"}</span></div>
        <div className="conversation-messages">{record.messages.length === 0 ? <EmptyState icon={MessageSquare} title="Start the conversation">No messages have been sent for this case yet.</EmptyState> : record.messages.map((message) => <article className={`message message-${message.sender}`} key={message.id}>
          <div className="message-meta"><strong>{message.sender === "tenant" ? "You" : message.sender === "landlord" ? record.landlordName : "RentEscrow assistant"}</strong><time>{shortDate(message.createdAt)} at {time(message.createdAt)}</time></div>
          <p>{message.body}</p>
          <div className="message-delivery">{message.delivery === "received" ? <ArrowDownLeft size={12} /> : message.delivery === "pending" ? <RefreshCw size={12} /> : message.delivery === "failed" || message.delivery === "uncertain" ? <ShieldX size={12} /> : <CheckCheck size={12} />}{messageDeliveryLabel(message)}</div>
          {message.delivery === "sent" && <p className="small muted">Provider acceptance is recorded; this is not a delivery or read receipt.</p>}
          {message.delivery === "pending" && <p className="small muted">This attempt is awaiting confirmation. Do not resend it.</p>}
          {message.delivery === "uncertain" && <p className="small muted">The provider may have accepted this message. Check the recipient's conversation before another send.</p>}
          {message.failureReason && <p className="form-error" role="status">{message.failureReason}</p>}
          {message.providerMessageId && <p className="small muted break-word">Provider reference: <span className="mono">{message.providerMessageId}</span></p>}
          {message.recipient && <p className="small muted break-word">Recipient: {message.recipient}</p>}
        </article>)}</div>
        {!resolved && <div className="demo-replies"><span className="eyebrow"><FlaskConical size={13} />SAMPLE LANDLORD REPLIES</span><div><Button icon={CalendarDays} onClick={() => { void onAction({ action: "simulate_landlord_reply", variant: "scheduled" }); }} disabled={!!pending || record.repairReported}>Schedule repair</Button><Button icon={Wrench} onClick={() => { void onAction({ action: "simulate_landlord_reply", variant: "completed" }); }} disabled={!!pending || record.repairReported}>Report repair complete</Button></div></div>}
      </div>
      <section className="message-composer">
        <div className="composer-heading"><span className="small-heading"><FileText size={17} />Message draft</span><Button variant="ghost" icon={Sparkles} onClick={() => updateDraft(draftNotice(record))} disabled={resolved || !!pending}>Draft notice</Button></div>
        <label className="field"><span>To <strong>{record.landlordName}</strong></span><textarea aria-label="Message to property manager" rows={14} value={draft} onChange={(event) => updateDraft(event.target.value)} maxLength={5000} disabled={resolved || !!pending} placeholder="Write a message to your property manager..." /></label>
        <div className="composer-count"><span><Paperclip size={13} />Case {record.id} referenced</span><span>{draft.length}/5,000</span></div>
        <label className="checkbox-label"><input type="checkbox" checked={approved} disabled={resolved || !!pending || deliveryUnavailable || !!unresolvedAttempt || !draft.trim()} onChange={(event) => approveDraft(event.target.checked)} /><span>I reviewed this message and approve sending it.</span></label>
        {unresolvedAttempt && <p className="form-error" role="status">An earlier attempt for this message is {unresolvedAttempt.delivery === "pending" ? "pending" : "unconfirmed"}. A new send is blocked to avoid duplicates.</p>}
        {localError && <p className="form-error" role="alert">{localError}</p>}
        <Button variant="primary" className="full-width" icon={Send} busy={pending === "send_message"} disabled={resolved || !!pending || deliveryUnavailable || !!unresolvedAttempt || !approved || !draft.trim()} onClick={() => { void send(); }}>Approve & send</Button>
        <p className="panel-footnote">{integration?.detail || "Messaging configuration is unavailable. No external send is available."}</p>
        {!liveDelivery && !deliveryUnavailable && <p className="panel-footnote">Demo messages stay within this workspace.</p>}
      </section>
    </div>
  </section>;
}

export function EscrowPanel({ record, pending, onAction, onRelease, onXrplReview, policy, xrplIntegration }: CommonProps & { onRelease: () => void; onXrplReview: () => void; policy: PolicyResult | null; xrplIntegration: IntegrationStatus | undefined }) {
  const resolved = record.status === "resolved";
  const funded = record.escrow.status !== "unfunded";
  const ready = canRelease(record);
  const settlement = record.xrplSettlement;
  const xrplConfigured = xrplIntegration?.status === "configured";
  const xrplUnavailable = xrplIntegration?.status === "unavailable";
  const canReviewSettlement = xrplConfigured && canReviewXrplSettlement(record);
  const latestSecurityAttempt = [...record.escrow.audit].reverse().find((entry) => entry.network === "testnet" && entry.status !== "validated" && entry.signed === false && entry.submitted === false && Boolean(entry.code));
  const securityScenarios = [
    ["wallet_switch", "Wallet switch"],
    ["amount_tamper", "Amount tampering"],
    ["prompt_injection", "Prompt injection"],
    ["insufficient_funds", "Insufficient funds"],
    ["duplicate", "Replay payment"],
    ["wrong_network", "Wrong network"],
    ["wrong_case", "Wrong case"],
    ["unsupported_action", "Unsupported action"],
  ] as const;
  function checkPolicy(tampered: boolean) {
    void onAction({ action: "policy_check", intent: { caseId: record.id, escrowId: record.escrow.id, transactionType: "EscrowFinish", destination: tampered ? "rUNAPPROVED_DEMO_DESTINATION" : record.escrow.destination, amountCents: record.escrow.amountCents, network: record.escrow.network } });
  }
  return <section className="tab-content"><SectionHeading eyebrow="APPLICATION ESCROW + OPTIONAL XRPL TESTNET" title="Rent escrow"><span className={`subtle-badge ${funded ? "badge-green" : ""}`}><LockKeyhole size={13} />{record.escrow.status === "locked" ? "Funds held" : record.escrow.status === "released" ? "Released" : "Not funded"}</span></SectionHeading><div className="escrow-layout"><div>
    <section className="escrow-primary"><div className="escrow-primary-top"><span className="escrow-large-icon"><LockKeyhole size={25} /></span><div><span className="muted small">Application disputed amount</span><div className="escrow-primary-amount">{money(record.escrow.amountCents)}</div></div><span className="subtle-badge">Simulated USD</span></div><dl className="escrow-details"><div><dt>Beneficiary</dt><dd>{record.landlordName}</dd></div><div><dt>Demo destination</dt><dd className="mono break-word">{record.escrow.destination}</dd></div><div><dt>Escrow reference</dt><dd className="mono break-word">{record.escrow.id}</dd></div><div><dt>Record type</dt><dd>Local simulation / USD</dd></div>{record.escrow.lockedAt && <div><dt>Funds set aside</dt><dd>{fullDate(record.escrow.lockedAt)}</dd></div>}{record.escrow.releasedAt && <div><dt>Funds released</dt><dd>{fullDate(record.escrow.releasedAt)}</dd></div>}</dl>{record.escrow.status === "unfunded" ? <><Button variant="primary" className="full-width" icon={LockKeyhole} busy={pending === "create_escrow"} disabled={!!pending || resolved || record.accountBalanceCents < record.escrow.amountCents} onClick={() => { void onAction({ action: "create_escrow" }); }}>Set aside {money(record.escrow.amountCents)}</Button><p className="panel-footnote">{record.accountBalanceCents < record.escrow.amountCents ? "The demo account has insufficient funds." : `${money(record.accountBalanceCents)} available in the simulated account.`}</p></> : record.escrow.status === "released" ? <div className="release-success"><BadgeCheck size={22} /><div><strong>Released with your approval</strong><p>The repair and release are recorded in your case history.</p></div></div> : settlement ? <><Button variant="primary" className="full-width" icon={ArrowUpRight} disabled={!!pending || !canReviewSettlement} onClick={onXrplReview}>Review Testnet settlement</Button><p className="panel-footnote">{settlement.hash ? "A transaction hash is already recorded. Reconcile its ledger result before any further settlement action." : ready ? "The simulated USD record closes only after the XRPL payment validates." : "Settlement becomes available when all repair checks pass."}</p></> : <><Button variant="primary" className="full-width" icon={ArrowUpRight} disabled={!!pending || !ready} onClick={onRelease}>Review & release {money(record.escrow.amountCents)}</Button><p className="panel-footnote">{ready ? "Final approval is required before simulated funds are released." : "Release becomes available when all repair checks pass."}</p></>}</section>

    <section className="xrpl-card" aria-labelledby="xrpl-settlement-title"><div className="xrpl-card-heading"><div><span className="eyebrow">REAL SETTLEMENT LAYER</span><h3 id="xrpl-settlement-title">XRPL Testnet Payment</h3></div><span className={`subtle-badge ${settlement?.status === "validated" ? "badge-green" : ""}`}>{settlement ? settlement.status : xrplConfigured ? "Available" : xrplUnavailable ? "Unavailable" : "Setup needed"}</span></div>{!xrplConfigured && <div className={`inline-note ${xrplUnavailable ? "note-amber" : "note-neutral"}`} role="status"><CircleDollarSign size={18} /><div><strong>{xrplUnavailable ? "Testnet settlement is unavailable" : "Testnet wallets are not configured"}</strong><p>{xrplIntegration?.detail || "Configure the server Testnet connection before enabling settlement. The simulated USD demo remains available."}</p></div></div>}{!settlement ? <div className="xrpl-empty"><p>The case can pin a server-controlled source, recipient, Test XRP amount, and Testnet network. Private signing keys never reach this browser.</p>{xrplConfigured ? <Button icon={Wallet} busy={pending === "enable_xrpl"} disabled={!!pending || !funded || resolved} onClick={() => { void onAction({ action: "enable_xrpl" }); }}>Enable Testnet settlement</Button> : null}{!funded && xrplConfigured && <p className="panel-footnote">Set aside the simulated disputed rent before enabling Testnet settlement.</p>}</div> : <><div className="settlement-amounts"><div><span>Application disputed amount</span><strong>{money(settlement.amountUsdCents)}</strong><small>Simulated USD</small></div><ArrowRight size={18} aria-hidden="true" /><div><span>XRPL Testnet settlement</span><strong>{formatTestXrp(settlement.amountDrops)}</strong><small>Test funds have no real value</small></div></div><p className="panel-footnote">These amounts are independent. Test XRP does not represent or convert to the USD dispute.</p><dl className="escrow-details xrpl-details"><div><dt>Case</dt><dd>{settlement.caseId}</dd></div><div><dt>Network / action</dt><dd>XRPL Testnet / Payment</dd></div><div><dt>Source wallet</dt><dd className="mono break-word">{settlement.source}</dd></div><div><dt>Authorized recipient</dt><dd className="mono break-word">{settlement.destination}</dd></div></dl>{pending === "settle_xrpl" && <div className="xrpl-waiting" role="status"><RefreshCw className="spin" size={18} /><div><strong>Waiting for a validated ledger result</strong><p>The case will remain unsettled unless XRPL reports a successful validation.</p></div></div>}{settlement.status === "ready" && <Button variant="primary" className="full-width" icon={ShieldCheck} disabled={!!pending || !canReviewSettlement} onClick={onXrplReview}>Review {formatTestXrp(settlement.amountDrops)} payment</Button>}{settlement.status === "pending" && <div className="xrpl-pending"><strong>Validation outcome pending</strong><p>{settlement.hash ? "A transaction was signed and its submission outcome needs reconciliation." : "No successful validated ledger result has been recorded."}</p>{settlement.hash && <a className="transaction-link mono" href={`https://testnet.xrpl.org/transactions/${settlement.hash}`} target="_blank" rel="noreferrer">{settlement.hash}<ExternalLink size={13} /></a>}<Button className="full-width" icon={RefreshCw} busy={pending === "reconcile_xrpl"} disabled={!!pending} onClick={() => { void onAction({ action: "reconcile_xrpl" }); }}>Reconcile ledger result</Button></div>}{settlement.status === "failed" && <div className="xrpl-failed"><strong>Settlement not completed</strong><p>{settlement.detail || settlement.errorCode || "XRPL did not return a successful validated result."}</p>{settlement.hash && <Button className="full-width" icon={RefreshCw} busy={pending === "reconcile_xrpl"} disabled={!!pending} onClick={() => { void onAction({ action: "reconcile_xrpl" }); }}>Reconcile ledger result</Button>}</div>}{settlement.status === "validated" && <div className="xrpl-receipt"><BadgeCheck size={22} /><div><strong>Settlement complete</strong><p>{settlement.result || "tesSUCCESS"}{settlement.ledgerIndex ? ` · Ledger ${settlement.ledgerIndex}` : ""}</p>{settlement.hash && <a className="transaction-link mono" href={`https://testnet.xrpl.org/transactions/${settlement.hash}`} target="_blank" rel="noreferrer">{settlement.hash}<ExternalLink size={13} /></a>}</div></div>}</>}</section>

    <section className="section-separated"><SectionHeading title="Transaction activity"><span className="muted small">{record.escrow.audit.length} records</span></SectionHeading>{record.escrow.audit.length ? <div className="audit-list">{[...record.escrow.audit].reverse().map((entry) => { const testnetAmount = entry.amountDrops || entry.approvedAmountDrops; const isBlocked = entry.status !== "validated"; return <article key={entry.id} className="audit-entry"><span className={`audit-icon ${entry.status === "validated" ? "green" : "red"}`}>{entry.status === "validated" ? <ShieldCheck size={18} /> : <ShieldX size={18} />}</span><div><div className="audit-title"><strong>{entry.action === "EscrowCreate" ? "Escrow funding" : entry.action === "EscrowFinish" ? "Escrow release" : entry.action === "Payment" ? "XRPL payment" : "Policy check"}</strong><span className={`text-status ${entry.status === "validated" ? "green" : "red"}`}>{entry.status}</span></div><p>{entry.detail}</p>{entry.code && <span className="audit-code mono">{entry.code}</span>}{entry.hash && (entry.network === "testnet" ? <a className="transaction-link mono" href={`https://testnet.xrpl.org/transactions/${entry.hash}`} target="_blank" rel="noreferrer">{entry.hash}<ExternalLink size={12} /></a> : <span className="audit-hash mono">{entry.hash}</span>)}{isBlocked && entry.network === "testnet" && entry.signed === false && entry.submitted === false && <span className="audit-safety">Nothing signed. Nothing submitted.</span>}<span className="audit-date">{shortDate(entry.createdAt)} at {time(entry.createdAt)} · {entry.network === "testnet" && testnetAmount ? formatTestXrp(testnetAmount) : money(entry.amountCents)} · {entry.network === "demo" ? "Simulated" : "XRPL Testnet"}</span></div></article>; })}</div> : <EmptyState icon={ShieldCheck} title="No transactions yet">Escrow actions and policy checks will appear here.</EmptyState>}</section>
  </div><aside><section className="release-checks"><SectionHeading title="Release requirements"><ShieldCheck size={18} className="green" /></SectionHeading><ul className="checklist"><CheckRow done={funded} title="Disputed rent is funded" /><CheckRow done={record.repairReported} title="Repair reported complete" /><CheckRow done={Boolean(latestAfterEvidence(record)?.analysis)} title="After-repair evidence analyzed" /><CheckRow done={!!record.verification?.verified} title="Repair verification passed" /><CheckRow done={record.tenantConfirmed} title="Tenant confirmation recorded" /></ul>{record.repairReported && !record.verification?.verified && <Button className="full-width" icon={ScanLine} disabled={!!pending || resolved || !Boolean(latestAfterEvidence(record)?.analysis)} busy={pending === "verify_repair"} onClick={() => { void onAction({ action: "verify_repair" }); }}>Verify repair evidence</Button>}{record.verification?.verified && !record.tenantConfirmed && <div className="tenant-confirmation"><p>I confirm that the issue in my apartment has been resolved.</p><Button variant="primary" className="full-width" icon={Check} disabled={!!pending || resolved} busy={pending === "confirm_resolution"} onClick={() => { void onAction({ action: "confirm_resolution" }); }}>Confirm repair is complete</Button></div>}</section>
    <section className="policy-section"><div className="policy-heading"><ShieldCheck size={19} /><div><h3>Simulation guardrails</h3><p>Simulated USD only. These checks do not authorize an XRPL payment.</p></div></div><ul className="guardrail-list"><li><Check size={14} />Case and demo escrow IDs match</li><li><Check size={14} />USD amount and demo network match</li><li><Check size={14} />Case-pinned demo destination only</li><li><Check size={14} />Repair checks and tenant consent</li><li><Check size={14} />No duplicate simulated release</li></ul><Button className="full-width" icon={ShieldCheck} onClick={() => checkPolicy(false)} disabled={!!pending || resolved}>Check release policy</Button><Button className="full-width" variant="ghost" icon={FlaskConical} onClick={() => checkPolicy(true)} disabled={!!pending || resolved}>Test wallet mismatch</Button></section>{policy && <section aria-label="Latest action policy result" className={`policy-result ${policy.approved ? "policy-approved" : "policy-rejected"}`}><strong>{policy.approved ? "All policy checks passed" : "Transaction blocked"}</strong><ul>{policy.checks.map((check, index) => <li key={`${check.key}-${index}`}><span>{check.passed ? <CheckCircle2 size={14} className="green" /> : <ShieldX size={14} className="red" />}</span><div><strong>{check.key}</strong><p>{check.detail || check.label}</p></div></li>)}</ul></section>}
    <section className="security-demo"><div className="policy-heading"><FlaskConical size={19} /><div><h3>Compromised-agent demos</h3><p>Dry runs against trusted case state</p></div></div><div className="security-grid">{securityScenarios.map(([scenario, label]) => <Button key={scenario} onClick={() => { void onAction({ action: "xrpl_security_demo", scenario }); }} disabled={!!pending || !settlement} busy={pending === "xrpl_security_demo"}>{label}</Button>)}</div><p className="panel-footnote">Every attack is checked before signing. Test controls never submit a transaction.</p>{latestSecurityAttempt && <div className="security-result" role="status"><span><ShieldX size={18} /></span><div><strong>Policy check failed</strong><code>{latestSecurityAttempt.code}</code><p>{latestSecurityAttempt.detail}</p><dl><div><dt>Authorized</dt><dd className="mono break-word">{settlement?.destination || latestSecurityAttempt.destination}</dd></div>{latestSecurityAttempt.destination && latestSecurityAttempt.destination !== settlement?.destination && <div><dt>Injected</dt><dd className="mono break-word">{latestSecurityAttempt.destination}</dd></div>}{latestSecurityAttempt.amountDrops && latestSecurityAttempt.approvedAmountDrops && latestSecurityAttempt.amountDrops !== latestSecurityAttempt.approvedAmountDrops && <div><dt>Attempted</dt><dd>{formatTestXrp(latestSecurityAttempt.amountDrops)} / approved {formatTestXrp(latestSecurityAttempt.approvedAmountDrops)}</dd></div>}</dl><b>Nothing signed. Nothing submitted.</b></div></div>}</section>
  </aside></div></section>;
}
