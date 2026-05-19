# SKU-Level Expansion — Implementation Plan

> **Author:** lampossible + Claude  
> **Created:** 2026-05-06  
> **Status:** Planning  
> **Goal:** Expand the tentree Supply Chain Portal from PO-level to SKU-level tracking, enabling receiving transparency between vendors and the company, and automated CI parsing.

---

## Context & Constraints

- **Current state:** PO-level tracking using JSON files on Google Drive (temporary). Express backend, Next.js RSC frontend.
- **Target infra:** AWS (RDS PostgreSQL + S3 + ECS/Lambda). Database migration is a prerequisite.
- **Seasons:** 2 per year (SS and FW), ~100 POs per season, ~100 SKUs per PO.
- **Data volume:** ~20,000 SKU rows active at any time — trivial for PostgreSQL.
- **CI format:** Fixed Excel template across vendors. Variable row count only.
- **Key users:** Admin, Logistics Coordinator (internal), Production (internal), Vendor (external, read-only on POs).

---

## Phase 0 — Database Migration (Prerequisite)

**Goal:** Replace JSON file storage with PostgreSQL on AWS. No feature changes — identical API contract.

### 0.1 AWS Infrastructure Setup

| Resource | Service | Notes |
|---|---|---|
| Database | Aurora PostgreSQL Serverless v2 | Scales to zero when idle, cost-efficient |
| File storage | S3 | CI uploads, document attachments |
| Backend API | ECS Fargate (or Lambda + API Gateway) | Containerized Express or serverless |
| Frontend | Vercel or Amplify | Already Next.js, minimal change |
| Secrets | AWS Secrets Manager | DB credentials, API keys |

### 0.2 Database Schema — Current Tables (1:1 migration from JSON)

```sql
-- Users & Auth
CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,  -- hash after migration
  name        VARCHAR(255) NOT NULL,
  role        VARCHAR(50) NOT NULL,   -- 'Admin', 'Logistics Coordinator', 'Production', 'Vendor'
  supplier    VARCHAR(255)            -- NULL for non-vendor roles
);

-- Master Data
CREATE TABLE suppliers (
  id      SERIAL PRIMARY KEY,
  name    VARCHAR(255) UNIQUE NOT NULL,
  country VARCHAR(100)
);

CREATE TABLE couriers (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL
);

CREATE TABLE incoterms (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL  -- FOB, DDP, Ex-works, DAP
);

-- Purchase Orders (header level — current)
CREATE TABLE purchase_orders (
  id                   SERIAL PRIMARY KEY,
  season               VARCHAR(20),
  trn_number           VARCHAR(50),
  po_number            VARCHAR(50) UNIQUE NOT NULL,
  type                 VARCHAR(20) DEFAULT 'mainline',  -- 'mainline' | 'sms'
  supplier             VARCHAR(255),
  mode                 VARCHAR(50),         -- Ocean, Air, Courier
  incoterm             VARCHAR(50) DEFAULT 'FOB',
  expected_qty         INTEGER DEFAULT 0,
  booked_qty           INTEGER DEFAULT 0,
  received_qty         INTEGER DEFAULT 0,
  receiving_warehouse  VARCHAR(100),
  etd                  DATE,
  eta                  DATE,
  actual_receive_date  DATE,
  booking_status       VARCHAR(50),
  booking_number       VARCHAR(50),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Bookings
CREATE TABLE bookings (
  id                   SERIAL PRIMARY KEY,
  booking_number       VARCHAR(50) UNIQUE NOT NULL,
  type                 VARCHAR(20) DEFAULT 'mainline',
  vendor_name          VARCHAR(255),
  tentree_po_number    TEXT,          -- comma-separated PO numbers (kept for backward compat)
  receiving_warehouse  VARCHAR(100),
  number_of_cartons    INTEGER,
  cargo_ready_date     DATE,
  courier              VARCHAR(255),
  tracking_number      VARCHAR(255),
  mode                 VARCHAR(50),
  incoterm             VARCHAR(50),
  season               VARCHAR(20),
  trn_number           VARCHAR(50),
  booking_status       VARCHAR(50) DEFAULT 'Booking Pending',
  freight_forwarder    VARCHAR(255),
  commercial_invoice_url TEXT,
  submitted_at         TIMESTAMPTZ,
  approved_at          TIMESTAMPTZ,
  decline_reason       TEXT,
  archived             BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Booking PO Details (current po_details array → normalized)
CREATE TABLE booking_po_details (
  id              SERIAL PRIMARY KEY,
  booking_id      INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  po_number       VARCHAR(50),
  cartons         INTEGER,
  units           INTEGER,
  cbm             DECIMAL(10,2),
  weight          DECIMAL(10,2)
);

-- Shipments
CREATE TABLE shipments (
  id                    SERIAL PRIMARY KEY,
  po_number             VARCHAR(50),
  season                VARCHAR(20),
  trn_number            VARCHAR(50),
  type                  VARCHAR(20) DEFAULT 'mainline',
  supplier              VARCHAR(255),
  mode                  VARCHAR(50),
  courier               VARCHAR(255),
  incoterm              VARCHAR(50),
  tracking_number       VARCHAR(255),
  expected_quantity     INTEGER,
  received_qty          INTEGER,
  destination_warehouse VARCHAR(100),
  etd                   DATE,
  eta                   DATE,
  status                VARCHAR(50),
  lot_number            INTEGER,
  booking_number        VARCHAR(50),
  booking_status        VARCHAR(50),
  asn_sent              BOOLEAN DEFAULT FALSE,
  archived              BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Contacts, EoM Tasks (same pattern — direct migration)
```

### 0.3 Migration Steps

1. **Write a migration script** (`backend/scripts/migrate-to-pg.js`):
   - Read each JSON file
   - Insert rows into corresponding PostgreSQL table
   - Validate row counts match
2. **Replace `readData()`/`writeData()` in server.js** with a `db` module using `pg` (node-postgres) or Prisma
3. **Keep the same Express routes** — only the storage layer changes
4. **No frontend changes** — API contract stays identical
5. **Run JSON and PG side-by-side** for 1 week (dual-write), then cut over

### 0.4 Acceptance Criteria

- [ ] All existing pages load with identical data from PostgreSQL
- [ ] CRUD operations work for all entities (POs, bookings, shipments, master data)
- [ ] History sweep/archival works (use `archived` boolean column instead of separate table)
- [ ] Google Drive document storage replaced with S3 pre-signed URLs
- [ ] CI/CD pipeline deploys backend to ECS, runs migrations on deploy

---

## Phase 1 — SKU Line Items on Purchase Orders

**Goal:** Each PO has child SKU rows. Internal users see full detail. Vendors see their own POs with SKU breakdown (read-only).

### 1.1 New Table

```sql
CREATE TABLE po_line_items (
  id              SERIAL PRIMARY KEY,
  po_id           INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sku_code        VARCHAR(100) NOT NULL,
  description     TEXT,
  color           VARCHAR(100),
  size            VARCHAR(50),
  expected_qty    INTEGER DEFAULT 0,
  unit_price      DECIMAL(10,2),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_po_line_items_po_id ON po_line_items(po_id);
CREATE INDEX idx_po_line_items_sku ON po_line_items(sku_code);
```

### 1.2 Backend Changes

| Route | Change |
|---|---|
| `GET /purchase-orders` | Add query param `?include=line_items` to join and return nested `line_items[]` |
| `GET /purchase-orders/:id` | Always return with `line_items[]` |
| `POST /purchase-orders` | Accept optional `line_items[]` in body, insert into `po_line_items` |
| `PUT /purchase-orders/:id` | Support upsert of `line_items[]` (delete removed, insert new, update existing) |
| `POST /purchase-orders/bulk` (CSV import) | Parse SKU columns if present; create parent PO + child line items |
| `POST /purchase-orders/sync-netsuite` | New endpoint — pull PO + line items from NetSuite API |

### 1.3 Frontend Changes

| Component | Change |
|---|---|
| `PurchaseOrdersClient.tsx` | PO table stays at PO header level (no change to list view) |
| `PoDetailDrawer.tsx` | Add a collapsible "Line Items" section below PO header. Shows table: SKU, Description, Color, Size, Qty, Unit Price. Read-only for Vendor. Editable for Admin/Logistics. |
| `purchase-orders/page.tsx` | Pass `include=line_items` when fetching for detail view (lazy load, not on list) |

### 1.4 NetSuite Sync (if API available)

```
New action: syncFromNetSuite(po_number)
  → Call NetSuite REST API for PO + line items
  → Upsert into purchase_orders + po_line_items
  → Return diff summary (added/updated/removed)
```

If NetSuite doesn't expose a clean API for line items, allow CSV import with SKU columns as an alternative.

### 1.5 Acceptance Criteria

- [ ] PO detail drawer shows SKU-level breakdown
- [ ] Admin can edit/add/remove line items
- [ ] Vendor sees line items read-only for their own POs
- [ ] CSV import supports SKU columns
- [ ] `purchase_orders.expected_qty` auto-calculated as SUM of `po_line_items.expected_qty`

---

## Phase 2 — SKU-Level Booking & Commercial Invoice Parsing

**Goal:** When a vendor books a shipment, they specify quantities per SKU. CI upload auto-populates from the fixed-format Excel.

### 2.1 New Tables

```sql
-- Replaces the flat booking_po_details with SKU granularity
CREATE TABLE booking_line_items (
  id                SERIAL PRIMARY KEY,
  booking_id        INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  po_line_item_id   INTEGER REFERENCES po_line_items(id),
  po_number         VARCHAR(50),
  sku_code          VARCHAR(100),
  shipped_qty       INTEGER DEFAULT 0,
  cartons           INTEGER,
  cbm               DECIMAL(10,2),
  weight            DECIMAL(10,2)
);

CREATE TABLE commercial_invoices (
  id              SERIAL PRIMARY KEY,
  booking_id      INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  invoice_number  VARCHAR(100),
  invoice_date    DATE,
  total_value     DECIMAL(12,2),
  currency        VARCHAR(10) DEFAULT 'USD',
  file_url        TEXT,           -- S3 pre-signed URL
  parsed_at       TIMESTAMPTZ,
  status          VARCHAR(50) DEFAULT 'uploaded',  -- 'uploaded' | 'parsed' | 'confirmed'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ci_line_items (
  id                      SERIAL PRIMARY KEY,
  commercial_invoice_id   INTEGER REFERENCES commercial_invoices(id) ON DELETE CASCADE,
  po_line_item_id         INTEGER REFERENCES po_line_items(id),  -- matched SKU
  sku_code                VARCHAR(100),
  description             TEXT,
  quantity                INTEGER,
  unit_price              DECIMAL(10,2),
  total_price             DECIMAL(12,2),
  match_status            VARCHAR(20) DEFAULT 'auto',  -- 'auto' | 'manual' | 'unmatched'
  created_at              TIMESTAMPTZ DEFAULT NOW()
);
```

### 2.2 CI Parsing Engine

Since the CI is a **fixed Excel format**, the parser is simple:

```
backend/services/ciParser.js

Input:  Excel file (Buffer)
Output: { header: { invoiceNumber, date, totalValue }, lineItems: [{ sku, desc, qty, unitPrice, total }] }

Steps:
  1. Read workbook with 'xlsx' library
  2. Find header row (configurable offset, e.g., row 5)
  3. Map columns by position: A=SKU, B=Description, C=Qty, D=Unit Price, E=Total (configurable)
  4. Read rows until empty
  5. Extract invoice metadata from known cells (e.g., B2=Invoice#, D2=Date)
  6. Return structured data
```

**Column mapping config** stored in `ci_templates` table or a simple JSON config:

```json
{
  "header_row": 5,
  "columns": {
    "sku_code": "A",
    "description": "B",
    "quantity": "C",
    "unit_price": "D",
    "total_price": "E"
  },
  "metadata": {
    "invoice_number": "B2",
    "invoice_date": "D2"
  }
}
```

### 2.3 CI Upload Workflow

```
Step 1: Vendor uploads Excel on booking form
  → POST /commercial-invoices/upload
  → File stored in S3, commercial_invoices row created (status='uploaded')

Step 2: Backend parses immediately
  → ciParser.js extracts line items
  → Auto-match sku_code against po_line_items for the booking's POs
  → Insert ci_line_items with match_status='auto' or 'unmatched'
  → Update commercial_invoices.status = 'parsed'

Step 3: Vendor reviews parsed result in the UI
  → Table shows: SKU | Description | CI Qty | PO Expected Qty | Match Status
  → Vendor can manually fix unmatched rows (select correct PO line item from dropdown)
  → Vendor clicks "Confirm"
  → POST /commercial-invoices/:id/confirm
  → Status = 'confirmed', booking_line_items populated from ci_line_items
```

### 2.4 Frontend Changes

| Component | Change |
|---|---|
| `BookingForm.tsx` | In multi-PO mode: after PO selection, show SKU-level breakdown per PO. Vendor enters shipped_qty per SKU instead of per PO. |
| `BookingForm.tsx` | Add CI upload section. After upload, show parsed preview table. Confirm button commits. |
| New: `CiPreviewTable.tsx` | Displays parsed CI vs PO line items. Highlights matches/mismatches. |
| `BookingDetailDrawer.tsx` | Show CI attachment and parsed line items for Admin review. |

### 2.5 Acceptance Criteria

- [ ] Vendor can upload fixed-format Excel CI during booking
- [ ] Parser extracts line items and auto-matches to PO SKUs
- [ ] Preview table shows match status, vendor can fix unmatched rows
- [ ] Confirmed CI creates `booking_line_items` at SKU level
- [ ] Admin can view CI details and line items in booking drawer

---

## Phase 3 — Receiving Reconciliation (Transparency Layer)

**Goal:** Warehouse enters received quantities per SKU. Both vendor and company see expected vs shipped vs received in real time.

### 3.1 New Table

```sql
CREATE TABLE receiving_records (
  id                  SERIAL PRIMARY KEY,
  shipment_id         INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  booking_line_item_id INTEGER REFERENCES booking_line_items(id),
  sku_code            VARCHAR(100),
  expected_qty        INTEGER,    -- from booking_line_items.shipped_qty
  received_qty        INTEGER DEFAULT 0,
  received_date       DATE,
  discrepancy_notes   TEXT,
  received_by         VARCHAR(255),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.2 Backend Changes

| Route | Purpose |
|---|---|
| `GET /shipments/:id/receiving` | Return receiving records with SKU details |
| `POST /shipments/:id/receiving` | Warehouse submits received qtys per SKU |
| `PUT /receiving-records/:id` | Update individual receiving record |
| `GET /shipments/:id/reconciliation` | Return side-by-side: PO expected → CI shipped → actually received |

### 3.3 Frontend Changes

| Component | Change |
|---|---|
| `ShipmentDetailDrawer.tsx` | Add "Receiving" tab. Table: SKU, Expected, Shipped (from CI), Received (editable for warehouse), Delta. Color-coded deltas. |
| New: `ReceivingScreen.tsx` | Full-page receiving view for warehouse staff. Scan-or-select shipment → see SKU list → enter received qtys → submit. |
| New: `ReconciliationView.tsx` | Side-by-side view: PO Expected → CI Shipped → Received. Visible to both Admin and Vendor. Flags discrepancies in red. |
| `PurchaseOrdersClient.tsx` → `PoDetailDrawer.tsx` | Show received_qty per SKU alongside expected_qty. Roll up to PO header. |

### 3.4 Vendor Visibility

Vendors see for their own POs:
- **PO screen:** Expected qty per SKU (from PO) vs Received qty per SKU (from warehouse)
- **Booking screen:** What they shipped (from CI) vs what was received
- **Discrepancy alerts:** Toast/badge when shipped ≠ received

### 3.5 Acceptance Criteria

- [ ] Warehouse can enter received qty per SKU per shipment
- [ ] Reconciliation view shows PO → CI → Received side-by-side
- [ ] Vendor can see receiving status for their shipments (read-only)
- [ ] Discrepancies flagged automatically (received < shipped)
- [ ] `purchase_orders.received_qty` auto-calculated from SUM of receiving_records

---

## Phase Summary & Dependencies

```
Phase 0: Database Migration          ← MUST complete before anything else
  │
  ├── Phase 1: SKU on POs            ← Can start immediately after Phase 0
  │     │
  │     └── Phase 2: SKU Booking + CI ← Depends on Phase 1 (needs po_line_items)
  │           │
  │           └── Phase 3: Receiving  ← Depends on Phase 2 (needs booking_line_items)
  │
  (Phases are sequential — each builds on the previous)
```

## Estimated Effort

| Phase | Scope | Estimate |
|---|---|---|
| Phase 0 | DB migration, AWS infra, S3, dual-write cutover | 1–2 weeks |
| Phase 1 | po_line_items table, detail drawer, CSV import, NetSuite sync | 3–5 days |
| Phase 2 | booking_line_items, CI parser, upload flow, preview UI | 4–6 days |
| Phase 3 | receiving_records, reconciliation view, vendor visibility | 3–5 days |
| **Total** | | **~4–5 weeks** |

---

## Files That Will Be Created or Modified

### New Files (Backend)
- `backend/db/index.js` — PostgreSQL connection pool (pg or Prisma client)
- `backend/db/migrations/` — SQL migration files per phase
- `backend/scripts/migrate-to-pg.js` — one-time JSON → PostgreSQL migration
- `backend/services/ciParser.js` — Excel CI parsing engine
- `backend/services/receivingService.js` — receiving reconciliation logic

### New Files (Frontend)
- `src/components/purchase-orders/LineItemsTable.tsx` — SKU table inside PO drawer
- `src/components/bookings/CiPreviewTable.tsx` — parsed CI preview during booking
- `src/components/bookings/CiUploadSection.tsx` — CI upload + parse + confirm flow
- `src/components/shipments/ReceivingScreen.tsx` — warehouse receiving input
- `src/components/shipments/ReconciliationView.tsx` — 3-column reconciliation
- `src/app/actions/commercial-invoices.ts` — CI upload/parse/confirm actions
- `src/app/actions/receiving.ts` — receiving record actions

### Modified Files (Backend)
- `backend/server.js` — replace JSON read/write with db queries, add new routes
- `backend/driveStorage.js` — replaced by S3 integration for documents

### Modified Files (Frontend)
- `src/app/purchase-orders/PurchaseOrdersClient.tsx` — lazy-load line items in drawer
- `src/components/purchase-orders/PoDetailDrawer.tsx` — add line items section
- `src/components/bookings/BookingForm.tsx` — SKU-level shipped qty, CI upload
- `src/components/bookings/BookingDetailDrawer.tsx` — CI detail view
- `src/components/shipments/ShipmentDetailDrawer.tsx` — receiving tab
- `src/app/actions/purchase-orders.ts` — include line_items param
- `src/app/actions/bookings.ts` — booking_line_items support
- `src/app/actions/shipments.ts` — receiving endpoints

---

## Open Questions

1. **NetSuite API access** — Is there a REST API for pulling PO line items? Or CSV-only?
2. **Password hashing** — Current users.json stores plaintext passwords. Phase 0 should hash them (bcrypt).
3. **Multi-currency** — Are CIs always in USD, or do we need currency conversion?
4. **Barcode/scan receiving** — Does the warehouse have scanners, or is manual entry sufficient?
5. **CI rejection flow** — If CI doesn't match PO, should the system reject it or flag for manual review?
