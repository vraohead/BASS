import { DEFAULT_HEADERS } from '../api/bms.js';

export class AuthError extends Error {
  constructor(status) {
    super(status === 401 ? 'Not authenticated' : 'Session expired');
    this.type   = status === 401 ? 'NOT_AUTHENTICATED' : 'SESSION_EXPIRED';
    this.status = status;
  }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(`BMS API error ${status}`);
    this.status = status;
    this.body   = body;
  }
}

// All BMS requests go through this wrapper.
// Uses credentials:'include' so Chrome sends the existing Box Office session
// cookies automatically — no token extraction or storage required.
export async function bmsRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      headers: {
        ...DEFAULT_HEADERS,
        ...(options.headers || {}),
      },
      ...options,
    });
  } catch (err) {
    throw new ApiError(0, err.message);
  }

  if (response.status === 401) throw new AuthError(401);
  if (response.status === 403) throw new AuthError(403);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(response.status, 'Non-JSON response');
  }

  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}
