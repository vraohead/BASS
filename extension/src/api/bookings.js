import { bmsRequest } from '../utils/request.js';
import { ENDPOINTS } from './bms.js';

export async function fetchBooking(bookingId) {
  const id = String(bookingId || '').trim();
  if (!id || !/^\d+$/.test(id)) {
    throw new Error('Booking ID must be numeric.');
  }
  return bmsRequest(ENDPOINTS.booking(id));
}
