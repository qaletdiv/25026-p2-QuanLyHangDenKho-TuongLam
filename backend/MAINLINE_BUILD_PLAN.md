# Mainline Build Plan

Phased, file-by-file plan to build the mainline module on the redesigned schema.
SMS is deferred. Order: **shared PO layer → ingestion → transactional → frontend**.
Each phase ends in a runnable, verifiable state.

References: `database.dbml`, `SCHEMA_REDESIGN.md`, `MAINLINE_MODULE_STRUCTURE.md`,
`scripts/migrate-to-normalized.js` (already produces `data/migrated/*.json`).

> Storage note: stay on JSON-file models (`BaseModel`) for now; the redesign targets
> Aurora/Postgres later. Each phase is written so the model layer is the only thing
> that changes at DB cutover.

---

## Phase 0 — Cutover prep (1 step, no behavior change)

- [ ] Run `node scripts/migrate-to-normalized.js`; promote `data/migrated/*.json` to the
      live data dir behind a feature flag (keep old files until Phase 5 is green).
- [ ] Resolve the 1 dirty-data finding: supplier `"VEN1421 Power Wise Industries…"`
      (add alias map or clean `suppliers.json`).
- **Exit:** 15 normalized collections in place; integrity check passes (0 orphans).

## Phase 1 — Shared PO hierarchy (read path first)

Build `modules/po/`. This is what SMS will later reuse, so get it right.

- [ ] `PoMasterModel.js` (po_masters), `PoOrderModel.js` (po_orders + po_order_lines)
- [ ] `poController.js` — `GET /purchase-orders` (list, derived lifecycle state),
      `GET /purchase-orders/:trn` (master → orders → order_lines → legs)
- [ ] `poOrderIntentController.js` — `GET /purchase-orders/:trn/order-intent`
      (`po_master_totals` view; the season-start "how much we'll order")
- [ ] `poRoutes.js`; mount in `server.js`
- **Exit:** PO pages render from normalized data; lifecycle state (`forecast`/`split`)
      computed live; order-intent view returns per-SKU totals.

## Phase 2 — Ingestion (the hard part: dual write paths + R1–R3)

### 2a. NetSuite sync → masters/orders (steps 1–2)  ✅
- [x] `modules/po/netsuiteSyncService.js` — consumes `integrationService.fetchNetSuitePOs`,
      pure `buildUpserts` folds NS POs into `po_masters`/`po_orders`/`po_order_lines`;
      enforces **R1** (skip locked-by-booking po_numbers; locked TRN master untouched).
      Degrades gracefully on bad/expired NS token (HTTP 200 + `fetch_error`, no mutation).
- [x] `modules/po/netsuiteSyncController.js` — `POST /po/sync/netsuite` (requireAdmin)
- [x] `modules/po/resolvers.js` — shared master-data name→id lookups

### 2b. WIP import → legs (step 3)  ✅
- [x] `modules/mainline/legs/wipImportController.js` — `POST /mainline/wip-import`
      (requireAdmin, multipart). Reuses existing `services/wipParser.js`. Pure
      `upsertLegs` keyed on NK `(po_number, mode_id, crd)`, enforces **R3** (overwrite).
      **Ignores** WIP header fields (supplier/season/trn/warehouse) — NetSuite-owned —
      so there is no preserve-hack / `Mixed`-row splice.
- [x] `MainlineLegModel.js` (legs + leg lines, read+write)
- [x] `legReconciliationService.js` — **R2**: per `(po_number, sku)` Σ allocated vs ordered;
      run after every import, returned as `reconciliation.mismatches`
- [x] `modules/mainline/mainlineRoutes.js` mounted at `/mainline`
- **Exit ✅:** R1/R2/R3 unit-tested (pure cores) + verified live — injected NS PO upserts
      (1/1/1), bad token degrades, WIP route guards/validates; data intact (23 masters / 77 legs).
      NOTE: legacy `controllers/wipImportController.js` + `routes/wipImport.js` stay live for
      the old `/purchase-orders` path until Phase 6 cutover.

## Phase 3 — Mainline bookings + approval → shipments  ✅

- [x] `MainlineBookingModel.js` (mainline_bookings + mainline_booking_po_legs junction)
- [x] `mainlineBookingValidator.js` — leg-only: `po_legs[]` items require `leg_id`
- [x] `mainlineBookingController.js` — create → "Pending"; **leg-only guard** (rejects
      unknown leg_id → forecast PO unbookable); G1 vendor-match; G2 soft overbooking
      (leg capacity = Σ allocated_qty); `PUT /:id` + `POST /:id/approve` → create
      `mainline_shipments` (idempotent); delete → cascade shipment + junction rows
- [x] `mainlineBookingService.js` — pure helpers (legSupplierMap, checkVendorMatch,
      legCapacities, bookedUnitsByLeg, overbookWarnings) + enrich. **No `syncPoStatus`** —
      PO status is derived live now, never written back (design simplification).
- [x] `MainlineShipmentModel.js`, `mainlineShipmentController.js`
      (getAll/getOne/update/remove/bulkStatus), `mainlineShipmentValidator.js`
      (MAINLINE_SHIPMENT_STATUSES only), `mainlineShipmentService.js` (enrich via
      leg→order→master, **no courier/tracking**)
- [x] `modules/mainline/statuses.js` — mainline status vocab + name↔id helpers
- [x] routes added to `mainlineRoutes.js` (`/mainline/bookings*`, `/mainline/shipments*`)
- **Exit ✅:** verified end-to-end — leg-only guard (400), G1 mismatch (400), G2 overbook
      (409), create→Pending (201), approve→1 shipment, idempotent re-approve, shipment
      enriched (po/status/lot/qty), SMS status rejected on mainline (400), In-Transit
      update, delete cascades shipments. Data restored after test.

## Phase 4 — CI, packing, fulfillment, ASN  ✅

- [x] `ci/MainlineCiModel.js` + `ci/mainlineCiController.js` — `GET/POST /bookings/:id/ci`
      + `POST .../ci/confirm`; writes `mainline_commercial_invoices` + `_ci_line_items`
      (matched to `leg_id`; accepts `matched_po` → resolves to the booking's leg).
      Full xlsx upload reuses the shared `ciParser` at the route layer → same upsert.
- [x] `packing/MainlinePackingModel.js` + `packing/mainlinePackingController.js` —
      `GET /bookings/:id/packing` returns cartons + summary **computed as a view**
      (replaces stored `shipment_data.summary{}`)
- [x] `fulfillment/fulfillmentService.js` + controller — `GET /mainline/fulfillment/:trn`:
      three-way match ordered → allocated → shipped (received = 0 placeholder); only
      CONFIRMED CIs count; CI-coarser-than-PO SKU prefix grouping preserved
- [x] `asn/MainlineAsnModel.js` + `asn/mainlineAsnController.js` — `POST/GET /bookings/:id/asn`;
      gates on confirmed CI + e_del; reuses shared `asnService.generatePackingList` via a
      normalized→legacy shape adapter
- [x] `mainlineRoutes.js` mounts all `/mainline/*`
- **Exit ✅:** verified — fulfillment TRN_1259 (ordered 6420 = allocated 6420, shipped 1555);
      packing summary (24 cartons / 1555 pcs, matches CI); get confirmed CI (24 lines);
      ASN generated to /uploads; CI upsert→confirm raises shipped (+10); **draft CI excluded**
      from shipped (102→92). Data restored after test.

## Phase 5 — Frontend (mainline-only fork)

Per `SMS_MAINLINE_FRONTEND_AUDIT.md` (b). Leave SMS code untouched. New tree at
`src/modules/mainline/`.

### 5a. Data layer (foundation)  ✅
- [x] `src/modules/mainline/types.ts` — `PoMasterSummary/Detail`, `OrderIntent`,
      `MainlineBooking`, `MainlineShipment`, `CommercialInvoice`, `Fulfillment`,
      `PackingSummary`. **No `type` discriminator, no courier/tracking.** Mirror the
      verified backend responses.
- [x] `src/modules/mainline/actions.ts` — server actions for every new endpoint
      (`/po`, `/po/:trn`, `/po/:trn/order-intent`, `/po/sync/netsuite`,
      `/mainline/wip-import`, `/mainline/bookings*`, `/mainline/shipments*`,
      `…/ci`, `…/packing`, `…/asn`, `/mainline/fulfillment/:trn`). Matches the
      `fetchApi`+`revalidatePath`+`Array.isArray` conventions; surfaces 409 overbook.
- [x] Typechecked clean (`tsc --noEmit`, 0 errors in `src/modules/mainline`).

### 5b. UI components (building on the dev server)
- [x] **PO list page** `app/mainline/purchase-orders/page.tsx` (RSC) +
      `modules/mainline/components/PoMasterTable.tsx` (client) — reads `getPoMasters`,
      shows `lifecycle_state` badge, order-intent dialog (`getOrderIntent`), **"Book Now"
      gated on `bookable`**. VERIFIED on dev server (localhost:3000, backend :5000):
      HTTP 200, 23 TRN masters rendered with split badges, 23 Book Now + 23 Order-intent
      buttons, order-intent returns real per-SKU totals through the full stack.
- [x] **Bookings surface** `app/mainline/bookings/page.tsx` (RSC) +
      `modules/mainline/components/BookingsTable.tsx` (client) — list (booking #, supplier,
      legs, status), **New Booking** dialog (select bookable TRN → its leg → units →
      `createMainlineBooking`, with 409 overbook → "Book anyway"), per-row **Approve**
      (Pending only → `approveMainlineBooking`) + **Delete**. Leg-keyed, no `type==='sms'`.
      VERIFIED on dev server: page HTTP 200, both bookings render with Approved badges,
      New Booking dialog wired; create/approve/delete actions are the same flows proven
      end-to-end at the API layer in Phase 3.
- [x] **Shipments surface** `app/mainline/shipments/page.tsx` (RSC) +
      `modules/mainline/components/ShipmentsTable.tsx` (client) — tracking list
      (PO, TRN, supplier, warehouse, lot, expected qty, ETD POL, E-DEL) with inline
      status dropdown (mainline statuses only) → `updateMainlineShipment`. **No
      courier/tracking columns.** VERIFIED on dev server: HTTP 200, 3 enriched rows
      (PO04772/04784/04786, supplier/warehouse joined), status badges + dropdown wired.
- [x] (polish) **routes/nav** — `app/mainline/layout.tsx` + `MainlineSubNav.tsx`
      (Purchase Orders / Bookings / Shipments tabs, active highlighting, "normalized"
      badge); `app/mainline/page.tsx` redirects to `/mainline/purchase-orders`; Sidebar
      gains a **"Mainline (new)"** entry (`/mainline`, matchPrefix). VERIFIED: subnav on
      all 3 surfaces, index redirect lands on PO list, sidebar link renders.
- [x] **bugfix** — legacy PO detail navigated to flat `/purchase-orders/{id}`; now
      namespaced `/purchase-orders/{mainline,sms}/{id}` (new route files re-export the
      shared detail route; OrdersTable row-click + OrderDetail create-redirect repointed).
      VERIFIED: `/purchase-orders/mainline/1` renders PO04786.
- [x] **detail pages** — `app/mainline/purchase-orders/[trn]` + `PoMasterDetail.tsx`
      (header + **three-way match table** ordered/allocated/shipped/received/remaining with
      totals + warehouse-orders/legs breakdown); `app/mainline/bookings/[id]` +
      `BookingDetail.tsx` (legs, CI card + Confirm CI, packing summary, Generate ASN,
      Approve/links). PO TRN and booking # cells now link to their detail.
      VERIFIED: TRN_1259 detail renders three-way match (shipped 1555, total 6420);
      booking 1 detail renders legs + confirmed CI + packing.
- [x] **bug found & fixed during verification** — `/po/:trn` (getOne) didn't return
      `order_count/leg_count/total_ordered_qty` (only the list did), so the detail crashed
      on `total_ordered_qty.toLocaleString()`. Fixed: getOne now returns the same rollups
      as getAll (one shared `PoMasterSummary` shape) + defensive guard in the component.
- [n/a] `columns.ts` split — the new `/mainline/*` tables use bespoke columns (no
      courier/tracking), so there's no shared legacy `columns.ts` to split for this module.

**Phase 5 COMPLETE** — mainline UI built, navigable, and verified end-to-end on the dev
server (PO list + master detail, bookings list + detail w/ approve/CI/ASN, shipments list
w/ status). Remaining program work: **Phase 6 cutover**.
- **Exit (core ✅):** the three primary mainline surfaces — PO list, bookings, shipments —
      are built and verified rendering real normalized data end-to-end on the dev server.
      Remaining items are detail-page/nav polish, foldable into Phase 6 cutover.

## Phase 6 — Cutover (PROMOTE mainline, keep legacy for SMS)

**Scope decision:** a *full* legacy retirement is blocked because SMS still lives in the
shared legacy code + data files. Chosen approach: **promote the new mainline module to
canonical; keep legacy mounted for SMS; delete nothing.** Reversible.

### 6a — Promote (DONE ✅)
- [x] Sidebar repointed: **Purchase Orders / Bookings / Shipments** → `/mainline/*`
      (was legacy `/{purchase-orders,bookings,shipments}/mainline`). "Mainline (new)"
      staging entry removed.
- [x] SMS kept reachable: **SMS Bookings** → `/bookings/sms`, **SMS Shipments** →
      `/shipments/sms` (legacy, still 200).
- [x] Post-login landing repointed (`login/page.tsx` + `middleware.ts`) → `/mainline/shipments`.
- [x] `/mainline` layout sub-nav removed (redundant with sidebar); `MainlineSubNav.tsx` deleted.
- [x] `CLAUDE.md` updated with a top "MAINLINE NORMALIZED MODULE — CUTOVER STATE" section.
- **Verified:** sidebar shows new hrefs, login → `/mainline/shipments`, legacy SMS 200,
      typecheck clean.

### 6a.1 — Operational entry points (DONE ✅)
- [x] `PoMasterTable` toolbar (admin-only): **NetSuite Sync** → `syncNetSuite()` →
      `POST /po/sync/netsuite` (upserts masters/orders/lines, R1; toast shows counts or
      `fetch_error`); **Upload WIP** → file picker → `importWip()` → `POST /mainline/wip-import`
      (upserts legs + lines, R3; toast shows added/updated + R2 mismatch count). Both
      `router.refresh()` on success. VERIFIED: buttons render for admin, sync responds.
- NOTE: live NetSuite sync needs a valid `NETSUITE_*` token in `backend/.env` (sandbox
  token currently returns "Invalid login attempt"). WIP upload has no external dependency.
- [x] **WIP bootstrap fallback** — when NetSuite is unavailable, the upstream hierarchy
      would be empty and the PO list blank (and R2 flags every SKU). Fix: `wipImportController`
      now bootstraps `po_masters`/`po_orders`/`po_order_lines` from the WIP itself **when
      missing only** (order_lines = Σ leg allocations per sku). NetSuite stays authority
      when present (never overwritten). VERIFIED: re-import → 24 masters / 62 orders / 9317
      order-lines bootstrapped, **reconciliation 9317 → 0**, /po populated (262,491 units).
      Caveat: ~25 unresolved master-data name warnings (e.g. `VEN1421 …` supplier prefix) —
      fields land null; clean supplier/warehouse/season master lists to resolve.

### 6b — Retire legacy (DEFERRED until SMS is migrated)
- [ ] Remove dead mainline branches from old shared controllers/validators
- [ ] Filter mainline rows out of (or retire) flat `purchase-orders.json` /
      `bookings.json` / `shipments.json` — **blocked: shared with SMS**
- [ ] Delete the legacy `Mixed`-row WIP importer
- **Exit (6b):** legacy fully retired — only after the SMS module exists.

---

## Sequencing notes

- **Phases 1–2 are the foundation** — everything downstream depends on the PO hierarchy
  and ingestion. Spend the care here.
- **Phase 2b deletes the most fragile legacy code** (the WIP `Mixed`-row splice). That's
  the single biggest correctness win.
- **Frontend (5) can start in parallel once Phase 1's read API is stable** — it doesn't
  need ingestion to render PO/booking pages against migrated data.
- **SMS module** begins only after Phase 6, reusing the proven shared PO layer + kernel.
