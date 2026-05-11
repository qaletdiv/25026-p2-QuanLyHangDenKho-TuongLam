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

## Implementation Plan

Full plan: `frontend/tentree-scportal/SKU_EXPANSION_PLAN.md`

Build order (JSON stack phase — current priority):

1. **line_items on POs** — `line_items[]` array on POs, CRUD routes, LineItemsTable in PoDetailDrawer
2. **CI parser service** — already exists at `backend/services/ciParser.js`
3. **CI upload flow on Booking** — upload, parse preview, vendor confirm → `booking.commercial_invoice`
4. **Fulfillment view** — computed: expected vs shipped per SKU via `/purchase-orders/:id/fulfillment`

**Do not build:** warehouse receiving, S3, PostgreSQL, multi-currency — deferred.

## Current State (as of 2026-05-09)

### Already implemented
- `backend/services/ciParser.js` ✅
- `POST /commercial-invoices/parse` route ✅
- `frontend/.../LineItemsTable.tsx` ✅ (check if wired into PoDetailDrawer)
- `frontend/.../CiPreviewTable.tsx` ✅
- `frontend/.../CiUploadSection.tsx` ✅

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
