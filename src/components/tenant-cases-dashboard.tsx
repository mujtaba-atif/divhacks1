"use client";

import { useState } from "react";
import { ArrowRight, CalendarClock, FileImage, FolderOpen, LockKeyhole, Plus } from "lucide-react";
import type { CaseRecord, CaseStatus } from "@/lib/types";
import { Button, money, StatusBadge } from "./workspace-ui";

function caseProgress(record: CaseRecord) {
  if (record.status === "resolved") return 100;
  let completed = 20;
  if (record.evidence.length) completed += 20;
  if (record.messages.length) completed += 20;
  if (record.escrow.status !== "unfunded") completed += 20;
  if (record.repairReported || record.verification) completed += 20;
  return completed;
}

type CaseFilter = "all" | CaseStatus;

function nextCaseDeadline(cases: CaseRecord[]) {
  const now = Date.now();
  const deadlines = cases.flatMap((record) => {
    const values: { at: number; label: string }[] = [];
    const scheduledFor = record.maintenanceSchedule?.scheduledFor;
    if (scheduledFor) values.push({ at: Date.parse(scheduledFor), label: "repair appointment" });
    for (const event of record.messagingEvents || []) {
      if (event.scheduledFor) values.push({ at: Date.parse(event.scheduledFor), label: "case schedule" });
    }
    const policy = record.contractSnapshot?.status === "active" ? record.contractSnapshot.policy : undefined;
    if (policy?.effectiveDate && policy.nonMonetaryDefault.deadlineDays > 0) {
      const effective = Date.parse(policy.effectiveDate);
      if (Number.isFinite(effective)) values.push({ at: effective + policy.nonMonetaryDefault.deadlineDays * 86_400_000, label: "agreement deadline" });
    }
    return values;
  }).filter((item) => Number.isFinite(item.at) && item.at >= now).sort((a, b) => a.at - b.at);
  return deadlines[0];
}

export function TenantCasesDashboard({ cases, onCreate, onOpen }: {
  cases: CaseRecord[];
  onCreate: () => void;
  onOpen: (record: CaseRecord) => void;
}) {
  const [filter, setFilter] = useState<CaseFilter>("all");
  const activeCases = cases.filter((record) => record.status !== "resolved");
  const visibleCases = filter === "all" ? cases : cases.filter((record) => record.status === filter);
  const escrowTotal = activeCases.reduce((total, record) => total + (record.escrow.status === "locked" ? record.escrow.amountCents : 0), 0);
  const nextDeadline = nextCaseDeadline(activeCases);

  return <section className="tenant-cases-dashboard" aria-labelledby="tenant-cases-title">
    <div className="tenant-dashboard-heading">
      <div>
        <h1 id="tenant-cases-title">My cases</h1>
        <p>Track issues, evidence, notices, and protected rent in one place.</p>
      </div>
      <Button variant="primary" icon={Plus} onClick={onCreate}>New case</Button>
    </div>

    <dl className="tenant-case-metrics">
      <div><dt>Open cases</dt><dd><strong>{activeCases.length}</strong><span>{activeCases.length ? "in progress" : "none yet"}</span></dd></div>
      <div><dt>Rent in escrow</dt><dd><strong>{money(escrowTotal)}</strong><span>{escrowTotal ? "protected funds" : "no deposits held"}</span></dd></div>
      <div><dt>Next deadline</dt><dd><strong>{nextDeadline ? new Date(nextDeadline.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "–"}</strong><span>{nextDeadline?.label || "no upcoming deadlines"}</span></dd></div>
    </dl>

    <div className="tenant-case-gallery">
      <div className="tenant-gallery-header">
        <div><h2>All cases</h2><span>{cases.length}</span></div>
        <label className="tenant-filter-button"><span className="sr-only">Filter cases by status</span><select value={filter} onChange={(event) => setFilter(event.target.value as CaseFilter)}><option value="all">All statuses</option><option value="open">Open case</option><option value="awaiting_repair">Awaiting repair</option><option value="verification">Under review</option><option value="verified">Repair verified</option><option value="resolved">Resolved</option></select></label>
      </div>
      {cases.length === 0 ? <div className="tenant-dashboard-empty">
        <span className="tenant-empty-folder"><FolderOpen size={29} /></span>
        <h2>No cases yet</h2>
        <p>Your cases will appear here once you create one. Each case organizes your evidence, notices, and protected rent in one place.</p>
        <Button variant="primary" icon={Plus} onClick={onCreate}>Create your first case</Button>
        <small>Takes about 5 minutes · No paperwork required</small>
      </div> : visibleCases.length === 0 ? <div className="tenant-dashboard-filter-empty" role="status"><FolderOpen size={24} /><h3>No cases match this status</h3><p>Your {cases.length} {cases.length === 1 ? "case is" : "cases are"} still available under All statuses.</p><Button onClick={() => setFilter("all")}>Show all cases</Button></div> : <div className="tenant-case-grid">{visibleCases.map((record) => {
        const preview = record.evidence.find((item) => item.mimeType.startsWith("image/") && (item.dataUrl || item.isDemo));
        const previewSource = preview?.isDemo ? (preview.stage === "after" ? "/evidence-after.png" : "/evidence-before.png") : preview?.dataUrl;
        const progress = caseProgress(record);
        return <article className="tenant-case-card" key={record.id}>
          <button type="button" className="tenant-case-card-open" onClick={() => onOpen(record)} aria-label={`Open ${record.title}`}>
            <div className="tenant-case-cover">{previewSource ? <img src={previewSource} alt="" /> : <><FileImage size={25} /><span>Case photo will appear here</span></>}</div>
            <div className="tenant-case-card-body">
              <div className="tenant-case-card-title"><div><span>{record.id}</span><h3>{record.title}</h3></div><StatusBadge status={record.status} /></div>
              <p>{record.building.address}, Apt {record.apartment}</p>
              <div className="tenant-card-progress"><div><span style={{ width: `${progress}%` }} /></div><small>{progress}% complete</small></div>
              <div className="tenant-card-footer"><span><CalendarClock size={13} />Updated {new Date(record.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span><strong>Open case <ArrowRight size={14} /></strong></div>
            </div>
          </button>
        </article>;
      })}</div>}
    </div>

    <p className="tenant-dashboard-protection"><LockKeyhole size={13} />Your case records and evidence stay private to your account.</p>
  </section>;
}
