# SMS vs Mainline — Frontend Coupling Audit

**Scope:** `frontend/tentree-scportal/src/` (Next.js RSC app). Read-only audit.
**Requirement:** SMS and Mainline (non-SMS) must be **two independent modules** with no shared functions/features.

> **Alignment update (2026-06-24) — direction agreed after this audit:**
> - **Build mainline first; SMS is a later pass.** SMS is a *totally separate module*
>   and is NOT forked alongside mainline now. The `modules/sms/*` tree in section (b)
>   is the eventual target but is **deferred** — leave the existing shared SMS code in
>   place untouched until the SMS pass begins.
> - **Near-term frontend work = de-couple the mainline path.** Fork `BookingsClient` /
>   `ShipmentsClient` / `BookingForm` / `BookingDetail` into mainline-only versions and
>   split the `Booking`/`Shipment` types so mainline carries only its own fields. The
>   SMS branches can stay as-is for now (they become the seed of the future `sms/` tree).
> - **PO data shape changed** (backend `database.dbml` / `SCHEMA_REDESIGN.md`): a PO is
>   now `po_masters (TRN) → po_orders (po_number) → mainline_po_legs`. Mainline PO/booking
>   views read from the **leg** grain; the PO list gains a lifecycle state
>   (`forecast` → `split`) and is bookable only once split into legs. Wire mainline
>   actions to the leg-grain endpoints when the backend split lands.
>
> Everything below documents the **current (as-is) coupling** and remains accurate.

**Current reality:** Routes are namespaced by type (`/bookings/{mainline,sms}/*`, `/shipments/{mainline,sms}`), but this is a thin shell. Under the hood, **both types funnel into the same client components, the same TypeScript types, and the same server actions / API endpoints**, discriminated by a `type` field or a `bookingType` / `activeTab` prop. The per-type route folders mostly differ only by a literal string they pass down.

---

## (a) Shared Touchpoints

### 1. Client orchestrator components (branch on type)

| File | Line(s) | What's shared | How it branches |
|------|---------|---------------|-----------------|
| `app/bookings/BookingsClient.tsx` | 745–795 | Single orchestrator for **both** booking modules. Takes `bookingType?: 'mainline' \| 'sms'` prop (default `'mainline'`). | `basePath = ` + "`/bookings/${bookingType}`" (766); passes `currentType={bookingType}` into pending list (771); `basePath` into list/history (775,779) and submit nav (786,790). |
| `app/bookings/BookingsClient.tsx` | 108 | `PendingPOsList` filters POs by type. | `const matchType = (p.type \|\| 'mainline').toLowerCase() === currentType;` |
| `app/bookings/BookingsClient.tsx` | 354 | "Book Now" routes back into the type's namespace. | `router.push(`+"`/bookings/${currentType}/submit?...`"+`)` |
| `app/shipments/ShipmentsClient.tsx` | 93–99 | Single orchestrator for **mainline, sms AND history**. Takes `activeTab?: 'mainline' \| 'sms' \| 'history'`. | Tab-driven branching throughout. |
| `app/shipments/ShipmentsClient.tsx` | 51–52 | Two separate status vocabularies hardcoded side-by-side. | `mainlineStatuses = [...]` vs `smsStatuses = [...]` |
| `app/shipments/ShipmentsClient.tsx` | 414–419 | Splits the **same merged array** into sms vs mainline by `type`. | `smsShipments = ...filter(s => s.type==='sms'\|\|s.type==='SMS')`; `mainlineShipments = ...filter(s => s.type==='mainline'\|\|!s.type)` |
| `app/shipments/ShipmentsClient.tsx` | 534–552 | Per-tab action buttons (New SMS / Import vs New Mainline) inside one toolbar. | `activeTab === 'sms'` vs `activeTab === 'mainline'` blocks |
| `app/shipments/ShipmentsClient.tsx` | 618–619 | Row-level status options chosen by type. | `isSms = tab==='sms' \|\| (tab==='history' && first.type==='sms'…)`; `statusOptions = isSms ? smsStatuses : mainlineStatuses` |
| `app/shipments/ShipmentsClient.tsx` | 631–639 | Row click routes to a different detail page per type. | `if (isSms) router.push('/shipments/sms/'+id) else '/shipments/mainline/'+id` |
| `app/shipments/ShipmentsClient.tsx` | 712, 720 | Booking deep-link + ShipmentDataActions tagged per type. | `` `/bookings/${isSms ? 'sms' : 'mainline'}/active` ``; `shipmentType={isSms ? 'sms' : 'mainline'}` |
| `app/shipments/ShipmentsClient.tsx` | 786–798 | Renders **both** `ShipmentForm` and `SmsShipmentForm` modals unconditionally in one tree. | Toggled via `showForm` / `showSmsForm` state. |

### 2. Form & detail components (branch on type internally)

| File | Line(s) | What's shared | How it branches |
|------|---------|---------------|-----------------|
| `components/bookings/BookingForm.tsx` | 41,167,196,220,322,368,389,490,570,587,604 | **One form** builds both mainline and SMS bookings. | `formData.type === 'sms'` gates: booking status (`Booking Approved` for SMS vs `Booking Pending` 167), success toast (196,220), shown fields/labels (322,368,389 "Shipped Date" vs "Cargo Ready Date"), and whether warehouse/mode/incoterm are editable (570–612). |
| `components/bookings/BookingDetail.tsx` | 27–31, 494–495 | **One detail page** serves both. Used by mainline AND sms `[id]/page.tsx`. | `bookingType = booking.type==='sms' ? 'sms':'mainline'` derives `backUrl`/`backLabel`; type `<SelectItem>`s for mainline/sms in edit mode. |
| `components/shipments/ShipmentDetail.tsx` vs `SmsShipmentDetail.tsx` | — | These two **are** already separate components (good). But both consume the same `Shipment` type and the same `getShipment` action/endpoint. | Selected by route: `mainline/[id]/page.tsx` → `ShipmentDetail`; `sms/[id]/page.tsx` → `SmsShipmentDetail`. |
| `components/shipments/ShipmentForm.tsx` vs `SmsShipmentForm.tsx` | — | Separate components, but both write through the same `createShipment`/`updateShipment` actions + `/shipments` endpoint, and both are mounted together by `ShipmentsClient`. | — |

### 3. Shared TypeScript types (single type, `type` discriminator)

| File | Line(s) | What's shared | SMS/mainline-only fields |
|------|---------|---------------|--------------------------|
| `types/booking.ts` | 84–114 | **One `Booking` interface** for both. | `type: 'mainline' \| 'sms'` (92) is the only discriminator. `courier` (98) is SMS-leaning; `freight_forwarder`, `mode`, `incoterm`, `receiving_warehouse` (93–99) are mainline-leaning. No structural split — all optional on one shape. |
| `types/shipment.ts` | 1, 18–53 | **One `Shipment` interface** + `ShipmentType='mainline'\|'sms'\|'SMS'`. | `MainlineStatus` (3–9) vs `SmsStatus` (11–16) are separate unions but `Shipment.status` is just `string` (46). Mainline-only logistics fields: `etd_pol`,`eta_pod`,`e_del`,`cargo_received_date`,`crd`,`actual_crd` (36–45). SMS-leaning: `courier`,`tracking_number` (30–31). All crammed into one optional-field interface. |

### 4. Shared columns definitions

| File | Line(s) | What's shared | Notes |
|------|---------|---------------|-------|
| `components/bookings/columns.ts` | 9–33 | **One `COLUMNS` set** used by both mainline and SMS booking lists via `BookingsClient`. | No SMS/mainline variant. Includes a `type` column (14) precisely because both share the table. |
| `components/shipments/columns.ts` | 7–30 | **One `ALL_COLUMNS` set**. (Note: `ShipmentsClient` actually defines its **own** inline copy at lines 59–82 — the exported file is partly dead/duplicated.) | SMS-relevant `courier` and mainline-relevant `etd_pol`/`eta_pod`/`e_del`/`cargo_received_date` coexist in one list. |

### 5. Route layouts / nav (shared shell)

| File | Line(s) | What's shared | How it branches |
|------|---------|---------------|-----------------|
| `app/bookings/layout.tsx` | 1–17 | Top-level shell wraps **all** `/bookings/*`. | Type-agnostic; just renders `BookingsSubNav` + children. |
| `app/bookings/BookingsSubNav.tsx` | 8–11 | One sub-nav lists both tabs. | `tabs = [{Mainline,/bookings/mainline},{SMS,/bookings/sms}]` — the only place the two are presented as one nav. |
| `app/bookings/BookingsSecondaryNav.tsx` | 16, 27 | **Shared** secondary nav (Pending/Active/History/Submit), parameterized. | Both `mainline/layout.tsx` and `sms/layout.tsx` render it with `basePath="/bookings/{type}"`. |
| `app/bookings/{mainline,sms}/**/page.tsx` | e.g. sms/active 19, 27 | Per-type page files are near-identical thin wrappers. | Differ only by literal `'sms'`/`'mainline'`: filter `(b.type).toLowerCase()==='sms'` (sms/active 19) and prop `bookingType="sms"` (27). |
| `app/shipments/layout.tsx` | 1–17 | Shell wraps all `/shipments/*`. | Type-agnostic. |
| `app/shipments/ShipmentsSubNav.tsx` | 8–12 | One sub-nav: Mainline / SMS / History. | Single nav presenting both. |
| `app/shipments/{mainline,sms}/page.tsx` | mainline 6–16 / sms 6–16 | **Byte-identical except `activeTab`.** Both call `getShipments()`+`getPurchaseOrders()`+`mergeShipmentsAndPOs`. | `activeTab="mainline"` vs `activeTab="sms"`. |
| `app/shipments/mergeShipments.ts` | 5–41 | **Shared merge helper** used by mainline, sms AND history pages. | Type-agnostic merge; stamps `type` (27,36) used downstream to split. |

### 6. Shared server actions / API endpoints (one endpoint, both types)

| File | Line(s) | What's shared | Notes |
|------|---------|---------------|-------|
| `app/actions/bookings.ts` | 8–93 | `getBookings`, `getBooking`, `getHistoryBookings`, `createBooking`, `updateBooking`, `deleteBooking` — **all type-agnostic**, hit `/bookings`. | SMS/mainline separation happens only by client-side filtering on `type`. |
| `app/actions/shipments.ts` | 6–79 | `getShipments`,`getShipment`,`createShipment`,`updateShipment`,`deleteShipment`,`bulkUpdateShipmentStatus` — all hit `/shipments`. | No SMS/mainline distinction at the action or endpoint level. |
| `app/actions/purchase-orders.ts`, `history.ts`, `asn.ts` | — | Shared by both modules. | Same. |

---

## (b) Recommended Target Structure (independent module trees)

Split each domain into two sibling trees that share **nothing domain-specific**. **Sequencing per the alignment update: build the `mainline/` tree now; the `sms/` tree is deferred** (shown as the eventual target only — leave today's shared SMS code in place until the SMS pass). Suggested shape:

```
src/
  modules/
    mainline/
      bookings/
        BookingsClient.tsx        # mainline-only orchestrator (no bookingType prop)
        BookingForm.tsx           # mainline fields only (Cargo Ready Date, FF, incoterm…)
        BookingDetail.tsx         # mainline detail (no type <Select>, fixed backUrl)
        columns.ts                # mainline booking columns (no `type` column)
        actions.ts                # getMainlineBookings()… → /mainline/bookings (or ?type=mainline)
        types.ts                  # MainlineBooking interface
      shipments/
        ShipmentsClient.tsx       # mainline list (mainlineStatuses only)
        ShipmentDetail.tsx        # (already exists — move here)
        ShipmentForm.tsx          # (already exists — move here)
        columns.ts                # mainline columns (etd_pol/eta_pod/e_del/cargo_received)
        actions.ts
        types.ts                  # MainlineShipment, MainlineStatus
    sms/
      bookings/
        BookingsClient.tsx        # sms-only (auto-approve flow)
        BookingForm.tsx           # sms fields only (Shipped Date, courier…)
        BookingDetail.tsx
        columns.ts
        actions.ts
        types.ts                  # SmsBooking
      shipments/
        ShipmentsClient.tsx       # sms list (smsStatuses only)
        SmsShipmentDetail.tsx     # (already exists — move here)
        SmsShipmentForm.tsx       # (already exists — move here)
        SmsImportModal.tsx
        columns.ts
        actions.ts
        types.ts                  # SmsShipment, SmsStatus
```

Route folders stay as the (already-present) `app/bookings/{mainline,sms}/*` and `app/shipments/{mainline,sms}/*`, but each route imports **only its own module's** client/detail/actions — no `bookingType`/`activeTab` prop, no `type` filtering in the page.

**Concrete decoupling moves:**

1. **Fork `BookingsClient.tsx`** → `mainline/bookings/BookingsClient.tsx` and `sms/bookings/BookingsClient.tsx`. Drop the `bookingType` prop and `currentType`/`basePath` plumbing; hardcode each tree's `basePath`. Remove the `matchType` filter (it's no longer needed once data is type-scoped). Split `PendingPOsList`/`BookingsList` into each tree (they can keep identical table mechanics by importing from a shared **UI** layer — see (c)).
2. **Fork `ShipmentsClient.tsx`** → mainline keeps only `mainlineStatuses`, "New Mainline", mainline routing; sms keeps `smsStatuses`, "New SMS"/Import, SMS routing. History becomes its own concern (see note below) rather than a third `activeTab`. Remove the `smsShipments`/`mainlineShipments` `type` filters — each tree receives already-scoped data.
3. **Fork `BookingForm.tsx`** → one form per module; delete every `formData.type === 'sms'` branch (lines 167,196,220,322,368,389,490,570,587,604).
4. **Fork `BookingDetail.tsx`** → remove `bookingType` derivation (27–31) and the mainline/sms `<SelectItem>` type picker (494–495); each version hardwires its `backUrl`/`backLabel`.
5. **Split types** — `MainlineBooking`/`SmsBooking`, `MainlineShipment`/`SmsShipment`, dropping the `type` discriminator field and keeping only each module's relevant fields. `MainlineStatus`/`SmsStatus` already exist and move into their respective `types.ts`.
6. **Split columns** — separate `columns.ts` per module so SMS doesn't carry `etd_pol`/`eta_pod`/etc. and mainline doesn't carry SMS-only fields. Also delete the duplicate inline `ALL_COLUMNS` in `ShipmentsClient.tsx` (59–82) in favor of each module's exported list.
7. **Split actions / endpoints** — give each module its own `actions.ts`. Cleanest is type-scoped endpoints (`/mainline/...`, `/sms/...`) or at minimum dedicated action functions (`getMainlineShipments`/`getSmsShipments`) so the modules never read each other's data. (This is the one item that needs backend coordination — flag to the backend analyst.)
8. **Two sub-navs instead of one** — `BookingsSubNav`/`ShipmentsSubNav` currently present Mainline+SMS as one nav (the main place they're visually coupled). If the modules must be fully independent, the Mainline↔SMS tab switch belongs in the **app-level sidebar** (two separate nav entries), not a shared sub-nav. `BookingsSecondaryNav` (Pending/Active/History/Submit) can stay shared as pure presentational UI since it's already `basePath`-parameterized.

**History note:** Shipment history is currently a third `activeTab` on the shared `ShipmentsClient` and a single `/shipments/history` route mixing both types (it re-derives `isSms` from `first.type` at 618). To honor the split, history should either become per-module (`/shipments/mainline/history`, `/shipments/sms/history`) or remain a deliberately cross-cutting "archive" view documented as an exception.

---

## (c) What legitimately stays shared

- **UI primitives / shadcn** (`components/ui/*`) — Button, Table, Select, Dialog, Popover, Badge, etc. Pure presentation, no domain logic.
- **App shell & cross-cutting layout** — root `app/layout.tsx`, `Sidebar.tsx` (it should gain *separate* Mainline/SMS entries rather than one shared sub-nav, but the sidebar component itself is shared).
- **Auth / session** — `app/actions/auth.ts`, `SessionProvider`, `lib/permissions.ts`, middleware.
- **Master-data dropdowns** — `app/actions/master-data.ts` (warehouses, modes, suppliers, couriers, incoterms, statuses). Both modules read the same reference lists.
- **Generic table mechanics** — the column-visibility/drag-reorder/pagination/CSV-export logic is identical and domain-neutral; extract it into a shared `components/ui` table-toolkit so both forked clients reuse it without coupling their *domain* data.
- **Purchase Orders** — POs are the shared upstream source both modules book against; `getPurchaseOrders` stays shared.
- **`BookingsSecondaryNav`** — already `basePath`-parameterized, pure presentation; safe to keep shared.
- **Utilities** — `lib/utils.ts` (`cn`), `lib/api.ts` (`fetchApi`, `BACKEND_URL`), date formatting, `lib/asn.ts` gating.

---

## Summary count

**~22 shared touchpoints** across 6 categories. The route layer is already split; the **component, type, action, and column layers are not** — they're a single implementation forked by a `type`/`bookingType`/`activeTab` discriminator. The biggest offenders are the two mega-orchestrators (`BookingsClient.tsx`, `ShipmentsClient.tsx`), the shared `BookingForm.tsx`/`BookingDetail.tsx`, and the single `Booking`/`Shipment` types.
