export class RuntimeHttpError extends Error {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;

  constructor(statusCode: number, payload: Record<string, unknown>) {
    super(typeof payload.message === 'string' ? payload.message : String(payload.error ?? 'Runtime error'));
    this.name = 'RuntimeHttpError';
    this.statusCode = statusCode;
    this.payload = payload;
  }
}
