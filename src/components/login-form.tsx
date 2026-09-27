"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowRight, Building2, Eye, EyeOff, House, LoaderCircle } from "lucide-react";
import { announceSessionChange } from "./use-session-guard";
import { Modal } from "./workspace-ui";
import "./landing.css";

type Role = "tenant" | "landlord";
type DemoAccount = { label: string; email: string; password: string; role: Role };
const demoAccounts: DemoAccount[] = [
  { label: "Tenant 1", email: "tenant1@rentescrow.demo", password: "TenantDemo123!", role: "tenant" },
  { label: "Tenant 2", email: "tenant2@rentescrow.demo", password: "TenantDemo123!", role: "tenant" },
  { label: "Property manager", email: "landlord@rentescrow.demo", password: "LandlordDemo123!", role: "landlord" },
];
const benefits = [
  { icon: "folder-check", title: "Organized evidence", description: "Photos, docs, and records in one library" },
  { icon: "message", title: "Clear communication", description: "Draft and retain focused messages" },
  { icon: "shield", title: "Controlled financial steps", description: "Review and authorize each eligible transfer" },
];

export default function LoginForm({ initialRole = "tenant" }: { initialRole?: Role }) {
  const [role, setRole] = useState<Role>(initialRole);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [passwordHelp, setPasswordHelp] = useState(false);

  function useDemo(account: DemoAccount) {
    setRole(account.role);
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
        body: JSON.stringify({ email: email.trim(), password, expectedRole: role }),
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
    } finally { setBusy(false); }
  }

  return <main className="figma-landing">
    <a className="skip-link" href="#sign-in">Skip to sign in</a>
    <section className="landing-story" aria-labelledby="landing-heading">
      <Link className="landing-brand" href="/" aria-label="RentEscrow home">
        <Image src="/figma/door-brand.png" width={40} height={40} alt="" />
        <span>RentEscrow</span>
      </Link>
      <div className="landing-copy">
        <h1 id="landing-heading">Build your case and protect disputed rent with Escrow</h1>
        <p>Organize evidence, communicate clearly, and keep every financial step under your control</p>
      </div>
      <ul className="landing-benefits" aria-label="Workspace benefits">
        {benefits.map((benefit) => <li key={benefit.icon}>
          <Image src={`/figma/${benefit.icon}.svg`} width={18} height={18} alt="" />
          <strong>{benefit.title}</strong><p>{benefit.description}</p>
        </li>)}
      </ul>
      <p className="landing-footnote">RentEscrow provides organization and payment tools - not legal advice</p>
    </section>
    <section className="landing-auth" aria-labelledby="sign-in-heading">
      <Image className="landing-skyline" src="/figma/nyc-skyline.png" fill sizes="(max-width: 800px) 100vw, 55vw" preload alt="" />
      <div className="landing-auth-content" id="sign-in" tabIndex={-1}>
        <header className="landing-auth-heading">
          <h2 id="sign-in-heading">Welcome back</h2><p>Sign in to your RentEscrow workspace</p>
        </header>
        <form className="landing-auth-card" onSubmit={submit} aria-label="Sign in" aria-busy={busy}>
          <fieldset className="landing-role-picker" disabled={busy}>
            <legend>Sign in as</legend>
            <div className="landing-role-options">
              {(["tenant", "landlord"] as const).map((option) => <label key={option}>
                <input type="radio" name="role" value={option} checked={role === option} onChange={() => { setRole(option); setError(""); }} />
                <span>{option === "tenant" ? <House size={16} /> : <Building2 size={16} />}{option === "tenant" ? "Tenant" : "Landlord"}</span>
              </label>)}
            </div>
          </fieldset>
          <div className="landing-field">
            <label htmlFor="login-email">Email address</label>
            <input id="login-email" name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" required maxLength={320} disabled={busy} />
          </div>
          <div className="landing-field">
            <div className="landing-field-label">
              <label htmlFor="login-password">Password</label>
              <button type="button" className="landing-forgot" onClick={() => setPasswordHelp(true)}>Forgot password</button>
            </div>
            <div className="landing-password">
              <input id="login-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required maxLength={256} disabled={busy} />
              <button type="button" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} disabled={busy}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </div>
          </div>
          {error && <p className="landing-error" role="alert">{error}</p>}
          <button className="landing-submit" type="submit" disabled={busy}>{busy && <LoaderCircle className="spin" size={17} />}{busy ? "Signing in…" : `Sign in as ${role === "tenant" ? "Tenant" : "Landlord"}`}</button>
          <p className="landing-security"><Image src="/figma/lock.svg" width={10} height={10} alt="" />Your account. Your private workspace.</p>
        </form>
        <details className="landing-demos">
          <summary>Try a demo account</summary>
          <div className="landing-demo-list">
            {demoAccounts.filter((account) => account.role === role).map((account) => <button type="button" key={account.email} onClick={() => useDemo(account)} disabled={busy}>
              <span><strong>{account.label}</strong><small>{account.email}</small></span><ArrowRight size={16} />
            </button>)}
          </div>
          <p>Choose an account to fill the form, then sign in.</p>
        </details>
      </div>
    </section>
    {passwordHelp && <Modal title="Need help signing in?" onClose={() => setPasswordHelp(false)}>
      <div className="landing-password-help">
        <p>Contact the person who set up your RentEscrow account to restore access. Password reset by email is not available yet.</p>
        <p>Exploring the app? Close this window and choose <strong>Try a demo account</strong> below the sign-in form.</p>
        <button type="button" className="landing-submit" onClick={() => setPasswordHelp(false)}>Back to sign in</button>
      </div>
    </Modal>}
  </main>;
}
