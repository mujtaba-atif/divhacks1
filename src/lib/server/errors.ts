export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly persistAudit = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
