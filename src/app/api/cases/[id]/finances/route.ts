import type { NextRequest } from "next/server";
import { getSession, handleError, respond } from "@/lib/server/http";
import { findCase } from "@/lib/server/store";
import { requireCaseAccess } from "@/lib/server/case-access";
import { getTrustedFinancialVerification } from "@/lib/server/nessie-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession(request);
    const { id } = await context.params;
    const record = findCase(session.document, id);
    requireCaseAccess(session.user, record);
    return respond({ accountBalanceCents: record.accountBalanceCents, financialProfile: record.financialProfile,
      verification: getTrustedFinancialVerification(record),
      expenses: record.expenses, rentHistory: record.rentHistory });
  } catch (error) { return handleError(error); }
}
