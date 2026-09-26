import { it, expect } from 'vitest';
import { parseOAuthCallback } from '../src/publish/oauth.js';

const EXPECTED_STATE = 'abc123';

it('accepts a redirect whose state matches and carries a code', () => {
  const params = new URLSearchParams({ state: EXPECTED_STATE, code: 'auth-code-1' });
  expect(parseOAuthCallback(params, EXPECTED_STATE)).toEqual({ ok: true, code: 'auth-code-1' });
});

it('flags a state mismatch as keepWaiting (not our redirect) instead of failing the flow', () => {
  const params = new URLSearchParams({ state: 'someone-elses-state', code: 'auth-code-1' });
  const result = parseOAuthCallback(params, EXPECTED_STATE);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.keepWaiting).toBe(true);
    expect(result.reason).toMatch(/state mismatch/i);
  }
});

it('treats a missing state param the same as a mismatch (keeps waiting)', () => {
  const params = new URLSearchParams({ code: 'auth-code-1' });
  const result = parseOAuthCallback(params, EXPECTED_STATE);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.keepWaiting).toBe(true);
});

it('ends the flow (does not keep waiting) when state matches but the user declined consent', () => {
  const params = new URLSearchParams({ state: EXPECTED_STATE, error: 'access_denied' });
  const result = parseOAuthCallback(params, EXPECTED_STATE);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.keepWaiting).toBe(false);
    expect(result.reason).toMatch(/access_denied/);
  }
});

it('ends the flow when state matches but no code is present', () => {
  const params = new URLSearchParams({ state: EXPECTED_STATE });
  const result = parseOAuthCallback(params, EXPECTED_STATE);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.keepWaiting).toBe(false);
    expect(result.reason).toMatch(/no authorization code/i);
  }
});
