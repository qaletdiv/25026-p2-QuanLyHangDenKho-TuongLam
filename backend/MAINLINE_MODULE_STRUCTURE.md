# Mainline Backend Module Structure

Target backend layout for the **mainline module** under the redesigned schema
(`backend/database.dbml`, `backend/SCHEMA_REDESIGN.md`). Mainline only — SMS is a
separate later pass. Keeps the existing MVC layering (controller / service / model /
validator / route) but reorganizes flat files into a self-contained module tree, with
the shared PO hierarchy sitting above it.

> Decisions encoded here: TRN→po_number→leg PO hierarchy; two write paths (NetSuite vs
> WIP) with table-level ownership; ingestion rules R1 (protect-if-booked), R2
> (flag-on-conflict), R3 (WIP-overwrites); **leg-only booking**; forecast = order-intent
> view distinct from the existing `/forecast` page.

---

## Directory layout (target)

```
backend/
  modules/
    po/                       ← SHARED upstream PO hierarchy (NetSuite-owned, module-agnostic)
      PoMasterModel.js          po_masters (TRN)
      PoOrderModel.js           po_orders (po_number) + po_order_lines
      poController.js           GET /purchase-orders (list + detail across grains, lifecycle state)
      poOrderIntentController.js GET .../order-intent → po_master_totals view (forecast/order-intent)
      netsuiteSyncController.js  POST /integrations/netsuite/pos → upsert masters/orders/lines
      netsuiteSyncService.js     SuiteQL fetch + upsert + R1 guard (protect-if-booked)
      poValidator.js
      poRoutes.js

    mainline/                 ← MAINLINE transactional module (owns everything below)
      legs/
        MainlineLegModel.js        mainline_po_legs + mainline_po_leg_lines
        wipImportController.js     POST /mainline/wip-import → upsert legs (R3)
        wipParser.js               parse WIP xlsx  (moved from services/)
        legReconciliationService.js  ordered vs Σ allocated → flag (R2)
        mainlineLegValidator.js
      bookings/
        MainlineBookingModel.js    mainline_bookings + mainline_booking_po_legs (junction)
        mainlineBookingController.js  create→Pending; approve→shipments; leg-only guard
        mainlineBookingService.js     syncPoStatus / recalc / enrich (mainline-scoped)
        mainlineBookingValidator.js
      ci/
        MainlineCiModel.js         mainline_commercial_invoices + mainline_ci_line_items
        mainlineCiController.js     parse/confirm  (uses shared ciParser/ciGenerator)
      shipments/
        MainlineShipmentModel.js   mainline_shipments
        mainlineShipmentController.js   getAll/getOne/update/remove/bulkStatus
        mainlineShipmentService.js      enrich via leg→order→master (NO courier)
        mainlineShipmentValidator.js    MAINLINE_STATUSES only
      packing/
        MainlinePackingModel.js    mainline_packing_cartons (+ packing_summary view)
      fulfillment/
        fulfillmentService.js      ordered → allocated → shipped (the three-way match)
      asn/
        mainlineAsnController.js
      mainlineRoutes.js            mounts all /mainline/* subroutes

  shared/                     ← KERNEL (reused as-is; not duplicated per module)
    middleware/  auth, requireAdmin, validate, upload, errorHandler
    utils/       passwordUtils
    services/    driveStorage, ciParser, ciGenerator, plGenerator, lotService
    masterData/  master-data controller/model/routes (warehouses, suppliers, modes, …)
    identity/    auth, users, roles, contacts
```

---

## Endpoint map

| Method | Path | Module | Writes/Reads |
|---|---|---|---|
| GET | `/purchase-orders` | po (shared) | list masters+orders, derived lifecycle state |
| GET | `/purchase-orders/:trn` | po | master detail → orders → order_lines → legs |
| GET | `/purchase-orders/:trn/order-intent` | po | `po_master_totals` view (forecast state) |
| POST | `/integrations/netsuite/pos` | po | **NetSuite write path** → masters/orders/lines (**R1**) |
| POST | `/mainline/wip-import` | mainline/legs | **WIP write path** → legs + leg_lines (**R3**), runs **R2** |
| GET | `/mainline/legs` · `/:id` | mainline/legs | leg list/detail |
| GET·POST·PUT·DELETE | `/mainline/bookings` · `/:id` | mainline/bookings | leg-only booking CRUD |
| POST | `/mainline/bookings/:id/approve` | mainline/bookings | create `mainline_shipments` |
| POST | `/mainline/commercial-invoices/parse` · `/confirm` | mainline/ci | CI upload/confirm |
| GET·PUT | `/mainline/shipments` · `/:id` · `/bulk-status` | mainline/shipments | shipment tracking |
| GET | `/mainline/fulfillment/:trn` | mainline/fulfillment | three-way match |
| POST | `/mainline/asn` | mainline/asn | ASN generation |

---

## The two write paths (the core of the design)

```
                ┌─────────────── NetSuite sync ───────────────┐
  Steps 1–2 →   │ netsuiteSyncController → PoMasterModel       │  R1: skip/protect a row
                │                          PoOrderModel        │      if its legs are booked
                └─────────────────────────────────────────────┘
                ┌─────────────── WIP upload ──────────────────┐
  Step 3   →    │ wipImportController → wipParser              │  R3: always overwrite legs
                │                       MainlineLegModel       │  R2: legReconciliationService
                │                       (legs + leg_lines)     │      flags ordered≠allocated
                └─────────────────────────────────────────────┘
  Different tables ⇒ neither writer clobbers the other ⇒ no preserve-hack.
```

---

## Read / derive (nothing stored)

`fulfillmentService` and the lifecycle/reconciliation views compute live:

```
ordered (po_order_lines) → allocated (mainline_po_leg_lines) → shipped (mainline_ci_line_items, confirmed)
po_lifecycle_state = legs exist ? "split"(bookable) : "forecast"(order-intent only)
```

---

## How today's files map in

| Today | Becomes |
|---|---|
| `purchaseOrderController.js` (split rows + enrich) | `po/poController.js` (masters/orders) + `mainline/legs` |
| `wipImportController.js` + `services/wipParser.js` | `mainline/legs/*` (drops the `Mixed`-row splice) |
| `integrationController.js` + `services/integrationService.js` | `po/netsuiteSync*` |
| `bookingController.js` (the `if type==='sms'` fork) | `mainline/bookings/*` (SMS branch deleted, becomes future `sms/` seed) |
| `shipmentController.js` + `services/shipmentService.js` | `mainline/shipments/*` |
| `commercialInvoiceController.js` | `mainline/ci/*` |
| `validators/{booking,shipment,purchaseOrder}.js` | per-module validators (status enums no longer unioned) |
| `bookingService.js` (`syncPoStatus`/`recalc`) | `mainline/bookings/mainlineBookingService.js` |

---

## Open knob

The PO masters/orders go in a **shared `modules/po/`** rather than inside mainline —
they're NetSuite-fed and module-agnostic, so SMS can later reuse them without an
extraction. Only the **legs** (and everything downstream) are mainline-owned. If you'd
rather keep PO fully inside mainline for now and split it out when SMS arrives, that's
the one knob to flip.
