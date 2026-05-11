# SKU-Level Expansion — Implementation Plan

> **Author:** lampossible  
> **Created:** 2026-05-06  
> **Updated:** 2026-05-08  
> **Status:** Active — JSON-first approach  
> **Goal:** Expand the tentree Supply Chain Portal from PO-level to SKU-level tracking, enabling receiving transparency between vendors and the company, and automated CI parsing.

---

## Revised Strategy: JSON-First, Then PostgreSQL

> **Decision (2026-05-08):** Build SKU-level features on top of the current JSON + Express stack.
> The data model is designed so PostgreSQL migration later is purely a storage swap — nested JSON arrays
> become proper tables with foreign keys, but no business logic changes.

### Core Design Principle: Compute, Don't Duplicate

**Never store derived quantities (`shipped_qty`, `remaining_qty`) on the PO.**
Calculate them at read time by aggregating across all confirmed CI bookings.

```
remaining_qty = PO.line_items[sku].expected_qty
              − SUM(all confirmed bookings → ci_line_items where sku_code matches)
```

This ensures a single source of truth and eliminates drift between stored values.

---

## The Data Flow

```
PO (line_items = what was ordered)
  │  sku: TT-BLK-S, expected: 1000
  │  sku: TT-BLK-M, expected: 2000
  │
  │        Vendor uploads CI (Excel)
  │                 │
  │          parse → sku: TT-BLK-S, shipped: 950
  │          parse → sku: TT-BLK-M, shipped: 2000
  │                 │
  └────── Auto-match by sku_code ──────┘
                    │
             Booking Detail View
  ┌──────────────────────────────────────┐
  │ SKU        │ PO Qty │ CI Qty │ Delta │
  │ TT-BLK-S  │  1,000 │    950 │   -50 │
  │ TT-BLK-M  │  2,000 │  2,000 │     0 │
  └──────────────────────────────────────┘
```

---

## Context & Constraints

- **Current state:** PO-level tracking using JSON files (via Google Drive). Express backend, Next.js RSC frontend.
- **Target infra:** AWS (RDS PostgreSQL + S3 + ECS/Lambda). Database migration is a later step, not a prerequisite for SKU expansion.
- **Seasons:** 2 per year (SS and FW), ~100 POs per season, ~100 SKUs per PO.
- **Data volume:** ~20,000 SKU rows active at any time — trivial for PostgreSQL.
- **CI format:** Fixed Excel template across vendors. Variable row count only.
- **Key users:** Admin, Logistics Coordinator (internal), Production (internal), Vendor (external, read-only on POs).

---

## Build Order (JSON Stack)

```
Step 1: line_items on POs            ← source of truth: what was ordered
  ├── Add line_items[] to purchase-orders.json
  ├── Backend CRUD (GET/POST/PUT /purchase-orders/:id/line-items)
  └── UI: LineItemsTable in PoDetailDrawer (read-only first, editable for Admin)

Step 2: CI parser service             ← parse vendor Excel CI
  ├── backend/services/ciParser.js (xlsx library)
  ├── Column mapping config (matches fixed vendor format)
  └── POST /commercial-invoices/parse → returns preview JSON

Step 3: CI upload flow on Booking     ← source of truth: what vendor shipped
  ├── Upload button in BookingForm
  ├── Preview table (parsed CI vs PO line items, highlights mismatches)
  ├── Vendor confirms → saved as booking.commercial_invoice
  └── Admin review in BookingDetailDrawer

Step 4: Fulfillment view              ← computed: shipped vs remaining per SKU
  ├── GET /purchase-orders/:id?include=fulfillment
  │     → aggregates across all confirmed CIs referencing this PO
  └── PO detail shows: Expected | Shipped (from CI) | Remaining per SKU

Step 5: Receiving (defer to PostgreSQL phase)
  └── Warehouse enters received qty per SKU — needs real DB for audit trail
```

---

## JSON Data Shape (Current Stack)

### purchase-orders.json — Add `line_items` array

```json
{
  "po_number": "PO-SS26-001",
  "expected_qty": 5000,
  "line_items": [
    {
      "sku_code": "TT-BLK-S",
      "description": "Classic Tee Black S",
      "color": "Black",
      "size": "S",
      "expected_qty": 1000,
      "unit_price": 4.50
    },
    {
      "sku_code": "TT-BLK-M",
      "description": "Classic Tee Black M",
      "color": "Black",
      "size": "M",
      "expected_qty": 2000,
      "unit_price": 4.50
    }
  ]
}
```

> `expected_qty` on the PO header **must equal** `SUM(line_items[].expected_qty)`.
> Backend should enforce this on save.

### bookings.json — Add `commercial_invoice` object

```json
{
  "booking_number": "BKG-2873",
  "po_details": [...],
  "commercial_invoice": {
    "invoice_number": "INV-2026-0042",
    "invoice_date": "2026-05-10",
    "file_path": "/uploads/ci/BKG-2873_INV-2026-0042.xlsx",
    "parsed_at": "2026-05-10T08:30:00Z",
    "status": "confirmed",
    "line_items": [
      {
        "sku_code": "TT-BLK-S",
        "description": "Classic Tee Black S",
        "qty": 950,
        "unit_price": 4.50,
        "total": 4275.00,
        "matched_po": "PO-SS26-001"
      },
      {
        "sku_code": "TT-BLK-M",
        "description": "Classic Tee Black M",
        "qty": 2000,
        "unit_price": 4.50,
        "total": 9000.00,
        "matched_po": "PO-SS26-001"
      }
    ]
  }
}
```

CI status lifecycle: `uploaded → parsed → confirmed`

---

## Backend Routes (JSON Phase)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/purchase-orders` | Unchanged — returns PO header list |
| `GET` | `/purchase-orders/:id` | Returns PO with `line_items[]` |
| `POST` | `/purchase-orders/:id/line-items` | Replace all line items for a PO |
| `PUT` | `/purchase-orders/:id/line-items/:sku` | Update a single SKU row |
| `GET` | `/purchase-orders/:id/fulfillment` | Computed: expected vs shipped per SKU (aggregated from all confirmed CIs) |
| `POST` | `/commercial-invoices/parse` | Upload Excel → returns parsed preview (not saved yet) |
| `POST` | `/bookings/:id/commercial-invoice/confirm` | Vendor confirms parsed CI → saved to booking |
| `GET` | `/bookings/:id/commercial-invoice` | Returns CI details for admin review |

---

## CI Parser Service

```
backend/services/ciParser.js

Input:  Excel file buffer
Output: {
  header: { invoiceNumber, invoiceDate, totalValue },
  lineItems: [{ skuCode, description, qty, unitPrice, total }]
}

Steps:
  1. Read workbook with 'xlsx' library
  2. Jump to header_row (configurable, e.g., row 5)
  3. Map columns by position (configurable per vendor template)
  4. Read rows until first empty SKU cell
  5. Extract invoice metadata from known cells (e.g., B2=Invoice#, D2=Date)
  6. Return structured data
```

**Column mapping config** (JSON — one per vendor template if needed):

```json
{
  "header_row": 5,
  "columns": {
    "sku_code":    "A",
    "description": "B",
    "quantity":    "C",
    "unit_price":  "D",
    "total_price": "E"
  },
  "metadata": {
    "invoice_number": "B2",
    "invoice_date":   "D2"
  }
}
```

**Auto-matching logic:** After parsing, cross-reference each `sku_code` against the
`line_items` of all POs in `booking.po_details`. Attach `matched_po` if found.
Flag as `unmatched` if no PO contains that SKU.

---

## Frontend Components

| Component | Change |
|---|---|
| `PoDetailDrawer.tsx` | Add collapsible "Line Items" section — SKU, Description, Color, Size, Expected Qty, Unit Price. Read-only for Vendor, editable for Admin. |
| New: `LineItemsTable.tsx` | Reusable SKU table used in both PO drawer and reconciliation views. |
| `BookingForm.tsx` | Add CI upload section (file picker + parse trigger). Show `CiPreviewTable` after parse. Confirm button commits. |
| New: `CiPreviewTable.tsx` | Side-by-side: parsed CI rows vs PO expected rows. Highlights qty mismatches in amber/red. Shows match status. |
| `BookingDetailDrawer.tsx` | Show attached CI (invoice number, date, file link) + line items table for Admin review. |
| `PoDetailDrawer.tsx` | Add "Fulfillment" tab: Expected qty vs Shipped qty vs Remaining per SKU, sourced from `/fulfillment` endpoint. |

---

## What NOT to Build Yet

| Feature | Why deferred |
|---|---|
| Warehouse receiving / `received_qty` per SKU | Needs audit trail — defer to PostgreSQL phase |
| S3 file storage | Local `/uploads/ci/` is fine for dev; swap on AWS migration |
| Receiving reconciliation view (3-column) | Depends on receiving records existing |
| Multi-currency CI support | Confirm with ops — likely USD-only at launch |
| Barcode scan receiving | Depends on warehouse tooling |

---

## Phase 0 — Database Migration (When Ready)

> Execute this **after** the JSON-phase features are stable and tested.
> The migration is a straight mapping — no feature changes.

**Goal:** Replace JSON file storage with PostgreSQL on AWS. Identical API contract.

### AWS Infrastructure

| Resource | Service | Notes |
|---|---|---|
| Database | Aurora PostgreSQL Serverless v2 | Scales to zero when idle |
| File storage | S3 | CI uploads, document attachments |
| Backend API | ECS Fargate (or Lambda + API Gateway) | Containerized Express |
| Frontend | Vercel or Amplify | Next.js, minimal change |
| Secrets | AWS Secrets Manager | DB credentials, API keys |

### Database Schema — Full Target

```sql
-- Users & Auth
CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,  -- bcrypt hash (plaintext → hash in migration)
  name        VARCHAR(255) NOT NULL,
  role        VARCHAR(50) NOT NULL,
  supplier    VARCHAR(255)
);

-- Master Data
CREATE TABLE suppliers (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL, country VARCHAR(100));
CREATE TABLE couriers  (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL);
CREATE TABLE incoterms (id SERIAL PRIMARY KEY, name VARCHAR(50)  UNIQUE NOT NULL);

-- Purchase Orders (header)
CREATE TABLE purchase_orders (
  id                   SERIAL PRIMARY KEY,
  season               VARCHAR(20),
  trn_number           VARCHAR(50),
  po_number            VARCHAR(50) UNIQUE NOT NULL,
  type                 VARCHAR(20) DEFAULT 'mainline',
  supplier             VARCHAR(255),
  mode                 VARCHAR(50),
  incoterm             VARCHAR(50) DEFAULT 'FOB',
  expected_qty         INTEGER DEFAULT 0,  -- kept for backward compat; enforced = SUM(line_items)
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

-- SKU line items (Phase 1 addition — maps from JSON line_items[])
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
CREATE INDEX idx_po_line_items_sku   ON po_line_items(sku_code);

-- Bookings
CREATE TABLE bookings (
  id                    SERIAL PRIMARY KEY,
  booking_number        VARCHAR(50) UNIQUE NOT NULL,
  type                  VARCHAR(20) DEFAULT 'mainline',
  vendor_name           VARCHAR(255),
  tentree_po_number     TEXT,
  receiving_warehouse   VARCHAR(100),
  number_of_cartons     INTEGER,
  cargo_ready_date      DATE,
  courier               VARCHAR(255),
  tracking_number       VARCHAR(255),
  mode                  VARCHAR(50),
  incoterm              VARCHAR(50),
  season                VARCHAR(20),
  trn_number            VARCHAR(50),
  booking_status        VARCHAR(50) DEFAULT 'Booking Pending',
  freight_forwarder     VARCHAR(255),
  submitted_at          TIMESTAMPTZ,
  approved_at           TIMESTAMPTZ,
  decline_reason        TEXT,
  archived              BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Booking PO details (flat, backward compat)
CREATE TABLE booking_po_details (
  id         SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  po_number  VARCHAR(50),
  cartons    INTEGER,
  units      INTEGER,
  cbm        DECIMAL(10,2),
  weight     DECIMAL(10,2)
);

-- Commercial Invoices (maps from JSON booking.commercial_invoice)
CREATE TABLE commercial_invoices (
  id              SERIAL PRIMARY KEY,
  booking_id      INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  invoice_number  VARCHAR(100),
  invoice_date    DATE,
  total_value     DECIMAL(12,2),
  currency        VARCHAR(10) DEFAULT 'USD',
  file_url        TEXT,        -- S3 pre-signed URL (was: local file_path)
  parsed_at       TIMESTAMPTZ,
  status          VARCHAR(50) DEFAULT 'uploaded',  -- uploaded | parsed | confirmed
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- CI line items (maps from JSON booking.commercial_invoice.line_items[])
CREATE TABLE ci_line_items (
  id                    SERIAL PRIMARY KEY,
  commercial_invoice_id INTEGER REFERENCES commercial_invoices(id) ON DELETE CASCADE,
  po_line_item_id       INTEGER REFERENCES po_line_items(id),  -- matched SKU (NULL if unmatched)
  sku_code              VARCHAR(100),
  description           TEXT,
  quantity              INTEGER,
  unit_price            DECIMAL(10,2),
  total_price           DECIMAL(12,2),
  match_status          VARCHAR(20) DEFAULT 'auto',  -- auto | manual | unmatched
  matched_po            VARCHAR(50),
  created_at            TIMESTAMPTZ DEFAULT NOW()
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

-- Receiving (Phase 3 — after DB migration only)
CREATE TABLE receiving_records (
  id                    SERIAL PRIMARY KEY,
  shipment_id           INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
  ci_line_item_id       INTEGER REFERENCES ci_line_items(id),
  sku_code              VARCHAR(100),
  expected_qty          INTEGER,   -- from ci_line_items.quantity
  received_qty          INTEGER DEFAULT 0,
  received_date         DATE,
  discrepancy_notes     TEXT,
  received_by           VARCHAR(255),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
```

### Migration Steps

1. Write `backend/scripts/migrate-to-pg.js`:
   - Read each JSON file → insert into corresponding table
   - Expand `line_items[]` arrays → `po_line_items` rows
   - Expand `commercial_invoice.line_items[]` → `commercial_invoices` + `ci_line_items` rows
   - Hash all plaintext passwords with bcrypt
   - Validate row counts match
2. Replace `readData()`/`writeData()` with a `db` module (`pg` or Prisma)
3. Keep same Express routes — only storage layer changes
4. Swap local `/uploads/ci/` paths → S3 pre-signed URLs
5. Run JSON and PG side-by-side for 1 week (dual-write), then cut over

### Acceptance Criteria

- [ ] All existing pages load with identical data from PostgreSQL
- [ ] CRUD works for POs, line items, bookings, CI, shipments
- [ ] CI file storage migrated from local disk to S3
- [ ] Passwords hashed (bcrypt) — no plaintext in DB
- [ ] CI/CD pipeline deploys backend to ECS, runs migrations on deploy

---

## Phase Summary & Dependencies

```
JSON Phase (now):
  Step 1: line_items on POs
  Step 2: CI parser service
  Step 3: CI upload flow on Booking
  Step 4: Fulfillment view (computed shipped vs remaining)

Database Migration Phase (when JSON phase is stable):
  → Migrate to PostgreSQL + S3
  → No feature changes, identical API

PostgreSQL Phase:
  Step 5: Receiving records (warehouse input per SKU)
  Step 6: Reconciliation view (PO → CI → Received side-by-side)
  Step 7: Vendor discrepancy alerts
```

## Estimated Effort

| Phase | Scope | Estimate |
|---|---|---|
| JSON Phase (Steps 1–4) | line_items, CI parser, upload flow, fulfillment view | 1–2 weeks |
| DB Migration | AWS infra, PostgreSQL, S3, dual-write cutover | 1–2 weeks |
| PostgreSQL Phase (Steps 5–7) | Receiving, reconciliation, vendor alerts | 1 week |
| **Total** | | **~3–5 weeks** |

---

## Files to Create or Modify

### New Files (Backend)
- `backend/services/ciParser.js` — Excel CI parsing engine
- `backend/db/index.js` — PostgreSQL connection pool (migration phase)
- `backend/db/migrations/` — SQL migration files (migration phase)
- `backend/scripts/migrate-to-pg.js` — one-time JSON → PostgreSQL migration script

### New Files (Frontend)
- `src/components/purchase-orders/LineItemsTable.tsx` — reusable SKU table
- `src/components/bookings/CiPreviewTable.tsx` — parsed CI vs PO preview
- `src/components/bookings/CiUploadSection.tsx` — upload + parse + confirm flow

### Modified Files (Backend)
- `backend/server.js` — add line-items routes, CI parse/confirm routes, fulfillment endpoint

### Modified Files (Frontend)
- `src/components/purchase-orders/PoDetailDrawer.tsx` — add Line Items section + Fulfillment tab
- `src/components/bookings/BookingForm.tsx` — CI upload section
- `src/components/bookings/BookingDetailDrawer.tsx` — CI review for admin

---

## Open Questions

1. **NetSuite API access** — REST API available for pulling PO line items? Or CSV-only import?
2. **CI template variations** — Do all vendors use exactly the same Excel column layout, or are there per-vendor differences? (Affects column mapping config complexity.)
3. **Multi-currency** — Are CIs always USD, or do we need currency conversion?
4. **Unmatched SKU policy** — If CI contains a SKU not in the PO, should the system block confirmation or flag for manual review?
5. **Barcode/scan receiving** — Does the warehouse have scanners, or is manual entry sufficient?
6. **Password hashing** — Current users.json stores plaintext. Hash with bcrypt during DB migration.
