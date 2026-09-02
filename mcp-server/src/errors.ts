export class AuthError extends Error {}

export class PostgrestApiError extends Error {
  code: string | null;
  details: string | null;
  hint: string | null;
  httpStatus: number;

  constructor(code: string | null, message: string, details: string | null, hint: string | null, httpStatus: number) {
    super(message);
    this.code = code;
    this.details = details;
    this.hint = hint;
    this.httpStatus = httpStatus;
  }
}

export function formatToolError(err: unknown): string {
  if (err instanceof PostgrestApiError) {
    const parts = [err.message];
    if (err.hint) parts.push(`Hint: ${err.hint}`);
    if (err.details) parts.push(`Details: ${err.details}`);
    return parts.join('\n');
  }
  if (err instanceof AuthError) {
    return `Authentication failed: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
