"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Building2, CheckCircle2, CircleHelp, Database, RefreshCw, Search } from "lucide-react";
import { getBuildingSummary, getRelatedComplaints, issueContextLabels } from "@/lib/building-context";
import type { BuildingRecord, HousingRecord, IssueType } from "@/lib/types";
import { Button, Modal } from "./workspace-ui";
import { redirectIfSignedOut } from "./use-session-guard";

export interface BuildingContextState {
  building: BuildingRecord | null;
  loading: boolean;
  error: string;
  reload: () => void;
}

type BuildingAudience = "tenant" | "landlord";

function apiPath(caseId: string, audience: BuildingAudience) {
  const encodedId = encodeURIComponent(caseId);
  return audience === "tenant" ? `/api/cases/${encodedId}/building` : `/api/landlord/cases/${encodedId}/building`;
}

export function useCaseBuildingContext(caseId: string | undefined, audience: BuildingAudience, fallback?: BuildingRecord): BuildingContextState {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const [state, setState] = useState<{ caseId?: string; building: BuildingRecord | null; loading: boolean; error: string }>({ caseId, building: fallback ?? null, loading: Boolean(caseId), error: "" });
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    if (!caseId) {
      setState({ caseId, building: fallbackRef.current ?? null, loading: false, error: "" });
      return;
    }

    const controller = new AbortController();
    setState({ caseId, building: fallbackRef.current ?? null, loading: true, error: "" });

    void (async () => {
      try {
        const response = await fetch(apiPath(caseId, audience), { cache: "no-store", signal: controller.signal });
        redirectIfSignedOut(response);
        const result = await response.json().catch(() => null) as (BuildingRecord & { error?: unknown }) | null;
        if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "NYC building history could not be refreshed.");
        if (!result) throw new Error("The building-history service returned an unexpected response.");
        if (version === requestVersion.current) setState({ caseId, building: result, loading: false, error: "" });
      } catch (cause) {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setState({ caseId, building: fallbackRef.current ?? null, loading: false, error: cause instanceof Error ? cause.message : "NYC building history could not be refreshed." });
      } finally {
        // Success and failure commit the complete state together so records from the
        // previously selected case never render under a new case heading.
      }
    })();

    return () => controller.abort();
  }, [audience, caseId, reloadVersion]);

  const reload = useCallback(() => setReloadVersion((version) => version + 1), []);
  if (state.caseId !== caseId) return { building: fallback ?? null, loading: Boolean(caseId), error: "", reload };
  return { building: state.building, loading: state.loading, error: state.error, reload };
}

function dateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

function freshnessLabel(building: BuildingRecord) {
  if (building.lookupStatus === "unavailable") return "Last attempted";
  return "Last refreshed";
}

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function statusLabel(record: HousingRecord) {
  const status = record.normalizedStatus ?? (record.status.toLowerCase().includes("open") ? "open" : record.status.toLowerCase().includes("close") ? "closed" : "unknown");
  return { status, label: status === "unknown" ? (record.status || "Status unknown") : status === "open" ? "Open" : "Closed" };
}

function contextBadge(building: BuildingRecord) {
  if (building.source === "demo" || building.lookupStatus === "demo") return { label: "DEMO DATA", tone: "demo" };
  if (building.lookupStatus === "partial") return { label: "Partial data", tone: "warning" };
  if (building.lookupStatus === "unavailable") return { label: "Provider unavailable", tone: "warning" };
  if (building.lookupStatus === "not_found") return { label: "No matching building", tone: "warning" };
  if (building.lookupStatus === "ambiguous") return { label: "Address needs review", tone: "warning" };
  if (building.lookupStatus === "invalid_address") return { label: "Invalid address", tone: "warning" };
  if (building.cache?.state === "stale") return { label: "Stale cache", tone: "warning" };
  if (building.cache?.state === "cached") return { label: "Cached", tone: "neutral" };
  return { label: "Public data", tone: "live" };
}

function availabilityMessage(building: BuildingRecord) {
  if (building.lookupStatus === "not_found") return "NYC Open Data did not return a matching building for this case address.";
  if (building.lookupStatus === "ambiguous") return "More than one NYC building matched this address. Review the address before relying on this context.";
  if (building.lookupStatus === "invalid_address") return "The case address could not be normalized for a reliable NYC building lookup.";
  if (building.lookupStatus === "unavailable") return "NYC Open Data is temporarily unavailable. Any records shown below are labeled saved or demo context.";
  if (building.lookupStatus === "partial") return "Some NYC housing datasets were unavailable, so these totals may be incomplete.";
  return building.warning ?? "";
}

function identifiers(building: BuildingRecord) {
  return [building.identifiers?.hpdBuildingId ? `HPD ${building.identifiers.hpdBuildingId}` : null, building.identifiers?.bin ? `BIN ${building.identifiers.bin}` : null, building.identifiers?.bbl ? `BBL ${building.identifiers.bbl}` : null].filter(Boolean) as string[];
}

function lookupResolved(building: BuildingRecord) {
  return building.lookupStatus !== "ambiguous" && building.lookupStatus !== "invalid_address" && building.lookupStatus !== "not_found";
}

function complaintsAvailable(building: BuildingRecord) {
  return lookupResolved(building) && building.datasets?.complaints !== "unavailable";
}

function violationsAvailable(building: BuildingRecord) {
  return lookupResolved(building) && building.datasets?.violations !== "unavailable";
}

function missingMetricLabel(building: BuildingRecord) {
  if (building.lookupStatus === "not_found") return "No matching building";
  if (building.lookupStatus === "ambiguous" || building.lookupStatus === "invalid_address") return "Address unresolved";
  return "Dataset unavailable";
}

export function BuildingHistorySummary({ building, issue, address, borough, loading, error, onOpen }: { building: BuildingRecord | null; issue: IssueType; address: string; borough: string; loading: boolean; error: string; onOpen: () => void }) {
  const summary = building ? getBuildingSummary(building) : null;
  const related = building ? getRelatedComplaints(building, issue) : [];
  const badge = building ? contextBadge(building) : null;
  const hasComplaints = Boolean(building && complaintsAvailable(building));
  const hasViolations = Boolean(building && violationsAvailable(building));
  return <section className="building-context-summary" aria-label="Building history summary">
    <div className="building-context-summary-icon"><Building2 size={20} /></div>
    <div className="building-context-summary-address"><span className="eyebrow">BUILDING HISTORY</span><strong>{building?.address ?? address}</strong><span>{building?.borough ?? borough}{building?.zip ? `, NY ${building.zip}` : ", NY"}</span></div>
    <button className="button button-secondary building-context-open" onClick={onOpen} aria-label="View building history">View public records</button>
    <div className="building-context-summary-metrics">
      <span><strong>{hasComplaints ? summary?.recentComplaints ?? "—" : "—"}</strong> recent complaints · 365 days</span>
      <span><strong>{hasViolations ? summary?.openViolations ?? "—" : "—"}</strong> open violations</span>
      <span><strong>{hasComplaints ? related.length : "—"}</strong> related to {issueContextLabels[issue]}</span>
    </div>
    <div className="building-context-summary-status" role={loading ? "status" : undefined}>
      {badge && <span className={`building-context-badge building-context-badge-${badge.tone}`}><Database size={12} />{badge.label}</span>}
      {building && <span>Source: {building.source === "demo" ? "Demo fallback" : "NYC Open Data / HPD"} · {freshnessLabel(building)} {dateTime(building.fetchedAt)}</span>}
      {building?.source === "nyc-open-data" && <span>Counts cover returned records only: up to 100 complaint problems and 100 violations.</span>}
      {loading ? <span><RefreshCw className="spin" size={13} />Refreshing NYC public data…</span> : error ? <span><AlertTriangle size={13} />Saved context · refresh unavailable</span> : null}
    </div>
  </section>;
}

export function BuildingHistoryPanel({ building, issue, address, borough, loading, error, onRetry, heading = "Case building" }: { building: BuildingRecord | null; issue: IssueType; address: string; borough: string; loading: boolean; error: string; onRetry?: () => void; heading?: string }) {
  const summary = building ? getBuildingSummary(building) : null;
  const related = building ? getRelatedComplaints(building, issue) : [];
  const badge = building ? contextBadge(building) : null;
  const message = building ? availabilityMessage(building) : "";
  const hasComplaints = Boolean(building && complaintsAvailable(building));
  const hasViolations = Boolean(building && violationsAvailable(building));
  const recentActivity = useMemo(() => {
    if (!building || !summary) return [];
    const since = new Date(summary.recentSince).getTime();
    return [
      ...building.complaints.map((record) => ({ ...record, recordType: "Complaint" as const })),
      ...building.violations.map((record) => ({ ...record, recordType: "Violation" as const })),
    ].filter((record) => {
      const timestamp = new Date(record.date).getTime();
      return Number.isFinite(timestamp) && timestamp >= since;
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 8);
  }, [building, summary]);
  const buildingIdentifiers = building ? identifiers(building) : [];

  if (!building && loading) return <div className="building-context-state" role="status"><RefreshCw className="spin" size={22} /><strong>Loading NYC building history…</strong><p>Matching this case address with public HPD records.</p></div>;
  if (!building) return <div className="building-context-state" role="alert"><CircleHelp size={22} /><strong>NYC building history could not be refreshed.</strong><p>{error || "No public building context is available for this case."}</p>{onRetry && <Button icon={RefreshCw} onClick={onRetry}>Try again</Button>}</div>;

  return <section className="building-history-panel" aria-label="Building history">
    <header className="building-history-heading">
      <div><span className="eyebrow">{heading.toUpperCase()}</span><h3>{building.address || address}</h3><p>{building.borough || borough}{building.zip ? `, NY ${building.zip}` : ", NY"}{buildingIdentifiers.length ? ` · ${buildingIdentifiers.join(" · ")}` : ""}</p></div>
      {badge && <span className={`building-context-badge building-context-badge-${badge.tone}`}>{badge.label}</span>}
    </header>

    {loading && <div className="building-refresh-state" role="status"><RefreshCw className="spin" size={14} />Refreshing this saved context…</div>}
    {error && <div className="building-context-alert" role="alert"><AlertTriangle size={17} /><div><strong>NYC building history could not be refreshed.</strong><p>{error} {building.source === "demo" ? "The clearly labeled demo fallback remains visible." : "The last saved public context remains visible."}</p></div>{onRetry && <Button icon={RefreshCw} onClick={onRetry}>Try again</Button>}</div>}
    {message && <div className="building-context-alert"><CircleHelp size={17} /><div><p>{message}</p>{building.warning && building.warning !== message && <p>{building.warning}</p>}</div></div>}

    <div className="building-history-metrics">
      <div><span>Recent complaints</span><strong>{hasComplaints ? summary?.recentComplaints ?? 0 : "—"}</strong><small>{hasComplaints && summary ? `365 days · since ${shortDate(summary.recentSince)}` : missingMetricLabel(building)}</small></div>
      <div><span>Open violations</span><strong>{hasViolations ? summary?.openViolations ?? 0 : "—"}</strong><small>{hasViolations ? "Within returned records" : missingMetricLabel(building)}</small></div>
      <div><span>Related to this case</span><strong>{hasComplaints ? related.length : "—"}</strong><small>{hasComplaints ? `${issueContextLabels[issue]} · returned records` : missingMetricLabel(building)}</small></div>
    </div>
    {building.source === "nyc-open-data" && <p className="panel-footnote">Counts cover returned records only: up to 100 complaint problems and 100 violations. Older open violations and additional complaints may exist.</p>}

    {hasComplaints && related.length > 0 ? <div className={`building-related-note ${building.lookupStatus === "partial" ? "is-partial" : ""}`}><CheckCircle2 size={18} /><div><strong>{building.lookupStatus === "partial" ? "Available public records include" : `${related.length} recent`} {building.lookupStatus === "partial" ? `${related.length} recent` : ""} {issueContextLabels[issue]} {related.length === 1 ? "complaint" : "complaints"} for this building.</strong><p>These are potentially related public records from the same building. They do not show that a complaint came from this apartment or prove what caused this case.</p></div></div> : <div className="building-related-note is-neutral"><CircleHelp size={18} /><div><strong>{hasComplaints ? `No recent ${issueContextLabels[issue]} complaints were returned in the available public records.` : "Related complaint totals are unavailable."}</strong><p>Public building records do not establish conditions in this apartment or prove what caused this case.</p></div></div>}

    <section className="building-activity-section">
      <div className="building-activity-heading"><div><span className="eyebrow">PUBLIC BUILDING CONTEXT</span><h4>Recent activity</h4></div><span>{recentActivity.length} shown</span></div>
      {recentActivity.length ? <ol className="building-activity-list">{recentActivity.map((record) => {
        const status = statusLabel(record);
        const isRelated = record.recordType === "Complaint" && related.some((item) => item.id === record.id);
        return <li key={`${record.recordType}-${record.id}`} className={isRelated ? "is-related" : ""}>
          <time dateTime={record.date}>{shortDate(record.date)}</time>
          <div><strong>{record.category || record.recordType}</strong><p>{record.description}</p><span>{record.recordType}{record.complaintId ? ` · Complaint ${record.complaintId}` : ""}</span></div>
          <span className={`building-record-status building-record-status-${status.status}`}>{status.label}</span>
        </li>;
      })}</ol> : <div className="building-record-empty"><p>{building.datasets?.complaints === "unavailable" ? "Complaint records are temporarily unavailable." : building.datasets?.violations === "unavailable" ? "Violation records are temporarily unavailable." : "No recent public activity was returned for this building."}</p></div>}
    </section>

    <footer className="building-source-row">
      <div><strong>Source: {building.source === "demo" ? "Demo fallback (not live NYC data)" : "NYC Open Data / HPD"}</strong><span>{freshnessLabel(building)}: {dateTime(building.fetchedAt)}{building.cache?.state === "stale" ? " · Stale cached response" : building.cache?.state === "cached" ? " · Cached response" : ""}</span></div>
      {building.cache?.state === "stale" && onRetry && <Button icon={RefreshCw} onClick={onRetry}>Refresh</Button>}
    </footer>
    <p className="building-context-disclaimer"><ShieldText />Public building context stays separate from tenant-uploaded evidence and cannot authorize financial or settlement actions.</p>
  </section>;
}

function ShieldText() {
  return <span aria-hidden="true"><Database size={14} /></span>;
}

export function BuildingHistoryDialog({ context, issue, address, borough, onClose, searchable = false }: { context: BuildingContextState; issue: IssueType; address: string; borough: string; onClose: () => void; searchable?: boolean }) {
  const [searchAddress, setSearchAddress] = useState(address);
  const [searchBorough, setSearchBorough] = useState(borough);
  const [preview, setPreview] = useState<BuildingRecord | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchVersion = useRef(0);
  const searchController = useRef<AbortController | null>(null);

  useEffect(() => () => searchController.current?.abort(), []);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const version = ++searchVersion.current;
    setSearching(true);
    setSearchError("");
    setPreview(null);
    try {
      const query = new URLSearchParams({ address: searchAddress.trim(), borough: searchBorough });
      const response = await fetch(`/api/buildings?${query}`, { cache: "no-store", signal: controller.signal });
      redirectIfSignedOut(response);
      const result = await response.json().catch(() => null) as (BuildingRecord & { error?: unknown }) | null;
      if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "The building lookup failed.");
      if (!result) throw new Error("The building lookup returned an unexpected response.");
      if (version === searchVersion.current) setPreview(result);
    } catch (cause) {
      if (controller.signal.aborted || version !== searchVersion.current) return;
      setSearchError(cause instanceof Error ? cause.message : "The building lookup failed.");
    } finally {
      if (!controller.signal.aborted && version === searchVersion.current) setSearching(false);
    }
  }

  function changeSearchAddress(value: string) {
    searchController.current?.abort();
    searchVersion.current += 1;
    setSearching(false);
    setSearchAddress(value);
    setPreview(null);
    setSearchError("");
  }

  function changeSearchBorough(value: string) {
    searchController.current?.abort();
    searchVersion.current += 1;
    setSearching(false);
    setSearchBorough(value);
    setPreview(null);
    setSearchError("");
  }

  return <Modal title="Building history" subtitle="NYC public complaint and violation context for this repair case." onClose={onClose} wide>
    <BuildingHistoryPanel building={context.building} issue={issue} address={address} borough={borough} loading={context.loading} error={context.error} onRetry={context.reload} />
    {searchable && <section className="building-explore-section">
      <header><span className="eyebrow">ADDRESS LOOKUP</span><h3>Explore another NYC building</h3><p>This temporary preview does not change this case&apos;s saved address or building history.</p></header>
      <form onSubmit={search} className="building-search"><label className="field">Street address<input value={searchAddress} onChange={(event) => changeSearchAddress(event.target.value)} required maxLength={200} disabled={searching} /></label><label className="field">Borough<select value={searchBorough} onChange={(event) => changeSearchBorough(event.target.value)} disabled={searching}>{["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"].map((name) => <option key={name}>{name}</option>)}</select></label><Button icon={Search} type="submit" busy={searching}>Search</Button></form>
      {searchError && <p className="form-error" role="alert">{searchError}</p>}
      {preview && <div className="building-search-preview"><BuildingHistoryPanel building={preview} issue={issue} address={searchAddress} borough={searchBorough} loading={false} error="" heading="Temporary search preview" /></div>}
    </section>}
  </Modal>;
}
