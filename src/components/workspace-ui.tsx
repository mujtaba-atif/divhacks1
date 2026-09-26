"use client";

import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, Circle, LoaderCircle, X, type LucideIcon } from "lucide-react";
import type { CaseStatus } from "@/lib/types";

export const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
export const fullDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
export const shortDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const time = (value: string) => new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export function StatusBadge({ status }: { status: CaseStatus }) {
  const labels: Record<CaseStatus, string> = { open: "Open case", awaiting_repair: "Awaiting repair", verification: "Under review", verified: "Repair verified", resolved: "Resolved" };
  return <span className={`status-badge status-${status}`}><span />{labels[status]}</span>;
}

export function Button({ children, icon: Icon, variant = "secondary", busy = false, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; variant?: "primary" | "secondary" | "ghost" | "danger"; busy?: boolean }) {
  return <button {...props} type={props.type ?? "button"} className={`button button-${variant} ${className}`} disabled={props.disabled || busy}>{busy ? <LoaderCircle size={16} className="spin" /> : Icon ? <Icon size={16} /> : null}{children}</button>;
}

export function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { dialog?.close(); document.body.style.overflow = oldOverflow; };
  }, []);
  return <dialog ref={ref} aria-labelledby={id} className={`modal ${wide ? "modal-wide" : ""}`} onCancel={(event) => { event.preventDefault(); closeRef.current(); }} onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div className="modal-inner">
      <header className="modal-header"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog" title="Close"><X size={20} /></button></header>
      {children}
    </div>
  </dialog>;
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={24} /></div><h3>{title}</h3><p>{children}</p>{action}</div>;
}

export function CheckRow({ done, title, detail, current = false }: { done: boolean; title: string; detail?: string; current?: boolean }) {
  return <li className={`check-row ${done ? "is-done" : ""} ${current ? "is-current" : ""}`}><span className="check-circle">{done ? <Check size={13} strokeWidth={3} /> : <Circle size={7} fill="currentColor" />}</span><div><span>{title}</span>{detail && <p>{detail}</p>}</div></li>;
}

export function SectionHeading({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return <div className="section-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{children}</div>;
}
