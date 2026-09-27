"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  MailPlus,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import type { AuthUser, LandlordCase } from "@/lib/types";
import "./landlord-account-properties.css";

type MembershipFilter = "all" | "active" | "inactive";

interface UnitSummary {
  apartment: string;
  tenants: string[];
  cases: LandlordCase[];
  activeCases: LandlordCase[];
  openCaseId: string;
}

interface PropertySummary {
  id: string;
  address: string;
  borough: string;
  units: UnitSummary[];
  activeRepairCount: number;
}

const activeCase = (record: LandlordCase) => record.status !== "resolved";

const caseRecency = (left: LandlordCase, right: LandlordCase) =>
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt);

function buildPropertySummaries(cases: LandlordCase[]): PropertySummary[] {
  const properties = new Map<string, {
    id: string;
    address: string;
    borough: string;
    units: Map<string, LandlordCase[]>;
  }>();

  for (const record of cases) {
    const propertyKey = record.property.id || `${record.property.address}:${record.property.borough}`;
    const property = properties.get(propertyKey) ?? {
      id: propertyKey,
      address: record.property.address,
      borough: record.property.borough,
      units: new Map<string, LandlordCase[]>(),
    };
    const unitKey = record.property.apartment || "Unit not specified";
    property.units.set(unitKey, [...(property.units.get(unitKey) ?? []), record]);
    properties.set(propertyKey, property);
  }

  return Array.from(properties.values()).map((property) => {
    const units = Array.from(property.units.entries()).map(([apartment, unitCases]) => {
      const sortedCases = [...unitCases].sort(caseRecency);
      const activeCases = sortedCases.filter(activeCase);
      return {
        apartment,
        cases: sortedCases,
        activeCases,
        tenants: Array.from(new Set(sortedCases.map((record) => record.tenant.displayName))).filter(Boolean),
        openCaseId: (activeCases[0] ?? sortedCases[0]).id,
      };
    }).sort((left, right) => left.apartment.localeCompare(right.apartment, undefined, { numeric: true }));

    return {
      id: property.id,
      address: property.address,
      borough: property.borough,
      units,
      activeRepairCount: units.reduce((total, unit) => total + unit.activeCases.length, 0),
    };
  }).sort((left, right) => left.address.localeCompare(right.address));
}

function initials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "L";
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function UnitRepairBadge({ count }: { count: number }) {
  if (count === 0) {
    return <span className="ld-badge green"><span aria-hidden="true" />No active repairs</span>;
  }

  return (
    <span className={`ld-badge ${count > 1 ? "amber" : "blue"}`}>
      <span aria-hidden="true" />
      {plural(count, "active repair")}
    </span>
  );
}

export function LandlordProperties({
  cases,
  onOpenCase,
}: {
  cases: LandlordCase[];
  onOpenCase: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [membership, setMembership] = useState<MembershipFilter>("all");
  const properties = useMemo(() => buildPropertySummaries(cases), [cases]);
  const filteredProperties = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();

    return properties.flatMap((property) => {
      const propertyMatches = !search || `${property.address} ${property.borough}`.toLocaleLowerCase().includes(search);
      const units = property.units.filter((unit) => {
        const matchesMembership = membership === "all"
          || (membership === "active" && unit.activeCases.length > 0)
          || (membership === "inactive" && unit.activeCases.length === 0);
        const matchesSearch = propertyMatches || `${unit.apartment} ${unit.tenants.join(" ")} ${unit.cases.map((record) => record.title).join(" ")}`
          .toLocaleLowerCase()
          .includes(search);
        return matchesMembership && matchesSearch;
      });

      if (units.length === 0) return [];
      return [{ ...property, units, activeRepairCount: units.reduce((total, unit) => total + unit.activeCases.length, 0) }];
    });
  }, [membership, properties, query]);

  return (
    <section className="ld-content-view ldp-view" aria-labelledby="ldp-properties-title">
      <div className="ld-heading ldp-heading">
        <div>
          <h1 id="ldp-properties-title">Properties</h1>
          <p className="ld-muted">Review assigned units, tenants, and active repair cases.</p>
        </div>
        <button
          className="ld-button primary"
          type="button"
          disabled
          aria-describedby="ldp-property-actions-note"
          title="Adding properties is not available in this workspace"
        >
          <Plus size={16} aria-hidden="true" />
          Add property
        </button>
      </div>

      <div className="ldp-property-tools">
        <label className="ldp-field ldp-search-field">
          <span>Search</span>
          <span className="ldp-input-wrap">
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search property, unit, tenant, or case"
            />
          </span>
        </label>
        <label className="ldp-field">
          <span>Membership</span>
          <span className="ldp-select-wrap">
            <select value={membership} onChange={(event) => setMembership(event.target.value as MembershipFilter)}>
              <option value="all">All assigned units</option>
              <option value="active">With active repairs</option>
              <option value="inactive">No active repairs</option>
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </label>
        <button
          className="ld-button ldp-invite-button"
          type="button"
          disabled
          aria-describedby="ldp-property-actions-note"
          title="Tenant invitations are not available in this workspace"
        >
          <MailPlus size={16} aria-hidden="true" />
          Invite tenant
        </button>
      </div>

      <div className="ld-note ldp-access-note" id="ldp-property-actions-note">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>Property access is server managed</strong>
          <p>Only units with cases assigned to this landlord account appear here. Adding properties and inviting tenants are not available yet.</p>
        </div>
      </div>

      <div className="ldp-property-list" aria-live="polite">
        {filteredProperties.map((property) => (
          <section className="ld-panel ldp-property-card" key={property.id} aria-label={property.address}>
            <header className="ldp-property-header">
              <div>
                <h2>{property.address}</h2>
                <p className="ld-muted">{property.borough} &middot; {plural(property.units.length, "assigned unit")}</p>
              </div>
              <div className="ldp-property-stats" aria-label={`${plural(property.units.length, "assigned unit")}, ${plural(property.activeRepairCount, "active repair")}`}>
                <span><strong>{property.units.length}</strong><small>Assigned units</small></span>
                <span><strong>{property.activeRepairCount}</strong><small>Active repairs</small></span>
              </div>
            </header>

            <div className="ldp-unit-table" role="table" aria-label={`Assigned units at ${property.address}`}>
              <div className="ldp-unit-table-head" role="row">
                <span role="columnheader">Unit</span>
                <span role="columnheader">Tenant</span>
                <span role="columnheader">Repairs</span>
                <span role="columnheader">Access</span>
                <span role="columnheader"><span className="sr-only">Open case</span></span>
              </div>
              {property.units.map((unit) => (
                <div className="ldp-unit-row" role="row" key={unit.apartment}>
                  <span className="ldp-unit-name" role="cell" data-label="Unit">{unit.apartment}</span>
                  <span className="ldp-tenant-cell" role="cell" data-label="Tenant">
                    <strong>{unit.tenants.join(", ") || "Tenant name unavailable"}</strong>
                    <small>{plural(unit.cases.length, "assigned case")}</small>
                  </span>
                  <span role="cell" data-label="Repairs"><UnitRepairBadge count={unit.activeCases.length} /></span>
                  <span className="ld-muted ldp-access-cell" role="cell" data-label="Access">Server assigned</span>
                  <span className="ldp-open-cell" role="cell" data-label="Action">
                    <button className="ldp-open-unit" type="button" onClick={() => onOpenCase(unit.openCaseId)}>
                      Open case <ArrowRight size={15} aria-hidden="true" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}

        {filteredProperties.length === 0 && (
          <div className="ld-panel ldp-empty-state">
            <Building2 size={24} aria-hidden="true" />
            <h2>{properties.length === 0 ? "No assigned properties" : "No matching units"}</h2>
            <p className="ld-muted">
              {properties.length === 0
                ? "Properties will appear when the server assigns a case to this landlord account."
                : "Try a different search or membership filter."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export function LandlordAccount({
  user,
  cases,
  onOpenProperty,
}: {
  user: AuthUser;
  cases: LandlordCase[];
  onOpenProperty: () => void;
}) {
  const properties = useMemo(() => buildPropertySummaries(cases), [cases]);

  return (
    <section className="ld-content-view ldp-view" aria-labelledby="ldp-account-title">
      <div className="ld-heading ldp-heading">
        <div>
          <h1 id="ldp-account-title">Account &amp; Access</h1>
          <p className="ld-muted">Identity, assigned properties, role permissions, and account security.</p>
        </div>
        <button
          className="ld-button"
          type="button"
          disabled
          aria-describedby="ldp-account-actions-note"
          title="Security settings are not available in this workspace"
        >
          <ShieldCheck size={16} aria-hidden="true" />
          Manage security
        </button>
      </div>

      <div className="ld-note ldp-access-note" id="ldp-account-actions-note">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>Account access is server managed</strong>
          <p>Your identity and assigned case access come from the signed-in account. Profile and security changes are not available yet.</p>
        </div>
      </div>

      <section className="ld-panel ldp-identity-panel" aria-label="Landlord identity">
        <div className="ld-avatar ldp-account-avatar" aria-hidden="true">{initials(user.displayName)}</div>
        <div className="ldp-identity-copy">
          <div className="ldp-identity-name">
            <h2>{user.displayName}</h2>
            <span className="ld-badge green"><span aria-hidden="true" />Landlord account</span>
          </div>
          <p className="ld-muted">{user.email}</p>
          {user.maskedPhone && <p className="ld-muted">{user.maskedPhone}</p>}
        </div>
        <button
          className="ld-button ldp-edit-button"
          type="button"
          disabled
          aria-describedby="ldp-account-actions-note"
          title="Profile editing is not available in this workspace"
        >
          <Pencil size={15} aria-hidden="true" />
          Edit profile
        </button>
      </section>

      <section className="ld-panel ldp-account-panel" aria-labelledby="ldp-associated-properties">
        <header className="ldp-panel-heading">
          <h2 id="ldp-associated-properties">Assigned properties</h2>
          <span className="ld-muted">{plural(properties.length, "server assignment")}</span>
        </header>
        {properties.length > 0 ? (
          <div className="ldp-account-properties">
            {properties.map((property) => (
              <button className="ldp-account-property" type="button" onClick={onOpenProperty} key={property.id}>
                <span className="ldp-property-icon"><Building2 size={18} aria-hidden="true" /></span>
                <span className="ldp-account-property-copy">
                  <strong>{property.address}</strong>
                  <small>{property.borough} &middot; {plural(property.units.length, "assigned unit")}</small>
                </span>
                <span className="ldp-account-property-role">
                  <strong>Assigned landlord</strong>
                  <small>{plural(property.activeRepairCount, "active repair")}</small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : (
          <div className="ldp-account-empty">
            <p>No properties are currently associated with assigned cases.</p>
          </div>
        )}
      </section>

      <section className="ld-panel ldp-account-panel ldp-permissions-panel" aria-labelledby="ldp-role-permissions">
        <header className="ldp-panel-heading">
          <h2 id="ldp-role-permissions">Landlord role permissions</h2>
          <span className="ld-muted">Server enforced</span>
        </header>
        <div className="ldp-permission-columns">
          <div>
            <h3>Allowed</h3>
            <ul>
              <li><Check size={16} aria-hidden="true" />View assigned repair cases</li>
              <li><Check size={16} aria-hidden="true" />Message tenants on assigned cases</li>
              <li><Check size={16} aria-hidden="true" />Schedule and report repair work</li>
              <li><Check size={16} aria-hidden="true" />Upload landlord repair evidence</li>
              <li><Check size={16} aria-hidden="true" />Review assigned building history</li>
            </ul>
          </div>
          <div className="ldp-restricted-permissions">
            <h3>Not allowed</h3>
            <ul>
              <li><X size={16} aria-hidden="true" />Access unrelated properties or cases</li>
              <li><X size={16} aria-hidden="true" />Edit tenant evidence or impersonate tenants</li>
              <li><X size={16} aria-hidden="true" />Approve messages on a tenant&apos;s behalf</li>
              <li><X size={16} aria-hidden="true" />Release escrow or change its destination</li>
              <li><X size={16} aria-hidden="true" />View private tenant banking history</li>
            </ul>
          </div>
        </div>
      </section>
    </section>
  );
}
