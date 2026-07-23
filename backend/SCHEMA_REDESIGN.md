# tentree Supply Chain Portal — Schema Redesign (JSON → Aurora PostgreSQL)

Database-architect audit + 3NF target design. All field names below are the **real**
keys observed in `backend/data/*.json` (sampled with node, not invented).

> **Scope: MAINLINE ONLY.** SMS is a totally separate module and is intentionally
> out of scope here — it gets its own table family in a later pass. Mainline and SMS
> share **no transactional tables**; the old `type: "sms" | "mainline"` discriminator
> is removed (table membership replaces it). Only reference/master data and the
> upstream PO hierarchy will be shared once SMS is added.
>
> The companion `backend/database.dbml` is the source of truth for the table shapes;
> this document explains the audit, the decisions, and the migration.

---

## 0. Data inventory (what was actually read)

| File | Rows | Notes |
|------|------|-------|
| `purchase-orders.json` | **82** PO-leg rows | 67 distinct `po_number`, **28 distinct `trn_number`**. 15 `po_number`s repeat. Every row has `line_items[]`. |
| `bookings.json` | 3 (2 mainline, 1 sms) | nested `po_details[]`, `commercial_invoice{}`, `shipment_data{rows[],summary{}}` |
| `shipments.json` | 4 (3 mainline, 1 sms) | ~35 cols, ~20 copied from booking/PO |
| `asns.json` | 2 | `po_numbers[]` array, `file_url` |
| `suppliers.json` | 13 | id, name, country, address, port_of_loading |
| `warehouses.json` | 6 | id, name, country, city, email, address, port_of_discharge |
| `couriers.json` | 6 | id, name (SMS-leaning lookup) |
| `incoterms.json` | 5 | id, name |
| `modes.json` | 3 | Sea FCL / Air / Courier |
| `statuses.json` | 7 | id, name, color |
| `contacts.json` | 4 | id, name, email, company, role, group |
| `users.json` | 5 | id, email, password, name, role, supplier? |
| `roles.json` | 5 | id, name, description, protected, permissions[] |

### The PO identity — verified on live data

The three-step mainline process produces three nested grains:

```
28 TRNs   →   67 po_numbers   →   82 legs
(masters)     (warehouse split)   (air/sea split)
```

Natural-key collision test (node, against the 82 rows):

| Candidate key | Collisions |
|---|---|
| `po_number` | 15 ❌ |
| `po_number + mode` | 5 ❌ |
| **`po_number + mode + crd`** | **0 ✅** |

So `(po_number, mode, crd)` is a **provably unique natural key** at the leg grain, and
the 5 same-mode "duplicates" (e.g. `PO04783` twice as Sea FCL) are **real CRD waves,
not dirty data**. `trn_number` is unique at the master grain (28); `po_number` is
unique at the warehouse grain (67).

> Note: the 77→82 row growth vs the old CLAUDE.md note is **data growth**, not a model
> change. The `_backup_2026-06-22T02:22` snapshot had 77 legs / 23 TRNs; the live file
> now has 82 legs / 28 TRNs (5 new master POs imported since). Row count is a property
> of the data, not of the key strategy.

---

## 1. Normalization Audit (current JSON)

### 1.1 `bookings.json`

| # | Violation | NF | Concrete evidence |
|---|-----------|----|-------------------|
| B1 | **Repeating group `po_details[]`** nested in the row | 1NF | `[{po_id:"24",po_number:"PO04772",units,cartons,weight,cbm}, …]` |
| B2 | **Repeating group `commercial_invoice.line_items[]`** | 1NF | 24-element array of SKU rows |
| B3 | **Repeating group `shipment_data.rows[]`** — packing list embedded in the booking | 1NF | 24 carton rows |
| B4 | **Pre-aggregated `shipment_data.summary{}`** stored alongside the rows it sums | 3NF (derived) | 100% computable from `rows[]` |
| B5 | **Denormalized `tentree_po_number`** `"PO04772, PO04784"` duplicates the junction | 2NF/3NF | comma-joined display copy |
| B6 | **Transitive master labels** copied onto the booking: `supplier`/`vendor_name`, `season`, `trn_number`, `incoterm`, `mode`, `receiving_warehouse` | 3NF | depend on supplier/PO, not the booking key |
| B7 | `po_details` rows have **blank string-typed numerics** (`units:""`, `cartons:""`) | type hygiene | |
| B8 | `vendor_name` and `supplier` are the **same fact stored twice** | 2NF | |

### 1.2 `purchase-orders.json` (PO *legs*)

| # | Violation | NF | Evidence |
|---|-----------|----|----------|
| P1 | **Repeating group `line_items[]`** nested in the row | 1NF | 30 items each with sku/qty/price |
| P2 | **Booking labels denormalized onto PO**: `booking_status`, `booking_number` | 3NF | owned by the booking |
| P3 | **`po_number` non-unique used as a key** | integrity | 15 dup numbers; real key is the grain (TRN / po_number / leg NK) |
| P4 | **Transitive supplier facts**: `supplier`, `coo` repeat the supplier's country on every row | 3NF | mirrors `suppliers[].country` |
| P5 | **Transitive master facts repeated per leg**: `supplier`, `season`, `trn_number`, `main_shoulder` copied onto all 82 legs | 3NF | `trn → {supplier, season, main_shoulder}` — factor to `po_masters` |
| P6 | **Mixed concerns / derived dates**: `etd`, `eta_pod`, `cargo_received_date` are shipment-derived but stored on the PO | 3NF (derived) | many blank/overridden live |
| P7 | `line_items[]` shape is **inconsistent** (`size`/`color` vs `style_color`/`colorway`/`item_name`) | 1NF | sparse optional keys |

### 1.3 `shipments.json` — the worst offender

| # | Violation | NF | Evidence |
|---|-----------|----|----------|
| S1 | **~20 columns copied from booking + PO** | 3NF | `supplier, trn_number, season, coo, incoterm, mode, vendor_name, courier, receiving_warehouse, booking_status, booking_number, tentree_po_number, …` |
| S2 | **Two parallel quantity columns**: `expected_qty` vs `expected_quantity` (different values) | 1NF/3NF | row id `…14`: 328 vs 200 |
| S3 | **Two parallel status columns**: `booking_status` vs `status` | 3NF | both present, different meanings |
| S4 | **`tentree_po_number` + `po_number` + `po_id`** all on one row | 2NF | |
| S5 | `vendor_name == supplier` again | 2NF | |
| S6 | **Inconsistent row shape** — sparse columns prove two record types in one table | 1NF | |
| S7 | `lot_number` mixes `1`/`null`; `number_of_cartons` is a string | type hygiene | |

### 1.4 `asns.json`

| # | Violation | NF | Evidence |
|---|-----------|----|----------|
| A1 | **Repeating group `po_numbers[]`** | 1NF | `["PO04786"]` |
| A2 | Denormalized `tentree_po_number`, `booking_number`, `supplier` | 3NF | |

### 1.5 Master data — minor issues

- `statuses.json` mixes booking + shipment vocab in one flat list with no `category` → add `module` + `category`.
- `roles.permissions[]` is a repeating group → flatten to `role_permissions`.
- `users.role` / `contacts.role` are free-text, not FKs.

---

## 2. The mainline PO lifecycle (why the hierarchy exists)

Mainline POs are NOT created by a single WIP upload. They flow through three steps,
two of which are NetSuite-sourced:

| Step | System | Creates | mode | warehouse | grain |
|---|---|---|---|---|---|
| 1. Master PO | **NetSuite** → sync | one master order | Sea (default) | NRI CA First (default) | `po_masters` (TRN) |
| 2. Warehouse split | **NetSuite** → sync | **more po_numbers**, one per warehouse | still Sea | the real warehouse | `po_orders` (po_number) |
| 3. Air/sea split | **WIP upload** (NetSuite can't) | air & sea legs of a po_number | Air + Sea | inherited | `mainline_po_legs` (NK) |

**Key consequence — `po_number` is unique at the header grain.** The non-uniqueness
appears only at step 3 (air/sea keeps the same number). The old rule *"only the
surrogate `id` is unique"* was an artifact of collapsing all three grains into one flat
table; separated, each grain has a natural key (`trn_number` / `po_number` /
`(po_number, mode, crd)`).

### Two write paths — clean field ownership (no preserve-hack)

```
NetSuite sync  →  writes po_masters, po_orders, po_order_lines   (never legs)
WIP import     →  writes mainline_po_legs, mainline_po_leg_lines (never master/order)
```

Because the two writers touch **different tables**, a NetSuite re-sync cannot clobber a
WIP air/sea leg and a WIP import cannot clobber NetSuite header fields. The legacy
`wipImportController` "preserve portal fields / splice Mixed rows" logic disappears.

### Ingestion business rules (backend policy)

- **R1.** A NetSuite re-sync MAY overwrite a `po_orders`/`po_masters` row only when **no
  booking or shipment** references its legs (e.g. qty 10→20 is fine while unbooked). If
  a linked booking/shipment exists, **protect** the row.
- **R2.** If a NetSuite total conflicts with the sum of WIP leg allocations,
  **flag for review** (never auto-resolve).
- **R3.** WIP import **always overwrites/updates** legs — the importer is the source of
  truth for the air/sea split.

---

## 3. New Schema (3NF, mainline only) — table map

```
SHARED REFERENCE          PURCHASE ORDERS (shared)    MAINLINE MODULE
─────────────────         ───────────────────────     ─────────────────
suppliers                 po_masters    (TRN)         mainline_po_legs        (NK po_number,mode,crd)
warehouses                po_orders     (po_number)   mainline_po_leg_lines
modes / incoterms         po_order_lines              mainline_bookings
statuses (+module)                                    mainline_booking_po_legs (junction)
seasons                                               mainline_commercial_invoices
product_skus (SKU master)                             mainline_ci_line_items
couriers (SMS-leaning)                                mainline_packing_cartons
                                                       mainline_shipments
IDENTITY / ACCESS                                      mainline_asns
─────────────────
users / roles / role_permissions
contacts

SMS MODULE — out of scope (separate later pass)
```

Key fixes baked in (cross-referenced to the audit):

- **`po_masters` keyed on `trn_number`** — the stable master identity (resolves P5: supplier/season/main_shoulder stored once per TRN, not per leg).
- **`po_orders` keyed on `po_number`** — genuinely unique at the warehouse grain; `receiving_warehouse` lives here (decided at step 2, before air/sea).
- **`mainline_po_legs`** — surrogate `id` PK kept purely as a convenient FK target; the real key is `UNIQUE (po_number, mode_id, crd)` (resolves P3).
- **`po_order_lines` (NetSuite) vs `mainline_po_leg_lines` (WIP)** — per-SKU ordered qty vs per-SKU air/sea allocation; they reconcile (R2). Resolves P1/P7 via the shared `product_skus` master.
- **`mainline_booking_po_legs`** junction replaces nested `po_details[]`, keyed on `leg_id` (resolves B1/B5/S4).
- **`mainline_ci_line_items`** + **`mainline_packing_cartons`** extract the nested CI and packing rows (resolves B2/B3); the `summary{}` becomes a view (resolves B4).
- **`mainline_shipments`** holds only shipment-owned fields; supplier/season/incoterm/etc. are joined (resolves S1/S5). Two-column qty/status collapsed to one each (resolves S2/S3).
- **`role_permissions`** flattens `permissions[]` (resolves 1.5).

Bookings/CI/shipments attach at the **leg** grain. Fulfillment rolls up the whole
chain: shipped (CI) → leg allocation → ordered (warehouse) → TRN total.

---

## 4. Migration mapping (new table ← current JSON)

| New table | Source JSON / field | Owner going forward |
|-----------|---------------------|---------------------|
| `suppliers` / `warehouses` / `modes` / `incoterms` / `couriers` | same-named files (`coo` → `suppliers.country`) | master data |
| `seasons` | distinct `season` strings | master data |
| `statuses` | `statuses.json` + derived `module`/`category` | master data |
| `product_skus` | DISTINCT SKUs unioned from `po.line_items[]` + `booking.shipment_data.rows[]` + `ci.line_items[]` | master data |
| `po_masters` | DISTINCT `trn_number` from `purchase-orders.json` (+ supplier, season, main_shoulder) | NetSuite sync |
| `po_orders` | DISTINCT `po_number` (+ receiving_warehouse), grouped under its TRN | NetSuite sync |
| `po_order_lines` | `po.line_items[]` rolled to the warehouse grain | NetSuite sync |
| `mainline_po_legs` | `purchase-orders.json` rows where `type==='mainline'` (one per `po_number+mode+crd`) | WIP import |
| `mainline_po_leg_lines` | `po.line_items[]` of each mainline leg | WIP import |
| `mainline_bookings` | `bookings.json` where `type==='mainline'` | portal |
| `mainline_booking_po_legs` | `booking.po_details[]` (keyed on `po_id` → `leg_id`) | portal |
| `mainline_commercial_invoices` (+ `_ci_line_items`) | `booking.commercial_invoice` + `.line_items[]` (mainline) | portal |
| `mainline_packing_cartons` | `booking.shipment_data.rows[]` (mainline) | portal |
| `mainline_shipments` | `shipments.json` where `type==='mainline'` | portal |
| `mainline_asns` | `asns.json` (mainline bookings) | portal |
| `users` | `users.json` (role string → `role_id`) | shared |
| `roles` + `role_permissions` | `roles.json` (+ flatten `permissions[]`) | shared |
| `contacts` | `contacts.json` | shared |
| *(all `sms`-typed rows)* | **deferred** — SMS module is a later pass | — |

Migration must also normalize the dirty data found in the audit: mode casing
(`Air` vs `AIR`), `vendor_name`↔`supplier` drift (resolve against `suppliers`), and
string-typed numerics. The 5 same-mode legs carry distinct CRDs, so the
`(po_number, mode, crd)` key migrates them cleanly — any fallback to `po_number`
alone would mis-merge them.

---

## 5. Derived views (never stored)

Per the "never store derived data" rule, these are computed live (mirrored in the dbml):

- `po_master_totals` — `SUM(po_order_lines.ordered_qty)` per TRN & SKU → the season-start "how much we'll order" forecast.
- `po_lifecycle_state` — `forecast` (no legs) vs `split` (has legs), derived from presence of `mainline_po_legs` rows.
- `leg_reconciliation` — per `(po_number, sku)`: `ordered_qty` vs `Σ allocated_qty` → drives R2 "flag for review".
- `mainline_packing_summary` — `SUM(pcs, total_usd, weights, cbm)` per booking → replaces `shipment_data.summary{}`.
- `po_fulfillment` — `ordered_qty − Σ confirmed CI qty` per SKU → the `/fulfillment` endpoint.
- `po_logistics_dates` — earliest/latest ACTUAL shipment dates per leg → overrides the WIP planned dates at read-time.

---

## 6. Status of earlier open questions

| # | Question | Resolution |
|---|----------|-----------|
| 1 | PO header grain | **Resolved** — `po_masters` keyed on **TRN** (not `po_number`); TRN is the stable master id that survives all splits. |
| 2 | Is a PO permanently mainline-or-sms? | **Deferred with SMS.** Mainline-only for now; PO masters/orders are shared upstream, legs are per-module. |
| 3 | "No shared functions" strictness | Schema is split at the table level. Service-layer split (CI parser, NetSuite) is a backend call, tracked in `SMS_MAINLINE_BACKEND_AUDIT.md`. |
| 4 | `expected_qty` vs `expected_quantity` | Shipment keeps one `expected_quantity` (booking allocation); per-SKU truth lives in `*_leg_lines` / CI. |
| 5 | Same-mode duplicate legs | **Resolved** — they are real CRD waves; `(po_number, mode, crd)` is unique (0 collisions). |
| 6 | Source of mainline POs | **Resolved** — NetSuite for steps 1–2 (master + warehouse split), WIP for step 3 (air/sea). Two write paths, clean ownership. |
| 7 | Bookable grain | **Resolved — LEG ONLY.** A PO is bookable only after step 3 (air/sea split). `mainline_booking_po_legs` FKs to `mainline_po_legs` (never to `po_orders`/`po_masters`), so a forecast/warehouse-only PO with no legs is unbookable. Bookable iff `po_lifecycle_state = split`. |
| 8 | Forecast wiring | **Resolved — KEEP SEPARATE.** The existing `/forecast` (`reportController.getForecast`) is a *shipment-arrival-by-week* report (buckets shipments+POs by ISO week off `etd_pol`/`e_del`). The step-1 master "how much we'll order" is per-SKU **order intent** with no dates — it is the `po_master_totals` view at `po_lifecycle_state = forecast`, surfaced on the **Purchase Orders** module (an unsplit-PO state/filter), NOT on `/forecast`. To avoid the name clash, call the step-1 view *order intent*, not *forecast*. |

### Still open (for the team lead)

1. **SMS module** — entire `sms_*` family deferred to a later pass; its PO origin (WIP vs in-portal vs NetSuite) is undecided.
