import type { CaseRecord, PolicyResult } from "@/lib/types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly persistAudit = false,
    public readonly code?: string,
    public readonly policy?: PolicyResult,
    public readonly caseRecord?: CaseRecord,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
