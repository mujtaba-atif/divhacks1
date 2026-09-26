"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, Building2, CheckCircle2, Search } from "lucide-react";
import type { BuildingRecord, IssueType } from "@/lib/types";
import { Button, Modal } from "./workspace-ui";

export interface NewCaseInput {
  issue: IssueType;
  description: string;
  noticedAt: string;
  address: string;
  borough: string;
  apartment: string;
  landlordName: string;
  landlordContact: string;
  monthlyRentCents: number;
  disputedAmountCents: number;
}

export function NewCaseDialog({ onClose, onCreate, busy }: { onClose: () => void; onCreate: (input: NewCaseInput) => Promise<boolean>; busy: boolean }) {
  const [address, setAddress] = useState("");
  const [borough, setBorough] = useState("Manhattan");
  const [building, setBuilding] = useState<BuildingRecord | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [error, setError] = useState("");

  async function lookup() {
    if (lookupBusy || busy) return;
    if (!address.trim()) { setError("Enter a building address first."); return; }
    setLookupBusy(true); setError(""); setBuilding(null);
    try {
      const query = new URLSearchParams({ address: address.trim(), borough });
      const response = await fetch(`/api/buildings?${query}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Building records could not be retrieved.");
      setBuilding(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Building lookup failed."); }
    finally { setLookupBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lookupBusy || busy) return;
    setError("");
    const form = new FormData(event.currentTarget);
    const monthlyRentCents = Math.round(Number(form.get("monthlyRent")) * 100);
    const disputedAmountCents = Math.round(Number(form.get("disputedAmount")) * 100);
    if (disputedAmountCents > monthlyRentCents) { setError("The disputed amount cannot exceed your monthly rent."); return; }
    const success = await onCreate({ issue: form.get("issue") as IssueType, description: String(form.get("description")).trim(), noticedAt: String(form.get("noticedAt")), address: address.trim(), borough, apartment: String(form.get("apartment")).trim(), landlordName: String(form.get("landlordName")).trim(), landlordContact: String(form.get("landlordContact")).trim(), monthlyRentCents, disputedAmountCents });
    if (success) onClose();
    else setError("The case could not be created. Check the details and try again.");
  }

  return <Modal title="Open a repair case" subtitle="Keep the issue, supporting evidence, and repair history together." onClose={onClose} wide>
    <form onSubmit={submit} className="case-form">
      <div className="form-section-title"><Building2 size={17} /><h3>Building & apartment</h3></div>
      <div className="form-grid">
        <label className="field field-wide">Street address<input name="address" placeholder="123 West 110th Street" required maxLength={200} value={address} disabled={lookupBusy || busy} onChange={(event) => { setAddress(event.target.value); setBuilding(null); }} /></label>
        <label className="field">Borough<select name="borough" value={borough} disabled={lookupBusy || busy} onChange={(event) => { setBorough(event.target.value); setBuilding(null); }}>{["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="field">Apartment<input name="apartment" placeholder="4B" required maxLength={30} /></label>
      </div>
      <div className="lookup-row"><Button icon={Search} busy={lookupBusy} disabled={busy} onClick={lookup}>Check NYC records</Button><span>Public housing records</span></div>
      {building && <div className={`inline-note ${building.warning ? "note-amber" : "note-green"}`}><CheckCircle2 size={17} /><div><strong>{building.source === "demo" ? "Sample building records" : "NYC Open Data"}</strong><p>{building.complaints.length} complaints · {building.violations.length} violations{building.warning ? `. ${building.warning}` : ""}</p></div></div>}
      <div className="form-section-title"><h3>Repair details</h3></div>
      <div className="form-grid">
        <label className="field">Issue<select name="issue" defaultValue="heating"><option value="heating">Heating / hot water</option><option value="mold">Mold</option><option value="leak">Water leak</option><option value="pests">Pests</option><option value="elevator">Elevator</option><option value="other">Other repair</option></select></label>
        <label className="field">First noticed<input name="noticedAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} max={new Date().toISOString().slice(0, 10)} required /></label>
        <label className="field field-wide">What happened?<textarea name="description" placeholder="Describe the issue and how it affects your apartment." rows={3} minLength={10} maxLength={4000} required /></label>
        <label className="field">Landlord / property manager<input name="landlordName" placeholder="Property manager name" maxLength={150} required /></label>
        <label className="field">Landlord contact<input name="landlordContact" placeholder="Email address or phone number" maxLength={200} required /></label>
        <label className="field">Monthly rent (USD)<input name="monthlyRent" type="number" placeholder="2400.00" min="0.01" max="100000" step="0.01" required /></label>
        <label className="field">Disputed amount (USD)<input name="disputedAmount" type="number" placeholder="600.00" min="0.01" max="100000" step="0.01" required /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-footer"><span className="muted small">New cases use simulated funds.</span><div><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" icon={ArrowRight} busy={busy} disabled={lookupBusy}>Create case</Button></div></div>
    </form>
  </Modal>;
}
