# tentree Supply Chain Portal — Agent Context

## Project Layout

```
backend/          Express API, JSON data files, services (ciParser, etc.)
frontend/tentree-scportal/   Next.js RSC app (shadcn/ui, Tailwind)
```

## Tech Stack

- **Frontend:** Next.js (RSC pattern), shadcn/ui, Tailwind CSS, TypeScript
- **Backend:** Express, JSON file storage (temporary — AWS Aurora PostgreSQL is the target)
- **CI parsing:** `backend/services/ciParser.js` (xlsx library)

## Navigation Architecture (route-based, not tab-based)

Bookings and Shipments use **nested route layouts**, not client-side tabs.

```
/bookings                → redirects to /bookings/pending
/bookings/pending        → RSC fetches pending POs → BookingsClient tab="pending"
/bookings/active         → RSC fetches active bookings → BookingsClient tab="list"
/bookings/history        → RSC fetches history bookings → BookingsClient tab="history"
/bookings/submit         → RSC reads ?po= param, fetches PO → BookingsClient tab="submit"

/shipments               → redirects to /shipments/mainline
/shipments/mainline      → RSC merges shipments+POs → ShipmentsClient activeTab="mainline"
/shipments/sms           → RSC merges shipments+POs → ShipmentsClient activeTab="sms"
/shipments/history       → no RSC fetch (lazy in client) → ShipmentsClient activeTab="history"
```

Key files:
- `src/app/bookings/layout.tsx` — wraps all /bookings/* with BookingsSubNav header
- `src/app/bookings/BookingsSubNav.tsx` — client sub-nav with active link highlighting
- `src/app/bookings/BookingsClient.tsx` — renders one section based on `tab` prop, uses `useRouter` for cross-route nav
- `src/app/shipments/layout.tsx` — wraps all /shipments/* with ShipmentsSubNav header
- `src/app/shipments/ShipmentsSubNav.tsx` — client sub-nav
- `src/app/shipments/ShipmentsClient.tsx` — accepts `activeTab` prop, renders content conditionally (no Tabs component)
- `src/app/shipments/mergeShipments.ts` — shared PO+shipment merge helper used by mainline and sms pages

Cross-route interactions:
- "Book Now" in pending → confirm dialog → `router.push('/bookings/submit?po=PO-001')`
- Booking submit success → `router.push('/bookings/active')` after 1.5s
- Booking deep-link from shipments table → `/bookings/active?bkg=BKG-001`
- Sidebar active state: Bookings matches any `/bookings/*`, Shipments matches any `/shipments/*` via `matchPrefix`

## Backend Validation Layer (Joi — MVC standard)

All routes validated with `backend/middleware/validate.js` factory:
- `backend/validators/booking.js` — create (vendor_name, po_details required), update (partial)
- `backend/validators/shipment.js` — create, update, bulkStatus
- `backend/validators/purchaseOrder.js` — create, replaceLineItems, update, updateLineItem
- `backend/validators/masterData.js` — masterDataArray (protects all PUT /master-data/*)
- `backend/validators/eomTask.js` — bulkCreate, update
- Business guards (vendor-match G1, overbooking G2) stay in controllers; shape/type validation lives in route middleware

## Master Data — Form Dropdowns

All form dropdowns (BookingForm, ShipmentForm, SmsShipmentForm, PoDetailDrawer) are wired to backend master data via `src/app/actions/master-data.ts`. Always use `Array.isArray(data) ? data : []` guard after fetching — `fetchApi` returns `{ error: '...' }` on failure, not `[]`.

Master data endpoints: `/master-data/warehouses`, `/master-data/modes`, `/master-data/suppliers`, `/master-data/couriers`, `/master-data/incoterms`, `/master-data/statuses`

Settings pages at `/settings/*` are the admin UI for these master data lists.

## Implementation Plan

Full plan: `frontend/tentree-scportal/SKU_EXPANSION_PLAN.md`

Build order (JSON stack phase — current priority):

1. **line_items on POs** — `line_items[]` array on POs, CRUD routes, LineItemsTable in PoDetailDrawer
2. **CI parser service** — already exists at `backend/services/ciParser.js`
3. **CI upload flow on Booking** — upload, parse preview, vendor confirm → `booking.commercial_invoice`
4. **Fulfillment view** — computed: expected vs shipped per SKU via `/purchase-orders/:id/fulfillment`

**Do not build:** warehouse receiving, S3, PostgreSQL, multi-currency — deferred.

## Current State (as of 2026-05-10)

### Already implemented
- `backend/services/ciParser.js` ✅
- `POST /commercial-invoices/parse` route ✅
- `frontend/.../LineItemsTable.tsx` ✅ (check if wired into PoDetailDrawer)
- `frontend/.../CiPreviewTable.tsx` ✅
- `frontend/.../CiUploadSection.tsx` ✅
- Joi validation layer on all routes ✅
- All form dropdowns wired to backend master data ✅
- Route-based navigation for Bookings and Shipments ✅

### Still needed
- `POST /purchase-orders/:id/line-items` — replace all line items
- `PUT /purchase-orders/:id/line-items/:sku` — update single SKU
- `GET /purchase-orders/:id/fulfillment` — computed shipped vs remaining
- `POST /bookings/:id/commercial-invoice/confirm` — vendor confirms CI
- `GET /bookings/:id/commercial-invoice` — admin review
- Wire LineItemsTable into PoDetailDrawer (collapsible section)
- Add Fulfillment tab to PoDetailDrawer
- CI review section in BookingDetailDrawer (admin only)

## Key Design Rule

**Never store derived quantities.** `shipped_qty` and `remaining_qty` are always computed:

```
remaining_qty = PO.line_items[sku].expected_qty
              − SUM(confirmed bookings → ci.line_items where sku_code matches)
```

## Agent File Ownership

| Agent    | Owns                                          | Never touches |
|----------|-----------------------------------------------|---------------|
| frontend | `frontend/tentree-scportal/src/`              | `backend/`    |
| backend  | `backend/server.js`, `backend/services/`, `backend/data/` | `frontend/` |
| qa       | Read-only — no writes                         | —             |
