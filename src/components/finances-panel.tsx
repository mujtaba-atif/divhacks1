"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CalendarDays, Check, CheckCircle2, Clock3, FileText, FlaskConical, Landmark, Plus, RefreshCw, ShieldCheck, ShieldX, Wallet, X } from "lucide-react";
import type { CaseRecord, FinancialProfile, FinancialTransaction, PolicyResult } from "@/lib/types";
import type { RunAction } from "./case-panels";
import { Button, EmptyState, money, SectionHeading, shortDate, time } from "./workspace-ui";

type TransactionFilter = "all" | FinancialTransaction["relatedStatus"];

function useFreshVerification(profile?: FinancialProfile) {
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = profile?.expiresAt;
  useEffect(() => {
    setNow(Date.now());
    if (!expiresAt) return;
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timeout = window.setTimeout(() => setNow(Date.now()), Math.min(remaining + 20, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [expiresAt]);
  return profile?.status === "verified" && profile.customerVerified && profile.accountVerified && profile.ownershipVerified
    && Boolean(expiresAt) && new Date(expiresAt!).getTime() > now;
}

function VerificationRow({ label, verified, fresh, unavailable }: { label: string; verified: boolean; fresh: boolean; unavailable: boolean }) {
  const passed = verified && fresh;
  return <div className="nessie-verification-row"><span>{label}</span><span className={`text-status ${passed ? "green" : unavailable ? "red" : "amber"}`}>{passed ? <CheckCircle2 size={15} /> : unavailable ? <ShieldX size={15} /> : <Clock3 size={15} />}{passed ? "Verified" : unavailable ? "Unavailable" : verified ? "Stale" : "Not verified"}</span></div>;
}

export function FinancesPanel({ record, pending, onAction, onExpense, policy, nessieConfigured = false }: {
  record: CaseRecord;
  pending: string | null;
  onAction: RunAction;
  onExpense: () => void;
  policy: PolicyResult | null;
  nessieConfigured?: boolean;
}) {
  const [filter, setFilter] = useState<TransactionFilter>("all");
  const attemptedCase = useRef<string | null>(null);
  const [failedCase, setFailedCase] = useState<string | null>(null);
  const [checkedCase, setCheckedCase] = useState<string | null>(null);
  const liveRequested = nessieConfigured || record.financialProfile?.binding.source === "nessie";
  // A seeded fixture is not a live banking snapshot while the first server check is in flight.
  const profile = liveRequested && record.financialProfile?.binding.source === "demo" ? undefined : record.financialProfile;
  const verified = useFreshVerification(profile);
  const resolved = record.status === "resolved";
  const requestFailed = failedCase === record.id;
  const fresh = verified && !resolved && !requestFailed && (!liveRequested || checkedCase === record.id);
  const unavailable = requestFailed || profile?.status === "unavailable" || profile?.status === "rejected";
  async function refreshProfile() {
    setFailedCase(null);
    setCheckedCase(null);
    const result = await onAction({ action: "sync_finances" });
    if (!result) setFailedCase(record.id);
    else setCheckedCase(record.id);
  }
  useEffect(() => {
    if (!liveRequested || resolved || pending || attemptedCase.current === record.id) return;
    attemptedCase.current = record.id;
    // A cached profile may predate a server configuration change, even within its TTL.
    void refreshProfile();
  }, [liveRequested, resolved, pending, record.id, onAction]);
  const stale = profile?.status === "verified" && !fresh;
  const source = profile?.binding.source === "nessie" ? "Nessie API (sandbox)" : profile?.binding.source === "demo" ? "Demo fixture" : nessieConfigured ? "Nessie API not loaded" : "Demo fixture not loaded";
  const transactions = (profile?.transactions || []).filter((item) => !liveRequested || item.source === "nessie");
  const visibleTransactions = transactions.filter((item) => filter === "all" || item.relatedStatus === filter);
  const suggested = transactions.filter((item) => item.relatedStatus === "suggested");
  const rentHistory = record.rentHistory.filter((item) => !liveRequested || item.source === "nessie").sort((left, right) => {
    const leftDate = Date.parse(left.month);
    const rightDate = Date.parse(right.month);
    if (Number.isNaN(leftDate)) return Number.isNaN(rightDate) ? 0 : 1;
    if (Number.isNaN(rightDate)) return -1;
    return leftDate - rightDate;
  });
  const expenseTotal = record.expenses.reduce((sum, expense) => sum + expense.amountCents, 0);
  const bankBalance = unavailable ? undefined : profile?.accountBalanceCents;
  const bankSufficient = bankBalance !== undefined && bankBalance >= record.escrow.amountCents;
  const mismatch = policy?.reasonCodes?.some((code) => code === "NESSIE_ACCOUNT_MISMATCH" || code === "NESSIE_CUSTOMER_MISMATCH");
  const busy = !!pending;
  useEffect(() => setFilter("all"), [record.id]);

  return <section className="tab-content nessie-finances">
    <SectionHeading eyebrow="FINANCIAL IDENTITY & BANKING CONTEXT" title="Capital One / Nessie"><Button icon={RefreshCw} busy={pending === "sync_finances"} disabled={busy || resolved} onClick={() => { void refreshProfile(); }}>{profile ? "Refresh financial profile" : "Load financial profile"}</Button></SectionHeading>
    <div className="nessie-source-line"><strong data-testid="nessie-data-status" role="status">{unavailable ? "ERROR / UNAVAILABLE" : liveRequested ? fresh ? "LIVE / VERIFIED" : stale ? "LIVE / STALE" : "LIVE / CHECKING" : "DEMO"}</strong><span className="subtle-badge"><Landmark size={13} />{source}</span><span className={`text-status ${fresh ? "green" : unavailable ? "red" : "amber"}`}>{fresh ? <ShieldCheck size={14} /> : <AlertCircle size={14} />}{fresh ? liveRequested ? "Binding verified" : "Demo binding checked" : unavailable ? "Verification unavailable" : stale ? "Verification stale" : "Verification required"}</span>{profile?.checkedAt && <span className="source-label">Last checked {shortDate(profile.checkedAt)} at {time(profile.checkedAt)}</span>}</div>

    <div className="nessie-profile-layout">
      <section aria-labelledby="nessie-verification-title"><h3 id="nessie-verification-title" className="nessie-section-title">Customer/account verification</h3><div className="nessie-verification-list"><VerificationRow label="RentEscrow tenant and case" verified={profile?.binding.tenantId === record.ownerId && profile?.binding.caseId === record.id} fresh={fresh} unavailable={unavailable} /><VerificationRow label="Customer exists" verified={!!profile?.customerVerified} fresh={fresh} unavailable={unavailable} /><VerificationRow label="Account exists" verified={!!profile?.accountVerified} fresh={fresh} unavailable={unavailable} /><VerificationRow label="Account belongs to customer" verified={!!profile?.ownershipVerified} fresh={fresh} unavailable={unavailable} /><VerificationRow label="Balance available" verified={profile?.accountBalanceCents !== undefined} fresh={fresh} unavailable={unavailable} /></div><p className="nessie-context-note">{requestFailed ? "The financial refresh could not complete. Retry to verify current banking data." : profile?.detail || (liveRequested ? "Loading the configured account through the server. Demo data is not used for this live check." : "No financial profile is loaded for this case.")}</p>{stale && <p className="nessie-context-note amber">The last verification has expired. Payment authorization requires a fresh server check.</p>}{profile?.reasonCode && <code className="nessie-reason-code">{profile.reasonCode}</code>}<p className="nessie-context-note">Sandbox customer/account verification. Not identity verification or real KYC.</p></section>
      <section aria-labelledby="nessie-binding-title"><h3 id="nessie-binding-title" className="nessie-section-title">Authoritative case binding</h3>{profile ? <dl className="nessie-binding"><div><dt>RentEscrow tenant</dt><dd>{profile.binding.tenantId}</dd></div><div><dt>Case</dt><dd>{profile.binding.caseId}</dd></div><div><dt>Nessie customer</dt><dd>{profile.binding.customerId || "Not configured"}</dd></div><div><dt>Nessie account</dt><dd>{profile.binding.accountId || "Not configured"}</dd></div></dl> : <div className="nessie-unloaded"><ShieldCheck size={21} /><p>Binding identifiers will appear after the server loads the financial profile.</p></div>}</section>
    </div>

    <div className="finance-metrics nessie-metrics"><div><span><Landmark size={17} />Bank account balance</span><strong data-testid="nessie-bank-balance">{bankBalance === undefined ? "Unavailable" : money(bankBalance)}</strong><small>{bankBalance === undefined ? "No verified balance returned" : !fresh ? "Stale snapshot, not current authorization" : `${source} balance`}</small>{fresh && bankBalance !== undefined && <span className={`text-status ${bankSufficient ? "green" : "red"}`}>{bankSufficient ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}{bankSufficient ? "Sufficient" : "Insufficient"} for {money(record.escrow.amountCents)}</span>}</div><div><span><Wallet size={17} />Simulated escrow balance</span><strong data-testid="simulation-balance">{money(record.accountBalanceCents)}</strong><small>Separate local USD ledger</small><span className="source-label">{money(record.escrow.status === "unfunded" ? 0 : record.escrow.amountCents)} {record.escrow.status === "released" ? "released from escrow" : "held in escrow"}</span></div><div><span><FileText size={17} />Confirmed issue impact</span><strong data-testid="confirmed-issue-impact">{money(expenseTotal)}</strong><small>{record.expenses.length} recorded costs</small><span className="source-label">{suggested.length} suggested {suggested.length === 1 ? "cost excluded" : "costs excluded"}</span></div></div>

    <section className="section-separated nessie-security" aria-labelledby="nessie-security-title">
      <div className="nessie-security-heading"><ShieldCheck size={21} /><div><h3 id="nessie-security-title">Payment authorization guardrail</h3><p>Trusted tenant, case, customer, and account binding</p></div><span className="subtle-badge">Dry run</span></div>
      <div className="nessie-security-content"><div className="nessie-attack-preview"><span className="eyebrow"><FlaskConical size={13} />SUBSTITUTION ATTEMPT</span><dl><div><dt>Injected customer</dt><dd>customer_attacker</dd></div><div><dt>Injected account</dt><dd>account_bad</dd></div></dl><p className="nessie-context-note">Untrusted instructions cannot replace the case&apos;s stored banking identifiers.</p></div><div className="nessie-security-actions"><Button icon={ShieldCheck} disabled={busy || resolved} onClick={() => { void onAction({ action: "check_financial_binding", scenario: "valid" }); }}>Check financial binding</Button><Button icon={ShieldX} disabled={busy || resolved} onClick={() => { void onAction({ action: "check_financial_binding", scenario: "substitution" }); }}>Test account substitution</Button><span className="source-label">No settlement action is initiated by either check.</span></div></div>
      {policy && <div className={`nessie-authorization-result ${policy.approved ? "nessie-authorization-approved" : "nessie-authorization-blocked"}`} role="status" aria-live="polite" data-testid="nessie-policy-result"><div>{policy.approved ? <ShieldCheck size={23} /> : <ShieldX size={23} />}<div><h3>{policy.approved ? "Financial binding verified" : "Payment authorization blocked"}</h3><p>{policy.approved ? `The financial binding matches Case ${record.id}. Other settlement requirements still apply.` : mismatch ? `Customer/account binding does not match Case ${record.id}.` : "The server rejected this financial authorization check."}</p><strong>No settlement action initiated.</strong></div></div>{policy.reasonCodes?.length ? <div className="nessie-reason-codes">{policy.reasonCodes.map((code) => <code key={code}>{code}</code>)}</div> : null}<ul>{policy.checks.map((check) => <li key={check.key}>{check.passed ? <CheckCircle2 size={14} /> : <ShieldX size={14} />}<div><strong>{check.label}</strong><span>{check.detail}</span></div></li>)}</ul></div>}
    </section>

    <section className="section-separated"><SectionHeading title="Rent-payment history"><span className="subtle-badge">{profile && !fresh ? "Historical snapshot" : liveRequested ? "Nessie API (sandbox)" : "Demo fixture"}</span></SectionHeading>{profile && !fresh && <p className="nessie-context-note nessie-history-warning">{unavailable ? "Current banking context is unavailable. Previously recorded payments are shown below." : "Verification is not current. These payment records are a historical snapshot."}</p>}{rentHistory.length ? <div className="table-scroll"><table><thead><tr><th scope="col">Period</th><th scope="col">Payment</th><th scope="col">Source</th><th scope="col" className="align-right">Amount</th></tr></thead><tbody>{rentHistory.map((payment) => <tr key={payment.id}><td><span className="table-icon"><CalendarDays size={15} />{payment.month}</span></td><td><span className={`text-status ${payment.status === "paid" ? "green" : "amber"}`}>{payment.status === "paid" ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}{payment.status === "paid" ? "Paid" : "Due"}</span></td><td className="muted">{payment.source === "demo" ? "Demo fixture" : "Nessie API"}</td><td className="align-right strong">{money(payment.amountCents)}</td></tr>)}</tbody></table></div> : <EmptyState icon={Landmark} title="No rent-payment records">{unavailable ? "The banking provider is unavailable." : "No rent-payment history has been loaded for this case."}</EmptyState>}</section>

    <section className="section-separated" aria-label="Account transactions">
      <SectionHeading title="Account transactions"><span className="subtle-badge">{transactions.length} transactions</span></SectionHeading>
      <div className="nessie-transaction-toolbar">
        <div className="segmented-control" aria-label="Filter transactions">{(["all", "suggested", "confirmed", "dismissed"] as const).map((value) => <button key={value} className={filter === value ? "selected" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? "All" : value === "suggested" ? "Needs review" : value === "confirmed" ? "Confirmed" : "Dismissed"}</button>)}</div>
        <span className="source-label">Unconfirmed suggestions are excluded from issue impact.</span>
      </div>
      {profile && !fresh && transactions.length > 0 && <p className="nessie-context-note nessie-history-warning">Historical transactions. Refresh the financial profile before confirming additional costs.</p>}
      {visibleTransactions.length ? <ul className="nessie-transactions">{visibleTransactions.map((transaction) => <li key={transaction.id}>
        <span className="nessie-transaction-icon"><FileText size={18} /></span>
        <div className="nessie-transaction-copy">
          <strong>{transaction.label}</strong>
          <span>{shortDate(transaction.date)} &middot; {transaction.source === "demo" ? "Demo fixture" : "Nessie API"} &middot; {transaction.category}</span>
          {transaction.providerStatus && <div className="nessie-transaction-warning">
            <strong><AlertCircle size={14} />{transaction.providerStatus === "missing" ? "Archived: no longer returned by provider" : "Provider transaction changed"}</strong>
            <p>{transaction.reviewNote || "The original tenant-confirmed expense remains in the case record."}</p>
          </div>}
          {transaction.relatedStatus === "suggested" && <p>{transaction.suggestionReason || "Possibly related to the housing issue. Awaiting tenant confirmation."}</p>}
          <span className={`text-status ${transaction.relatedStatus === "confirmed" ? "green" : transaction.relatedStatus === "suggested" ? "amber" : "muted"}`}>
            {transaction.relatedStatus === "confirmed" ? <CheckCircle2 size={13} /> : transaction.relatedStatus === "dismissed" ? <X size={13} /> : <Clock3 size={13} />}
            {transaction.relatedStatus === "confirmed" ? "Confirmed by tenant" : transaction.relatedStatus === "dismissed" ? "Dismissed from issue impact" : "Possibly related, not confirmed"}
          </span>
        </div>
        <div className="nessie-transaction-amount"><strong>{money(transaction.amountCents)}</strong>{transaction.providerStatus && <small>{transaction.providerStatus === "missing" ? "Last recorded amount" : "Current provider amount"}</small>}{transaction.confirmedAmountCents !== undefined && <small>{money(transaction.confirmedAmountCents)} remains in issue impact</small>}</div>
        {transaction.relatedStatus === "suggested" && <div className="nessie-transaction-actions">
          <Button icon={Check} aria-label={`Confirm ${transaction.label} as issue-related`} disabled={busy || resolved || !fresh || transaction.providerStatus === "missing"} onClick={() => { void onAction({ action: "confirm_transaction", transactionId: transaction.id }); }}>Confirm</Button>
          <Button variant="ghost" icon={X} aria-label={`Dismiss ${transaction.label}`} disabled={busy || resolved || !fresh || transaction.providerStatus === "missing"} onClick={() => { void onAction({ action: "dismiss_transaction", transactionId: transaction.id }); }}>Dismiss</Button>
        </div>}
      </li>)}</ul> : <EmptyState icon={FileText} title={filter === "all" ? "No account transactions" : "No matching transactions"}>{profile ? "There are no transactions in this view." : "Load the financial profile to retrieve account transactions."}</EmptyState>}
    </section>

    <section className="section-separated"><SectionHeading title="Confirmed issue-related costs"><Button icon={Plus} onClick={onExpense} disabled={busy || resolved}>Add expense</Button></SectionHeading>{record.expenses.length ? <div className="table-scroll"><table><thead><tr><th scope="col">Expense</th><th scope="col">Category</th><th scope="col">Date</th><th scope="col" className="align-right">Amount</th></tr></thead><tbody>{record.expenses.map((expense) => <tr key={expense.id}><td><span className="table-icon"><FileText size={15} />{expense.label}</span><span className="table-subtitle">{expense.transactionId ? "Tenant-confirmed transaction" : expense.source === "demo" ? "Sample recorded expense" : expense.source === "manual" ? "Added by you" : "Recorded Nessie expense"}</span></td><td className="capitalize">{expense.category}</td><td className="muted">{shortDate(expense.date)}</td><td className="align-right strong">{money(expense.amountCents)}</td></tr>)}</tbody><tfoot><tr><td colSpan={3}>Total issue impact</td><td className="align-right">{money(expenseTotal)}</td></tr></tfoot></table></div> : <EmptyState icon={FileText} title="No confirmed issue costs">No bank suggestions have been included in the case total.</EmptyState>}</section>
  </section>;
}
