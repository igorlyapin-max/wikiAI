import { describe, expect, it } from 'vitest';
import { RuntimeHttpError } from '../runtime-errors.js';

describe('RuntimeHttpError', () => {
  it('uses payload.message as the Error message when available', () => {
    const err = new RuntimeHttpError(401, {
      error: 'Invalid Bearer token',
      message: 'OIDC token is expired',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RuntimeHttpError');
    expect(err.message).toBe('OIDC token is expired');
    expect(err.statusCode).toBe(401);
    expect(err.payload).toEqual({
      error: 'Invalid Bearer token',
      message: 'OIDC token is expired',
    });
  });

  it('falls back to payload.error when message is missing', () => {
    expect(new RuntimeHttpError(403, { error: 'External API disabled' }).message).toBe('External API disabled');
    expect(new RuntimeHttpError(500, {}).message).toBe('Runtime error');
  });
});
