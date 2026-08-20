# API Inventory — BASS Extension

> **How to update this file**: open Box Office in Chrome, open DevTools → Network → filter XHR/Fetch,
> perform each action, capture the request details below. Do not guess endpoints.

---

## Authentication

**Mechanism**: Existing Box Office browser session (cookies).
The extension uses `credentials: 'include'` on all requests. Chrome automatically attaches
the session cookies for `box-office.headout.com` — no token extraction or storage required.

**Required headers** (observed):
- `x-platform: lego`

**Status codes**:
- `200` → authenticated
- `401` → not logged in → show "Please log into Box Office"
- `403` → session expired → show "Your session has expired"
- `404` → authenticated but resource not found (normal)

---

## Phase 1 — Read-only (implemented)

### Booking / Fulfilment

```
GET /proxy/aries/apis/v2/order-fulfillment/booking/{bookingId}

Purpose:      Retrieve booking and fulfilment information for a Booking ID.
Method:       GET
Auth:         Box Office browser session (cookies + x-platform: lego)
URL params:   bookingId — numeric booking ID
Response:     JSON — full booking + fulfilment + vendor + instruction object

Example:
  GET https://box-office.headout.com/proxy/aries/apis/v2/order-fulfillment/booking/33418414

Known response fields (partial — update after inspecting real responses):
  bookingId
  status
  fulfilmentType
  fulfilmentStatus
  productName
  variantName
  inventoryDate
  inventoryTime
  ticketType
  totalPax
  netPrice
  currency
  guestName
  guestEmail
  vendorsInfo[]
    .vendorId
    .vendorName
    .tourId
    .bookingInstructions
```

---

## Phase 2 — To be discovered

> For each action below: open Box Office, perform the action, capture the network request,
> fill in the template, then implement in the extension.

### Fulfilment actions

```
METHOD  /proxy/aries/...
Purpose:
Auth:
Request body:
Response:
```

### Tickets

```
METHOD  /proxy/aries/...
Purpose:
Auth:
Response:
```

### Vendors / Supply Partners

```
METHOD  /proxy/aries/...
Purpose:
Auth:
Response:
```

### Cancellation / Reschedule

```
METHOD  /proxy/aries/...
Purpose:
Auth:
Request body:
Response:
```

### Sibling bookings

```
METHOD  /proxy/aries/...
Purpose:
Auth:
Response:
```

---

## API Dependency Map

### Read booking (Phase 1)

```
User enters Booking ID
       ↓
GET /proxy/aries/apis/v2/order-fulfillment/booking/{id}
       ↓
Display: status, fulfilment, vendor, instructions, tickets
```

### Fulfil booking (Phase 2 — TBD)

```
User clicks "Fulfil"
       ↓
GET booking   (confirm current state)
       ↓
GET vendor    (confirm vendor / instructions)
       ↓
POST fulfilment action
       ↓
GET updated booking   (confirm new state)
```

---

## Security Notes

- Session cookies are **never extracted, stored, or logged**.
- The browser retains ownership of the authenticated session.
- The extension only reads the response — it does not relay cookies to any third-party service.
- All requests stay authenticated as the currently logged-in Box Office user.
- `chrome.cookies` API is **not used** in Phase 1.
