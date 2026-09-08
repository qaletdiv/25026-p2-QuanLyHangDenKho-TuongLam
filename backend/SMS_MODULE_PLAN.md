# SMS Module — Schema & Build Plan (draft 2026-07-01, NetSuite/FedEx answers 2026-07-02)

> ⚠️ **SUPERSEDED IN ONE RESPECT (2026-08-07): SMS now has an OPTIONAL booking step.**
> Everywhere below that says the SMS workflow has "no booking" describes the DEFAULT
> path, which is unchanged — the vendor still enters most consignments directly after
> handing boxes to the courier. A consignment planned up front now goes through
> `sms_bookings` / `sms_booking_pos` instead: Vendor submits → Logistics approves →
> approval creates one DRAFT shipment per destination facility, and that shipment
> carries a customs entry number plus ACTUAL freight/duty off the broker bill
> (mainline behaviour, no rate). See **SMS_BOOKING_BUILD_PLAN.md** for the schema,
> guards, landed-cost basis rule and verification.

## NetSuite field mapping (CONFIRMED — from Lam, 2026-07-02)

SMS POs come from the same NetSuite transaction table; the discriminator is a
custom body field. Extend the existing SuiteQL sync with:

| Portal concept | NetSuite field | Notes |
|---|---|---|
| SMS discriminator | `custbody_tt_po_type` = **'smm'** | tags `po_orders.ship_via='sms'` |
| PO# | `tranid` | same as mainline |
| tentree PO# (master, like TRN) | `custbody_tentree_po` | joins into `po_masters.trn_number` |
| Vendor | `entity` | → suppliers |
| HOD — handover date (the SMS "CRD") | `custbody8` | when vendor must hand cargo to courier |
| Shipping method | `custbody16` | expect FedEx/DHL values → couriers |
| Season | `custbody7` | → seasons |
| Approval status | `approvalstatus` | only approved POs enter the portal (TBC) |
| Location | `location` | → warehouse_facilities mapping |
| SKU lines | transaction lines (InvtPart) | same shape as mainline line-items query |

## FedEx integration (CONFIRMED — sandbox credentials exist)

- Credentials: `FEDEX_CLIENT_ID` / `FEDEX_CLIENT_SECRET` / `FEDEX_IS_SANDBOX`
  currently in `frontend/tentree-scportal/.env.local` — **move to `backend/.env`**
  at phase 5 (tracking polls are a backend cron concern, and secrets don't
  belong in the frontend env).
- API doc: `frontend/FedEx_API_Tracking_ETA_Instructions.txt` — OAuth 2.0 bearer,
  `POST https://apis.fedex.com/track/v1/trackingnumbers`, **max 30 tracking
  numbers per request** (batch the poll), `includeDetailedScans: true` gives the
  scan events for `sms_tracking_events`; `estimatedDeliveryTimeWindow` gives an
  ETA (the SMS analogue of E-DEL — derived from courier data, never stored).
- DHL: no credentials yet — DHL shipments run on `manual_status_id` until then.

SMS = small shipments fulfilled by **courier** (FedEx/DHL on tentree's account).
The workflow is fundamentally different from mainline, so the module is NOT a
copy of it — several mainline concepts simply don't exist here:

| Mainline | SMS |
|---|---|
| Vendor submits a **booking**, logistics approves | **No booking step** — vendor ships directly on tentree's FedEx/DHL account |
| WIP file splits POs into air/sea **legs** | No legs — the PO ships as-is, in **2–3 partial shipments (lots)** |
| Status = internal pipeline (Ready to Ship → … → Received) | Status = **courier tracking state** (FedEx/DHL), integrated |
| Received = manual ATA (NetSuite later) | Received = warehouse check vs **NetSuite Item Receipt (IR)** pull |
| Forwarder edits shared logistics dates | Courier owns all transit facts — we only read them |

## Does the legacy stack already do this? (audit)

Mostly **no** — legacy SMS is a manual tracker shaped like a booking:

- One flat row conflates booking + shipment (`booking_number: "BKG-2865"` on an
  SMS row — a booking that never happened). Names stored instead of ids
  (`courier: "DHL"`, `receiving_warehouse: "NRI US First Inventory"` — the
  conflated facility+channel string mainline already decomposed).
- ✅ `lot_number` exists — the multi-shipment-per-PO idea is already there.
- ✅ `tracking_number` field exists in the form (`SmsShipmentForm`).
- ❌ Status is a **manual dropdown**, not courier state; no FedEx/DHL integration.
- ❌ No SKU lines per shipment — can't say *what* was in lot 2 of 3.
- ❌ No receiving flow — nothing compares shipped qty vs NetSuite IR.
- ❌ Duplicated PO facts copied onto the shipment row (supplier, season, TRN,
  netsuite_id) instead of joined — the 3NF violations mainline eliminated.

So legacy is a usable stopgap for *tracking by hand*, but the described
workflow (NetSuite-first, lots with contents, courier-status integration, IR
reconciliation) needs the normalized rebuild.

## Schema (3NF, additions to database.dbml)

> **⚠ SEPARATION DECISION (2026-07-02, supersedes the draft below): SMS is a
> fully separate dataset.** SMS has its OWN PO tables — `sms_pos` (tranid PK,
> trn/supplier/season/hod/ship_method/approval_status/facility) + `sms_po_lines`
> — and shares NO transactional tables with mainline. The `ship_via`/`hod`
> discriminator on shared `po_orders` was built, then REMOVED same day.
> Shared = reference/master data only (suppliers, seasons, facilities,
> statuses, couriers, product_skus). Source-of-truth split: **mainline POs ←
> WIP import** (the mainline NS sync stays but DEACTIVATED — button visible,
> disabled); **the SMS module gets its OWN NetSuite sync button** (custbody_tt_
> po_type='smm' → sms_pos) — two unrelated syncs, one per module. The UI
> may show mainline|sms sub-tabs in one section, but each tab is backed by its
> own module + dataset. **database.dbml is authoritative.** Other refinements
> that superseded the draft: `units`+`cartons` on `sms_shipment_pos` (vendors
> enter PO totals), `sms_shipment_lines` dropped, header totals derived.

REUSED as-is (shared, already normalized + NetSuite-synced): `po_masters`,
`po_orders`, `po_order_lines`, `product_skus`, `suppliers`, `seasons`,
`warehouse_facilities`, `allocation_channels`, `statuses`, couriers master data.
Production "pulls from NetSuite first" = the existing `/po/sync/netsuite` path;
SMS POs enter the same PO hierarchy, they just never get WIP legs.

```dbml
// ---- SMS discriminator + HOD on the shared PO ----
// How a PO is fulfilled is a fact about the ORDER (not a new table):
//   po_orders.ship_via  varchar  // 'mainline' (default) | 'sms' — from custbody_tt_po_type='smm'
//   po_orders.hod       date     // handover date (the SMS "CRD") — from custbody8;
//                                // NULL for mainline (whose CRD lives on the legs)
// Mainline code ignores both columns — zero impact.

// ---- one courier shipment = ONE physical consignment (one tracking number) ----
// CONFIRMED: a FedEx shipment sometimes carries MORE than one PO → the
// shipment↔PO link is a junction, mirroring mainline's shipment↔leg pattern.
// Shared courier facts (tracking#, dates, destination) live once on the header.
Table sms_shipments {
  id              varchar [pk]
  courier_id      varchar [not null]        // → couriers (FedEx / DHL)
  tracking_number varchar [unique]          // the courier's key; integration joins on it
  ship_date       date
  cartons         integer                   // physical consignment total
  facility_id     varchar [ref: > warehouse_facilities.id]  // destination
  manual_status_id varchar                  // fallback while courier API not connected;
                                            // NULL once tracking events flow (derived wins)
  created_at      timestamp
}

// ---- junction: which PO-lots the consignment carries ----
// lot_number counts per PO ("1 PO ships as 2–3 lots"), so it lives here, not on
// the header: PO04686 lot 2 may ride in the same box as PO04690 lot 1.
Table sms_shipment_pos {
  id          varchar [pk]
  shipment_id varchar [not null, ref: > sms_shipments.id]
  po_number   varchar [not null, ref: > po_orders.po_number]
  lot_number  integer [not null]
  indexes {
    (po_number, lot_number) [unique]        // a lot ships exactly once
    (shipment_id, po_number) [unique]
  }
}

// ---- what was in the box, per PO-lot (SKU grain) ----
Table sms_shipment_lines {
  id             varchar [pk]
  shipment_po_id varchar [not null, ref: > sms_shipment_pos.id]  // keys on the junction → PO is unambiguous
  sku_code       varchar [not null, ref: > product_skus.sku_code]
  qty            integer [not null]
  indexes { (shipment_po_id, sku_code) [unique] }
}

// ---- courier tracking events (FedEx/DHL integration appends; never edited) ----
Table sms_tracking_events {
  id           varchar [pk]
  shipment_id  varchar [not null, ref: > sms_shipments.id]
  event_time   timestamp [not null]
  courier_code varchar [not null]           // raw carrier code (e.g. FedEx 'DL')
  description  varchar
  location     varchar
}

// ---- carrier code → portal status vocabulary (statuses module='sms') ----
Table courier_status_map {
  id           varchar [pk]
  courier_id   varchar [not null]
  courier_code varchar [not null]
  status_id    varchar [not null, ref: > statuses.id]
  indexes { (courier_id, courier_code) [unique] }
}

// ---- NetSuite Item Receipts (the warehouse-side truth) ----
Table sms_item_receipts {
  id             varchar [pk]
  netsuite_ir_id varchar [unique]           // NULL for a manual receipt entry
  po_number      varchar [not null, ref: > po_orders.po_number]
  receipt_date   date
  source         varchar                    // 'netsuite' | 'manual'
  // logistics' CONFIRMED link to the consignment this IR received (the
  // auto-guess suggestion is derived at read-time; only the confirmation is
  // stored — it's an entered fact, not a computation):
  matched_shipment_id varchar [ref: > sms_shipments.id]  // nullable until confirmed
  confirmed_by   varchar                    // user id
  confirmed_at   timestamp
}
Table sms_item_receipt_lines {
  id         varchar [pk]
  receipt_id varchar [not null, ref: > sms_item_receipts.id]
  sku_code   varchar [not null, ref: > product_skus.sku_code]
  qty        integer [not null]
}
```

**Derived, never stored** (same rule as mainline):
- **Shipment status** = latest `sms_tracking_events` row mapped through
  `courier_status_map` (fallback `manual_status_id` until the API is live).
- **ETA** = FedEx `estimatedDeliveryTimeWindow` from the latest poll — surfaced
  on the shipment, never persisted as a portal fact.
- **Receive reconciliation** (the SMS three-way match, per PO × SKU):
  `ordered` (po_order_lines) vs `shipped` (Σ sms_shipment_lines via the
  sms_shipment_pos junction) vs `received` (Σ sms_item_receipt_lines) →
  variance. This finally makes `received_qty` real.
- **PO fulfillment state** ("2 of 3 lots shipped, 1 received") — computed from
  the junction rows + receipts, not stored.
- **Timeliness vs HOD** — `po_orders.hod` is the schedule anchor for SMS
  reports (`reports/sms`, later): shipped-after-HOD = late handover.
- New statuses rows (module='sms', category='shipment'): Label Created,
  Picked Up, In Transit, Out for Delivery, Delivered, Received, Exception.
- **Delivered vs Received** (2026-08-13; gate tightened 2026-08-19): `Delivered` =
  the courier handed the box over (FedEx scan, or the manual fallback). `Received` =
  NetSuite holds an Item Receipt for it — the warehouse booked the goods into stock.
  A Delivered consignment escalates to Received when EVERY PO in the box has a
  **human-confirmed** IR attributed to that lot (`receiptMatch.receivedByShipment`
  computes the confirmed → quantity → sequence attribution the Landed Costs page
  shows and lets you correct; `deriveStatus` requires `confirmed` — so status and
  landed-cost target can never disagree, and both need the same sign-off).
  Quantity/sequence matches are suggestions only: they surface on the shipment
  detail as "Item Receipt found · not confirmed" with a one-click path to confirm,
  but they leave the status at Delivered so a bad guess can't hide a discrepancy.
  Derived per read like every other status; `status_source: 'netsuite'` says so,
  and `received_date`/`received_irs` carry the IR date + document numbers.
  Only Delivered escalates: an IR against an In-Transit consignment means the
  tracking or the match is wrong, and silently marking it done would bury that.

## Build phases

1. ~~**Nav cleanup**~~ ✅ 2026-07-01 — legacy /bookings, /shipments,
   /purchase-orders are SMS-only (Mainline tabs removed, roots redirect to /sms);
   mainline module untouched.
2. ~~**Schema + migration**~~ ✅ 2026-07-02 (reworked same day for SEPARATION) —
   `sms_pos`/`sms_po_lines` + `sms_*` transactional tables in database.dbml;
   NO shared transactional tables (the interim `ship_via`/`hod` on po_orders
   was removed; shared hierarchy back to pure mainline: 23 masters / 62 orders).
   **Standalone `scripts/migrate-sms.js`** (NOT migrate-to-normalized.js — that
   would regenerate and wipe live mainline data): cleans up the interim variant,
   insert-only on shared master data, idempotent, never touches mainline_*
   files (md5-verified). Converted: 5 SMS POs → sms_pos + 409 sms_po_lines
   (SS27 season, 3 new suppliers, 409 SKUs, `Direct tentree` facility),
   1 shipment + junction, 6 sms statuses, 14 courier_status_map seeds.
   Mainline UI: NetSuite Sync button DEACTIVATED in PoLegsTable (visible,
   disabled, tooltip) — the SMS module gets its own independent sync button.
3. ~~**Backend module**~~ ✅ 2026-07-02 — `backend/modules/sms/*` mounted at
   `/sms` (server.js): `GET /sms/pos[/:poNumber]` (enriched + rollups + per-PO
   reconciliation incl. per-SKU ordered-vs-received), shipments CRUD
   (vendor-scoped create/update/delete, lot auto-increment per PO, overship
   409+force mirror of G2, duplicate-tracking-number rejection, junction
   cascade, delete blocked while a confirmed receipt points at it), receipts
   (manual entry, DERIVED auto-match suggestion qty→date→sequence, confirm
   stores matched_shipment_id + confirmed_by/at, NS-sourced receipts
   undeletable). Status derivation: latest tracking event via
   courier_status_map, fallback manual_status_id (`status_source` tells which).
   All curl-verified incl. vendor allow/deny/mixed-consignment branches;
   mainline endpoints unchanged.
4. ~~**NetSuite**~~ ✅ 2026-07-02 — `POST /sms/sync/netsuite` (requireAdmin) via
   `modules/sms/smsNetsuiteSyncService`. Header query extended with `custbody8`
   (hod) + `approvalstatus`; type clause matches `UPPER(DF) IN ('SMM','SMS')`.
   New `integrationService.fetchNetSuiteItemReceipts()` (ItemRcpt joined to its
   source PO via createdfrom, filtered on the PO's smm type, grouped per IR with
   per-SKU aggregated lines). Upsert rules: sms_pos/sms_po_lines NS-owned
   (wholesale replace); receipts keyed on netsuite_ir_id — NS facts refresh,
   portal confirmations (matched_shipment_id/confirmed_*) NEVER touched;
   suppliers/seasons/skus insert-only; unknown locations → null + warning
   (LOCATION_MAP for the conflated NS strings). Unit-tested (11 checks) +
   end-to-end IO-tested with injected NS data (API showed hod/approval,
   NS receipt with qty_match suggestion, variance 0; snapshots restored).
   **✅ RAN LIVE against the sandbox (4297852-sb1) 2026-07-02: 37 open smm POs
   (status A/B/C of 481 total) → 1,526 lines, 694 SKUs, 3 suppliers, seasons
   SS27+FW27; hod + approval_status populated; 0 Item Receipts (open POs not yet
   received); all facilities resolved (0 warnings) after wiring
   splitWarehouseName to strip the "NRI US Reserved"/"NRI CA Reserved" channel
   suffix. Mainline untouched (77 legs / 282,310).**
   Auth resolution: the token's role (TT - Operations) needed **REST Web
   Services = Full** AND the account-level **REST Web Services feature** enabled
   (SuiteCloud) — permission on the *role*, not the user; feature is account-wide.
   NOTE: sync pulls only NS transaction status A/B/C (open/partial/pending-bill)
   — completed past-season POs are excluded at the query, matching "only current
   season matters". Widen buildHeaderQuery's status filter if full history is
   ever needed.
5. ~~**Courier integration**~~ ✅ 2026-07-02 — VERIFIED AGAINST THE LIVE FEDEX
   SANDBOX. `services/fedexService.js` (OAuth2 client-credentials with token
   cache, host by FEDEX_IS_SANDBOX, ≤30 tracking numbers per batched call,
   `includeDetailedScans`; credentials MOVED frontend/.env.local → backend/.env).
   `modules/sms/smsTrackingService.js` poll: appends new scan events to
   sms_tracking_events (immutable, deduped on shipment+time+code), surfaces
   `estimatedDeliveryTimeWindow` as derived ETA (never stored), skips non-FedEx.
   Trigger: `POST /sms/tracking/poll` (requireAuth) + a 4-hour cron
   (cronJobs.js). Shipment delete now cascades its tracking events.
   courier_status_map extended with observed sandbox codes (RS, IN, HL, RT).
   E2E-verified: created consignment with a FedEx mock tracking number → poll
   pulled 2 real scans (OC, PU) → derived status flipped manual 'Label Created'
   → courier 'Picked Up' → re-poll deduped (0 new) → delete cascaded. DHL stays
   on `manual_status_id` until credentials exist.
6. ~~**Frontend module**~~ ✅ 2026-07-02 — `src/modules/sms/{types,actions,
   components}` + `app/sms/*` routes (loading/not-found/error included; generic
   UI primitives DataTable/ConfirmDialog/RouteFallbacks reused from the mainline
   components folder — pure presentational, no data coupling). Sidebar: SMS
   Purchase Orders / SMS Shipments / SMS Receiving → `/sms/*` (legacy
   /bookings/sms + /shipments/sms reachable by URL until phase 7).
   - **SmsPosTable** — season filter defaulting to the newest season with open
     POs, the SMS-only NetSuite Sync button (admin), fulfillment badges,
     rollup columns; row → PO detail.
   - **SmsPoDetail** — meta (TRN/season/HOD/method/facility), ordered/shipped/
     received/remaining stat cards, consignments (lots) with courier status,
     receiving reconciliation per SKU (variance-sorted), order lines.
   - **SmsShipmentsTable + SmsShipmentForm** — vendor self-service create
     (multi-PO consignment, overship 409 → "Ship anyway", vendor sees own POs
     client-side; server enforces), Poll Tracking button (non-vendor).
   - **SmsShipmentDetail** — contents (PO lots), tracking timeline, manual
     status fallback (courier wins), delete with confirm.
   - **SmsReceivingClient** — needs-confirmation cards with the auto-match
     suggestion + consignment override select, confirmed table, manual receipt
     dialog (pick PO → its SKUs load → type received counts).
   GUI-verified end-to-end (Playwright): 42 POs, PO detail rollups, shipment
   create→detail→delete, full receive flow (manual receipt 200u → qty_match
   suggestion → confirm → PO received rollup), 0 console errors, mainline
   untouched.
7. ~~**Cutover**~~ ✅ 2026-07-03 — the ENTIRE legacy stack deleted (not just SMS):
   frontend trees app/{bookings,shipments,purchase-orders,history} +
   components/{bookings,shipments,purchase-orders} + legacy actions/types;
   backend routes/controllers/models/validators/services for the legacy
   transactional stack; flat files bookings/shipments/history/history-bookings
   .json (backed up in git); history-sweep cron removed. `/` →
   /mainline/purchase-orders; `/reports` → /reports/mainline; sidebar logo
   fixed. KEPT: `purchase-orders.json` as a FROZEN snapshot for `/forecast`
   (reportController slimmed to inline BaseModel reads) — forecast needs a
   rebuild on migrated/sms data. Verified: legacy endpoints 404, legacy URLs
   404 in the GUI, all mainline/sms/forecast/settings pages render, tsc clean,
   mainline data intact (77 legs / 282,310), sms intact (42 POs).
   Remaining SMS work: reports/sms, DHL credentials, forecast rebuild.

9. ~~**Allocation channel on SMS POs**~~ ✅ 2026-07-05 — the NS `location` conflates
   facility + channel (e.g. "NRI US Reserved"); the sync now resolves BOTH into
   `sms_pos.facility_id` + `sms_pos.allocation_channel_id` (via
   `resolveLocation` → splitWarehouseName/LOCATION_MAP + channelIdByName).
   Direct-tentree POs have no channel (null — direct-to-tentree, not NRI
   Reserved/First). Shown as a Channel column on the PO list + detail meta.
   Verified after a live re-sync: 25 Reserved / 12 none (Direct tentree).

8. ~~**Shipping data + CI/packing generation**~~ ✅ 2026-07-05 — vendors upload one
   packing Excel per consignment (`POST /sms/shipments/:id/shipping-data`, reuses
   the shared `ciParser`), giving carton × SKU detail (`sms_packing_cartons`) →
   the source for shipped-per-SKU. Generates CI + packing-list docs (combined +
   per-PO, reusing `ciGenerator`/`plGenerator` via `smsDocumentService`) →
   `sms_documents`; `GET /sms/shipments/:id/documents`. Two new 3NF tables
   (dbml); `total_usd`, shipped-per-SKU, packing summary all DERIVED (unlike
   mainline's stored `mainline_ci_line_items` — audit note in CLAUDE.md). Shipped
   truth: packing when present, else declared junction units. Reconciliation
   gained a per-SKU Shipped column; shipment detail gained upload button +
   packing summary + doc links. Vendor-scoped, PO-membership validated, cascades
   on delete. E2E-verified (multi-PO → 6 docs; per-SKU shipped; UI upload).

## Open questions — ALL RESOLVED (2026-07-02); design is build-ready
1. ~~SMS PO identification~~ → `custbody_tt_po_type = 'smm'` (full field map above).
2. ~~One shipment = one PO?~~ → **No** — FedEx shipments sometimes carry
   multiple POs → `sms_shipment_pos` junction (schema above).
4. ~~FedEx API access~~ → sandbox credentials in frontend/.env.local
   (client id/secret + `FEDEX_IS_SANDBOX`); instructions doc in
   `frontend/FedEx_API_Tracking_ETA_Instructions.txt`. Polling (no webhooks).
   DHL: no credentials yet.

3. ~~Who creates the shipment record~~ → **The supplier (vendor login)** enters
   the shipment: PO(s), quantity & cartons, tracking number, courier. No
   approval step. Implications (phase 3 + 6):
   - Vendor-scoped guard (mainline G1 analogue): a vendor may only attach POs
     whose `po_masters.supplier_id` matches their own supplier — enforced
     server-side on create/update, not just filtered in the form.
   - Over-shipment guard (G2 analogue): warn when Σ shipped qty per PO × SKU
     exceeds ordered qty (lots make partials normal, so warn, not block).
   - Form: vendor picks from THEIR open SMS POs (`ship_via='sms'`, not fully
     shipped), enters per-PO/SKU qty + cartons, one tracking number + courier
     per consignment; lot_number auto-increments per PO server-side.
   - Logistics/Admin can also create/correct entries (same endpoint, no scope
     restriction).

5. ~~Manual receive~~ → **Logistics checks the NetSuite IR (first/newest for
   the PO), compares quantities, and enters/confirms in the portal.** Design:
   the IR pull (phase 4) makes this a CONFIRM flow, not data entry — the
   receive screen shows the pulled IR lines side-by-side with the shipment
   lines and logistics confirms (or adjusts) in one click. **Auto-guess
   (IR ↔ shipment lot matching)**, suggested confidence order:
   1. exact qty match — IR line qtys per SKU == one lot's shipment lines;
   2. date proximity — IR `receipt_date` within ~5 days AFTER that shipment's
      courier Delivered event;
   3. sequence fallback — first IR for the PO → lot 1, next → next lot.
   The suggestion is DERIVED (never stored); logistics' confirmation is an
   entered fact → nullable `sms_item_receipts.matched_shipment_id` records the
   confirmed IR↔consignment link (plus `confirmed_by`/`confirmed_at`).
   Mismatches (qty variance ≠ 0 after confirm) surface in the reconciliation
   view — never auto-adjusted.
6. ~~approvalstatus filter~~ → **Sync everything** (all approval states, all
   seasons — history stays queryable). But the UI/reports serve the CURRENT
   season: lists and `reports/sms` default their season filter to the newest
   season having open (not fully received) SMS POs; approval state shows as a
   badge. Completed seasons remain one filter-click away, never deleted.
