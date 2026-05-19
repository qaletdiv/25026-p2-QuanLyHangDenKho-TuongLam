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
/bookings/active/[id]    → RSC fetches booking by id → BookingDetail (isHistory=false)
/bookings/history        → RSC fetches history bookings → BookingsClient tab="history"
/bookings/history/[id]   → RSC fetches booking by id → BookingDetail (isHistory=true)
/bookings/submit         → RSC reads ?po= param, fetches PO → BookingsClient tab="submit"

/shipments               → redirects to /shipments/mainline
/shipments/mainline      → RSC merges shipments+POs → ShipmentsClient activeTab="mainline"
/shipments/mainline/[id] → RSC fetches shipment by id → ShipmentDetail (mainline)
/shipments/sms           → RSC merges shipments+POs → ShipmentsClient activeTab="sms"
/shipments/sms/[id]      → RSC fetches shipment by id → SmsShipmentDetail
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

All form dropdowns (BookingForm, ShipmentForm, SmsShipmentForm, OrderDetail) are wired to backend master data via `src/app/actions/master-data.ts`. Always use `Array.isArray(data) ? data : []` guard after fetching — `fetchApi` returns `{ error: '...' }` on failure, not `[]`.

Master data endpoints: `/master-data/warehouses`, `/master-data/modes`, `/master-data/suppliers`, `/master-data/couriers`, `/master-data/incoterms`, `/master-data/statuses`

Settings pages at `/settings/*` are the admin UI for these master data lists.

## Implementation Plan

Full plan: `frontend/tentree-scportal/SKU_EXPANSION_PLAN.md`

Build order (JSON stack phase — current priority):

1. **line_items on POs** — `line_items[]` array on POs, CRUD routes, LineItemsTable in OrderDetail ✅
2. **CI parser service** — already exists at `backend/services/ciParser.js`
3. **CI upload flow on Booking** — upload, parse preview, vendor confirm → `booking.commercial_invoice`
4. **Fulfillment view** — computed: expected vs shipped per SKU via `/purchase-orders/:id/fulfillment`

**Do not build:** warehouse receiving, S3, PostgreSQL, multi-currency — deferred.

## Current State (as of 2026-05-19)

### Already implemented
- `backend/services/ciParser.js` ✅
- `POST /commercial-invoices/parse` route ✅ — saves original Excel to `backend/data/uploads/`, returns `file_url`
- `frontend/.../LineItemsTable.tsx` ✅ — wired into OrderDetail as collapsible section, shows 10 rows by default with expand/collapse ✅
- `frontend/.../CiPreviewTable.tsx` ✅
- `frontend/.../CiUploadSection.tsx` ✅ — stores `file_url` in confirmed CI object
- Joi validation layer on all routes ✅
- All form dropdowns wired to backend master data ✅
- Route-based navigation for Bookings and Shipments ✅
- User management — `/users` CRUD (Admin-only), `UserSettings.tsx`, `/settings/users` page ✅
- Role management — `/roles` CRUD, `RoleSettings.tsx` permission matrix, `/settings/roles` page ✅
- Login injects `permissions[]` into session; Sidebar filters nav dynamically via `can()` ✅
- Fulfillment endpoint `GET /purchase-orders/:id/fulfillment` ✅
- ShipmentsClient expandable row shows Expected/Shipped/Remaining from fulfillment endpoint ✅
- CI file persistence — Excel saved to `backend/data/uploads/`, download link in BookingDetailDrawer ✅
- CI view in BookingDetailDrawer — compact card + "View Line Items" button opens Dialog ✅
- NetSuite line items sync — `fetchNetSuiteLineItems()` pulls SKU-level rows from NS and attaches to POs on sync ✅
- Purchase Orders detail page — dedicated `/purchase-orders/[id]` route replacing the old drawer ✅
- Purchase Orders list — client-side pagination (10 per page) ✅
- PO IDs — sequential integers starting from 1 (not timestamps) ✅
- Bookings detail pages — dedicated `/bookings/active/[id]` and `/bookings/history/[id]` routes replacing `BookingDetailDrawer` ✅
- Bookings lists — client-side pagination (10 per page) on both active and history ✅
- Booking IDs — sequential integers across active + history (no timestamp IDs) ✅
- `GET /bookings/:id` backend route — looks up active + history, returns enriched booking ✅
- `src/types/booking.ts` — Booking, PODetail, CILineItem, CommercialInvoice types ✅
- `src/components/bookings/columns.ts` — typed COLUMNS and DEFAULT_VISIBLE_COLUMNS ✅
- loading.tsx + not-found.tsx for all booking sub-routes ✅
- Shipments detail pages — `/shipments/mainline/[id]` → ShipmentDetail, `/shipments/sms/[id]` → SmsShipmentDetail ✅
- ShipmentsClient row clicks navigate to detail pages (virtual `po-*` rows remain non-clickable) ✅
- Multi-PO group row navigates to booking detail `/bookings/active/[booking.id]` ✅
- Shipments list — client-side pagination (10 per page) ✅
- Shipment IDs — sequential integers (new creates use Math.max + 1) ✅
- `GET /shipments/:id` backend route — finds by id, enriches with PO data ✅
- `src/types/shipment.ts` — Shipment, ShipmentType, MainlineStatus, SmsStatus types ✅
- `src/components/shipments/columns.ts` — ALL_COLUMNS, NON_SORTABLE, DEFAULT_VISIBLE_COLUMNS ✅
- loading.tsx + not-found.tsx for mainline/[id] and sms/[id] sub-routes ✅
- loading.tsx for mainline/, sms/, and history/ list routes ✅

### Still needed
- Add `received_qty` column to fulfillment view (placeholder for NetSuite/3PL)
- Component-level permission checks (ShipmentDetail, SmsShipmentDetail, BookingDetail still use hardcoded role names — future refactor)

## Shipments Architecture

### Route structure
- `/shipments/mainline` — list of mainline shipments (merged PO+shipment rows)
- `/shipments/mainline/[id]` — full page for a real mainline shipment row
- `/shipments/sms` — list of SMS/courier shipments
- `/shipments/sms/[id]` — full page for a real SMS shipment row
- `/shipments/history` — lazy-loaded history (no RSC fetch)

### Key files
- `src/components/shipments/ShipmentDetail.tsx` — full-page mainline detail (adapted from old ShipmentDetailDrawer)
- `src/components/shipments/SmsShipmentDetail.tsx` — full-page SMS detail (adapted from old SmsDetailDrawer)
- `src/types/shipment.ts` — Shipment, ShipmentType, MainlineStatus, SmsStatus
- `src/components/shipments/columns.ts` — ALL_COLUMNS (18 columns), NON_SORTABLE set, DEFAULT_VISIBLE_COLUMNS

### Navigation rules
- Virtual rows (id starts with `po-`) are non-clickable — no detail page
- Single mainline row click → `router.push('/shipments/mainline/[id]')`
- SMS row click → `router.push('/shipments/sms/[id]')`
- Multi-PO group click → finds booking in `allBookings` by `booking_number` → `router.push('/bookings/active/[booking.id]')`
- History row type determines route: `type === 'sms'` → `/shipments/sms/[id]`, else → `/shipments/mainline/[id]`

### Backend — `GET /shipments/:id`

Searches both `ShipmentModel` (active, `shipments.json`) and `HistoryShipmentModel` (`history.json`) so a single route serves both active and history detail pages. Import: `const { history: HistoryShipmentModel } = require('../models/HistoryModel')` — HistoryModel exports `{ history, historyBookings }`.

### ID strategy
- New shipments: `Math.max(...existing ids) + 1` (stored as string)
- `shipments.json` starts empty; IDs will be sequential from 1
- `history.json` may still have old timestamp-based IDs — these route correctly since `getOne` searches both files

### Dead code (can be deleted when ready)
- `src/components/shipments/ShipmentDetailDrawer.tsx` — no longer used in ShipmentsClient
- `src/components/shipments/SmsDetailDrawer.tsx` — no longer used in ShipmentsClient

## CI File Persistence

When `POST /commercial-invoices/parse` is called:
1. Excel buffer saved to `backend/data/uploads/ci_<timestamp>_<filename>` via `driveStorage.uploadFile()`
2. `file_url: "/uploads/..."` included in parse response
3. `CiUploadSection.handleConfirm()` stores `file_url` in the CI object → saved to `booking.commercial_invoice.file_url`
4. `BookingDetailDrawer` shows compact CI card with "Download Excel" link + "View Line Items" button (opens Dialog)

In production (AWS): replace `driveStorage.uploadFile()` local path with S3 `putObject()` — `file_url` becomes the S3 public URL. The `express.static('/uploads')` middleware is local-only.

## Booking Data Shape

Bookings store the PO reference as `tentree_po_number` (not `po_number`). Key fields:
```json
{
  "tentree_po_number": "PO-FW26-001",
  "po_details": [{ "po_number": "PO-FW26-001", "units": 14400, "cartons": 390, "weight": 3560, "cbm": 44.5 }],
  "booking_number": "BKG-6021",
  "booking_status": "Booking Pending",
  "commercial_invoice": { "file_url": "/uploads/ci_*.xlsx", "status": "confirmed", ... }
}
```

Approval flow: `status → "Booking Approved"` → controller auto-creates shipment rows in `shipments.json`. Delete booking → linked shipment rows also deleted.

## Password Notes

`backend/utils/passwordUtils.js` — scrypt hashing with format `scrypt:<salt>:<hash>`.  
Legacy plaintext passwords in `users.json` still work (migration path in `verifyPassword`).  
Default admin password: `password123` (plaintext, replace before any deployment).

## Fulfillment Architecture (Three-Way Match)

Three distinct SKU-level quantities, each from a different source of truth:

| Quantity | Source | Owner | When known |
|----------|--------|-------|------------|
| **Expected** | PO `line_items[].expected_qty` | Procurement | PO creation |
| **Shipped** | Booking `commercial_invoice.line_items[].qty` (where `match_status === 'matched'`) | Vendor (via portal) | CI upload & confirm |
| **Received** | 3PL warehouse → NetSuite | 3PL | Physical delivery (future) |

### Key Design Rule

**Never store derived quantities.** All SKU-level fulfillment data is computed live:

```
shipped_qty   = SUM(confirmed bookings → ci.line_items where sku_code + matched_po match)
remaining_qty = PO.line_items[sku].expected_qty − shipped_qty
received_qty  = from NetSuite/3PL integration (future — placeholder 0)
variance      = shipped_qty − received_qty (future)
```

### Shipments carry NO line_items

A shipment row is a **tracking record** only: `expected_quantity` (booking total), `lot_number`, `status`, dates, booking_number, po_number. **No `line_items` array** — SKU-level data is always derived from PO + CI.

- `syncCiToShipments` does not exist — no sync needed
- Proportional SKU allocation does not exist — no `Math.round(li.expected_qty * units / poExpectedQty)`
- ShipmentsClient lot panel derives SKU data via the fulfillment endpoint, not stored data

### Fulfillment endpoint

`GET /purchase-orders/:id/fulfillment` reads PO line_items + all confirmed booking CIs to compute per-SKU: `{ expected_qty, shipped_qty, remaining_qty }`

## User Management

### Data shape — `backend/data/users.json`

```json
{
  "id": "1",
  "email": "admin@tentree.com",
  "password": "scrypt:<salt>:<hash>",
  "name": "Admin User",
  "role": "Admin",
  "supplier": null,
  "must_change_password": false
}
```

Valid roles: `Admin`, `Logistics Coordinator`, `Production`, `Vendor`  
Vendor accounts carry a `supplier` field that links to a name in `/master-data/suppliers`.  
Passwords are hashed with scrypt via `backend/utils/passwordUtils.js` — never stored plaintext.

### Backend routes — `/users`

| Method | Path | Guard | Description |
|--------|------|-------|-------------|
| GET | `/users` | requireAdmin | List all users (password field stripped) |
| POST | `/users` | requireAdmin | Create user — hashes password, sets `must_change_password: true` |
| PUT | `/users/:id` | requireAdmin | Update name/role/supplier/email; password reset optional |
| DELETE | `/users/:id` | requireAdmin | Delete user; cannot delete yourself |

`requireAdmin` middleware (`backend/middleware/requireAdmin.js`) wraps `requireAuth` and additionally checks `req.user.role === 'Admin'`, returning 403 otherwise.

## Role Management

### Permission keys — `src/lib/permissions.ts`

All defined keys in `ALL_PERMISSIONS`. Grouped into categories via `PERMISSION_MANIFEST` for the matrix UI.

| Category | Keys |
|----------|------|
| Pages | `dashboard`, `purchase_orders`, `bookings`, `shipments`, `reports`, `forecast`, `eom`, `contacts`, `settings` |
| Bookings | `booking_create_mainline`, `booking_create_sms`, `booking_approve`, `booking_delete` |
| Shipments | `shipment_update_status`, `shipment_delete`, `shipment_import_export` |
| POs | `po_edit` |
| Admin | `settings_edit`, `user_manage` |

### Data shape — `backend/data/roles.json`

```json
{
  "id": "logistics",
  "name": "Logistics Coordinator",
  "description": "...",
  "protected": false,
  "permissions": ["dashboard", "bookings", ...]
}
```

`protected: true` roles (Admin) cannot be renamed or deleted.

### Backend routes — `/roles`

| Method | Path | Guard | Description |
|--------|------|-------|-------------|
| GET | `/roles` | requireAuth | List all roles with permissions |
| POST | `/roles` | requireAdmin | Create role |
| PUT | `/roles/:id` | requireAdmin | Update permissions / description |
| DELETE | `/roles/:id` | requireAdmin | Delete (blocked if protected or role in use) |

### Login flow injects permissions

`authController.login()` reads the user's role from `roles.json` and includes `permissions: string[]` in the response. The frontend stores it in the session cookie. `SessionProvider.UserSession` carries `permissions?: string[]`.

**Implication:** permission changes take effect on the user's next login.

### Sidebar uses permissions dynamically

`can(permission)` helper in `Sidebar.tsx` checks `user.permissions.includes(...)`. Each navItem has a `permission` key. `showMasterData` checks `can('settings')`.

Fallback for legacy sessions without permissions: Admin sees everything, others see nothing (forces re-login).

### Frontend — `/settings/roles`

- `src/app/actions/roles.ts` — server actions
- `src/components/settings/RoleSettings.tsx` — permission matrix (rows = permissions, columns = roles, checkboxes in cells, Save per column)
- `src/app/settings/roles/page.tsx` — page wrapper

### Component-level permission checks

Still hardcoded role-name checks in ShipmentsClient, BookingDetailDrawer, etc. These are not yet wired to `user.permissions`. Sidebar page-level access is fully dynamic; action-level enforcement inside components is a future refactor.

### Frontend — `/settings/users`

- `src/app/actions/users.ts` — server actions: `getUsers`, `createUser`, `updateUser`, `deleteUser`
- `src/components/settings/UserSettings.tsx` — table of users, inline role/supplier edit, Add User dialog
- `src/app/settings/users/page.tsx` — page wrapper

Admin-only guard: page checks session role client-side and renders nothing for non-admins.  
Self-guard: cannot delete or demote your own account (both frontend and backend enforce this).

## NetSuite Integration Architecture

### Credentials — `backend/.env`

OAuth 1.0 TBA against sandbox `4297852-sb1`. All five vars must be set:
`NETSUITE_ACCOUNT_ID`, `NETSUITE_CONSUMER_KEY`, `NETSUITE_CONSUMER_SECRET`, `NETSUITE_TOKEN_ID`, `NETSUITE_TOKEN_SECRET`

### Service — `backend/services/integrationService.js`

| Method | Description |
|--------|-------------|
| `_suiteqlFetchAll(query, pageSize)` | Internal paginator — POSTs SuiteQL, follows `hasMore` + `offset` until all rows fetched |
| `fetchNetSuiteLineItems()` | Runs `SUITEQL_LINE_ITEMS_QUERY`, groups rows by `po_number` → returns `Map<po_number, line_items[]>`. Degrades gracefully on query error (logs + returns empty Map, never throws) |
| `fetchNetSuitePOs({ maxResults })` | Runs header query + `fetchNetSuiteLineItems()` in parallel, merges `line_items[]` onto each PO |

### SuiteQL queries

**`SUITEQL_QUERY`** (headers) — aggregates `SUM(tl.quantity)` as `total_qty` per PO. Status filter: `A/B/C` (open, partially received, pending billing). Groups by all non-aggregate fields.

**`SUITEQL_LINE_ITEMS_QUERY`** (line items) — one row per `InvtPart` line:
- `t.tranid AS po_number` — matches header query for join
- `i.itemid AS sku_code` — SKU code (also used as `description`; `salesdescription` and `displayname` do **not** exist on this NS account's `item` record)
- `tl.quantity AS expected_qty`, `tl.rate AS unit_price`
- ORDER BY `t.tranid, tl.linesequencenumber` — **not** `tl.line` (invalid column in SuiteQL)

### Controller — `backend/controllers/integrationController.js`

`GET /integrations/netsuite/pos?limit=N` (requireAdmin) — upserts POs matched by `po_number`.  
NS-owned fields refreshed on every sync: all header fields + `line_items`.  
Portal-managed fields never touched: `booking_status`, `booking_number`.

### PO controller normalization

`purchaseOrderController.getAll` and `getOne` normalize `line_items` to `[]` for any PO missing the field — ensures the API always returns a consistent shape regardless of whether NS sync has run.

### Route

`GET /integrations/netsuite/pos` — `requireAdmin` guard. Frontend button: **NetSuite Sync** in `OrdersTable`.

## Purchase Orders Architecture

### Route structure

```
/purchase-orders             → RSC page.tsx → OrdersTable (client, paginated list)
/purchase-orders/[id]        → RSC page.tsx → OrderDetail (full-page detail)
/purchase-orders/[id]/loading.tsx  → animated skeleton
/purchase-orders/[id]/not-found.tsx → 404 triggered by notFound()
/purchase-orders/newPOs      → RSC page.tsx → OrderDetail with po=null (create mode)
```

### Key files

- `src/app/purchase-orders/OrdersTable.tsx` — client component; 10-per-page pagination; search/season/type filters reset page on change; rows navigate to `/purchase-orders/[id]`
- `src/app/purchase-orders/[id]/page.tsx` — RSC; `params` is `Promise<{id}>` (Next.js 15 — must `await`); fetches PO + master data in parallel; calls `notFound()` if missing
- `src/components/purchase-orders/OrderDetail.tsx` — full-page detail/create/edit component; uses `OrderHeader` for the header block
- `src/components/purchase-orders/OrderHeader.tsx` — extracted header: breadcrumb, action buttons (edit/save/delete/duplicate), hero row (icon + PO# + badges)
- `src/components/purchase-orders/LineItemsTable.tsx` — shows first 10 SKUs in read mode; "View N more / Collapse" toggle; always shows all in edit mode
- `src/components/purchase-orders/columns.ts` — `COLUMNS: ColumnDef[]` and `DEFAULT_VISIBLE_COLUMNS` typed as `Array<keyof Order>`
- `src/types/order.ts` — `Order`, `LineItem`, `OrderStatus`, `OrderType` types
- `src/app/actions/purchase-orders.ts` — includes `getPurchaseOrder(id)` for RSC detail fetch

### PO IDs

Sequential integers stored as strings (`"1"`, `"2"`, …). Controller uses `Math.max(...existing ids) + 1` for both `create` and `bulkCreate`. Never use timestamps for IDs.

### Fulfillment table in OrderDetail

Shows first 10 SKU rows by default; single "View N more / Collapse" toggle below the table. Data is fetched client-side via `getFulfillment(po.id)` and `getShipmentLots(po.id)` on mount.

### Styling rules for tables

- Table element: `bg-card` — gives rows a solid white background in summer theme (never rely on transparent row backgrounds)
- Header/footer rows: `bg-card/80`
- Body row borders: `border-border` (no opacity fraction — opacity makes borders invisible on light themes)
- Body row hover: `hover:bg-muted/30`
- Overbooking rows: `bg-amber-500/10 hover:bg-amber-500/20`

## Bookings Architecture

### Route structure

```
/bookings/active           → BookingsList (active, 10/page, rows → /bookings/active/[id])
/bookings/active/[id]      → RSC → BookingDetail (isHistory=false, back → /bookings/active)
/bookings/active/[id]/loading.tsx
/bookings/active/[id]/not-found.tsx
/bookings/history          → BookingsList (history, 10/page, rows → /bookings/history/[id])
/bookings/history/[id]     → RSC → BookingDetail (isHistory=true, back → /bookings/history)
/bookings/history/[id]/loading.tsx
/bookings/history/[id]/not-found.tsx
/bookings/pending          → PendingPOsList (10/page)
/bookings/submit           → BookingForm
```

### Key files

- `src/app/bookings/BookingsClient.tsx` — orchestrator; `BookingsList` and `PendingPOsList` inner components, each with 10/page pagination; row click navigates to `active/[id]` or `history/[id]` based on `isHistory` prop
- `src/components/bookings/BookingDetail.tsx` — full-page detail/edit component (adapted from BookingDetailDrawer); `isHistory` prop controls backUrl and back label; all business logic preserved: split, duplicate, CI upload, approve/decline, live shipment status
- `src/components/bookings/columns.ts` — `COLUMNS: ColumnDef[]` and `DEFAULT_VISIBLE_COLUMNS`
- `src/types/booking.ts` — `Booking`, `PODetail`, `CILineItem`, `CommercialInvoice`, `BookingStatus` types
- `src/app/actions/bookings.ts` — includes `getBooking(id)` for RSC detail fetch

### Booking IDs

Sequential integers stored as strings (`"1"`, `"2"`, …) across both `bookings.json` and `history-bookings.json`. Controller uses `nextBookingId()` which reads max across both files and adds 1. Never use timestamps for IDs.

### Backend — `GET /bookings/:id`

Searches both `BookingModel` (active) and `HistoryBookingModel` (`history-bookings.json`) so a single route serves both active and history detail pages. History model: `const { historyBookings: HistoryBookingModel } = require('../models/HistoryModel')` — HistoryModel exports `{ history, historyBookings }`, not a class with `.read()` directly.

### BookingDetailDrawer

The old `BookingDetailDrawer.tsx` still exists but is no longer used in `BookingsClient`. It can be deleted once confirmed stable. Do not add new features to it.

## Agent File Ownership

| Agent    | Owns                                          | Never touches |
|----------|-----------------------------------------------|---------------|
| frontend | `frontend/tentree-scportal/src/`              | `backend/`    |
| backend  | `backend/server.js`, `backend/services/`, `backend/data/` | `frontend/` |
| qa       | Read-only — no writes                         | —             |
