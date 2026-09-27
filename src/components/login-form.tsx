"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, Building2, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { announceSessionChange } from "./use-session-guard";

type DemoAccount = {
  label: string;
  description: string;
  email: string;
  password: string;
  initials: string;
};

const demoAccounts: DemoAccount[] = [
  { label: "Tenant 1", description: "Rayaan · +1 (***) ***-0558", email: "tenant1@rentescrow.demo", password: "TenantDemo123!", initials: "RA" },
  { label: "Tenant 2", description: "Jordan Lee · Separate workspace", email: "tenant2@rentescrow.demo", password: "TenantDemo123!", initials: "JL" },
  { label: "Property manager", description: "Alex Morgan · +1 (***) ***-7033", email: "landlord@rentescrow.demo", password: "LandlordDemo123!", initials: "AM" },
];

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function useDemo(account: DemoAccount) {
    setEmail(account.email);
    setPassword(account.password);
    setError("");
    document.getElementById("login-email")?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const result = await response.json().catch(() => null) as { redirectTo?: unknown; error?: unknown } | null;
      if (!response.ok) {
        setError(typeof result?.error === "string" ? result.error : "Invalid email or password.");
        return;
      }
      announceSessionChange();
      window.location.assign(result?.redirectTo === "/landlord" ? "/landlord" : "/tenant");
    } catch {
      setError("Sign in is temporarily unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-page">
    <section className="login-story" aria-labelledby="login-heading">
      <a className="login-brand" href="/" aria-label="RentEscrow NYC home">
        <span className="brand-mark"><Building2 size={23} /><span /></span>
        <span>RentEscrow<small>NYC</small></span>
      </a>
      <div className="login-story-copy">
        <span className="login-kicker"><ShieldCheck size={15} /> A clearer path through housing repairs</span>
        <h1 id="login-heading">Resolve housing issues with evidence, communication, and secure settlement.</h1>
        <p>Keep every repair update, document, and decision in one shared record while your private financial details remain private.</p>
      </div>
      <ul className="login-benefits" aria-label="Workspace benefits">
        <li><CheckCircle2 size={17} /><span><strong>Evidence-led cases</strong>Document conditions and repair progress.</span></li>
        <li><CheckCircle2 size={17} /><span><strong>One accountable timeline</strong>Keep tenants and property managers aligned.</span></li>
        <li><CheckCircle2 size={17} /><span><strong>Protected settlement</strong>Release decisions stay with the tenant workflow.</span></li>
      </ul>
      <p className="login-story-footnote">Built for New York City renters and property teams.</p>
    </section>

    <section className="login-panel" aria-label="Sign in">
      <div className="login-card">
        <div className="login-card-heading">
          <span className="login-lock"><KeyRound size={20} /></span>
          <div><span className="eyebrow">RENTESCROW NYC</span><h2>Welcome back</h2><p>Sign in to open your workspace.</p></div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="login-email">Email address</label>
          <input id="login-email" name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required disabled={busy} />
          <label htmlFor="login-password">Password</label>
          <div className="password-field">
            <input id="login-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required disabled={busy} />
            <button type="button" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} disabled={busy}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
          </div>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="login-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}{busy ? "Signing in…" : "Sign in"}</button>
        </form>

        <div className="demo-account-section">
          <div className="demo-account-heading"><span>Demo accounts</span><small>Choose one to prefill</small></div>
          <div className="demo-account-list">
            {demoAccounts.map((account) => <button type="button" key={account.email} className="demo-account" onClick={() => useDemo(account)} disabled={busy}>
              <span className="demo-account-avatar">{account.initials}</span>
              <span><strong>{account.label}</strong><small>{account.description}</small><code>{account.email}</code></span>
              <ArrowRight size={16} />
            </button>)}
          </div>
          <p className="demo-account-note">Choose an account to fill the form, then sign in.</p>
        </div>
      </div>
    </section>
  </main>;
}
