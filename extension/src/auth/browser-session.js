import { bmsRequest, AuthError } from '../utils/request.js';
import { ENDPOINTS } from '../api/bms.js';

export const AuthStatus = {
  AUTHENTICATED:     'AUTHENTICATED',
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  SESSION_EXPIRED:   'SESSION_EXPIRED',
  REQUEST_BLOCKED:   'REQUEST_BLOCKED',
  UNKNOWN:           'UNKNOWN',
};

// Test whether the Box Office session is active by requesting a known-safe
// booking endpoint with a dummy ID. BMS responses:
//   200/404  → authenticated (404 just means that booking ID doesn't exist)
//   401      → not logged in
//   403      → session expired / insufficient permissions
//   network  → extension cannot reach box-office.headout.com (CORS or offline)
export async function testAuthentication() {
  try {
    await bmsRequest(ENDPOINTS.booking('00000000'));
    return AuthStatus.AUTHENTICATED;
  } catch (err) {
    if (err instanceof AuthError) {
      return err.status === 401
        ? AuthStatus.NOT_AUTHENTICATED
        : AuthStatus.SESSION_EXPIRED;
    }
    // 404 from ApiError means authenticated but booking not found — that's fine
    if (err.status === 404) return AuthStatus.AUTHENTICATED;
    if (err.status === 0)   return AuthStatus.REQUEST_BLOCKED;
    return AuthStatus.UNKNOWN;
  }
}
