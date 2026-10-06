# 3PL invoices — All Invoices (`/invoices` UI)

## ⭐ THE CURRENT FLOW: NRI billing (`/nri-billing` API) — 2026-09-30

**The `/invoices` UI is now this flow.** It replaces `NRI CA_ALL Invoices 2026.xlsx`
(Power Query folder combine → `Summary_Coded` formulas → `Pivot`) for NRI CA and
NRI US alike. Four pages:

| Page | What it is | API |
|---|---|---|
| `/invoices/results` — **Cost per GL** | the workbook's `Pivot`: Σ Charges by Revised GL × Revised Class (channel), scoped to a file / period month / the year; rate-check buckets; drill-down + recoding | `GET /results`, `GET /lines`, `PUT /lines/override` |
| `/invoices/uploads` | the year's NRI reports (the folder the team saved CSVs into), preview-before-save, **review popup after save**, booked lock, order data | `GET/POST /files`, `PATCH/DELETE /files/:id`, `GET /files/:id/review`, `POST /files/:id/confirm` |
| `/invoices/rules` | the CHANNEL RULES, edited by the team (see below) | `GET/PUT /rules` |
| `/invoices/gl-codes` | which GL each NRI service posts to — the legend, the GL for open files, hand recodes | `GET/PUT /gl-codes` |
| `/invoices/rate-cards` | the two contracts (`NRI_Canada_Rate_Card.xlsx`, `NRI_USA_Rate_Card.xlsx`) — Contract Info, Rate Card, Validation Rules | `GET/POST /rate-cards` |

Files: `src/{models/Nri{ContractRates,ContractTerms,BillingFiles,BillingLines,ClassRules},
lib/nriBilling{Parser,Rates},services/nriBillingService,
controllers/nriBillingController,routes/nriBillingRoutes,validators/nriBillingValidator}.js`;
frontend `src/modules/nri-billing/*` + `app/invoices/{results,uploads,rules,rate-cards}`.
Gate: `landed_costs`, the same key `/nri-invoices` uses. Tables were created by
`scripts/create-nri-billing-tables.js` (`Model.sync()` on those five models only,
create-if-missing; seeds the starting rules into an EMPTY rules table, never over
existing ones). History was loaded by `scripts/import-nri-billing-history.js`.

⚠️ The old All Invoices UI — `app/invoices/[warehouse]/*`, `app/nri-invoices/[id]`,
`modules/nri-invoices/*` (the US PDF + detail three-way screens) — was DELETED
2026-09-30 at Lam's direction. The `/nri-invoices` API is still mounted: the order-data
upload on the Uploads page goes through it.

### Workbook → code (verified)

| Workbook | Code |
|---|---|
| merge Service ⟕ "NRI Invoice Coding" | `nri_charge_codes` — the SAME legend table as `/nri-invoices` (CA column: 0 differences from the workbook's embedded copy) |
| `Revised Class` = override else `Class (NRI CAN)` | `nriBillingService.buildCoder` |
| `Revised GL Code` / `Revised GL Desc` (XLOOKUP on override) | same |
| `VLOOKUP(Client Ref 1, 'NRI Order data', 10)` → Order Type | `nri_order_master` (entity CA) — the SAME order master as `/nri-invoices` |
| Manual Class / GL Override columns | `nri_billing_lines.classOverride` / `.glOverride` — the only coding that is STORED; everything else is derived per read |
| `Pivot` | `glByClass` |

**Verified line-by-line against `Summary_Coded`** (all 52,625 rows streamed):
Revised Class 0 diffs, Order Type 0, Charges 0, missing 0. Revised GL/Desc: 2 diffs, both
`Order Cancel/Mod.` — a service absent from the legend, which the workbook shows as GL `0`
(LeftOuter null) and the portal shows as unmapped. Sept 15 2026 = **CA - Whsle $30,659.74 ·
CA - Online $46,190.69 · $76,850.43**, to the cent. Year to date: 18 files, 52,625 lines,
$925,289.72, all 32,584 workbook overrides matched.

### One addition: CHANNEL RULES — set by the team on All Invoices → Rules

The team hand-typed `CA - Online` over 32,344 lines in 2026, because the legend's default is
`CA - Whsle` for nearly everything. Channel rules do that instead. Approved by Lam
2026-09-30 on the condition that users set them up; simplified 2026-10-01 to a
**drag-and-drop between two columns** (per Lam). Stored in `nri_class_rules`.

**Why it is two steps and not just two columns.** Services like Order Processing, Order
NonMasterPack and Outbound Freight are split between channels BY THE ORDER — in the 2026 hand
coding, ECOM orders are Ecomm and trade orders Wholesale (Order Processing: 6,968 of 10,797
lines are on ECOM orders). A service sitting in one column cannot express that, so:

1. **By order type** (`kind: orderType`, TWO columns — one rule per channel, 2026-10-01 per Lam):
   order types (ECOM, PREBOOK, WHOLESALE, PROMO, AT ONCE, ITEMFULFILLMENT — listed from the
   uploaded order data, so a new type appears on its own, in Wholesale) are dragged between
   Wholesale and Ecomm. Only a charge whose `Client Ref 1` is an order in the order data has a
   type — the workbook's "NRI Order data" VLOOKUP — everything else falls through to step 2.
   Deciding Wholesale here too is NEUTRAL on the 2026 data: making the five trade types explicit
   Wholesale changed the coding of 0 of 52,625 lines (no trade order carries an Ecomm-column
   service, and the team left all 7,672 trade-order lines Wholesale).
2. **Everything else, by service** (`kind: serviceColumn`, one rule per column): each NRI service
   is dragged into **Wholesale** or **Ecomm** (or moved with its arrow button — keyboard, touch,
   screen readers). A service in neither column takes the legend's default.
3. **Exceptions** (`kind: custom`, its own TABLE — # · Exception · When · Channel · On, edited
   inline): the unusual cases a column cannot express — overtime, transfer orders, special
   services; today the GoBolt transfer labour rules ("Client Ref 1 starts with TO#" /
   "contains gobolt"). Checked top to bottom, between steps 1 and 2.

The evaluation order is FIXED by kind on the server — orderType → custom (Exceptions) → serviceColumn — no
matter what order the client sends. An order type / a service may sit in only ONE column (400 otherwise). Both steps are the same
component (`ChannelColumns`) — collapsible, drag or arrow — and a card dragged from one step
onto the other step's column is ignored (the drag carries its step).
Rules code ONLY files not marked **Booked**, and a hand-coded line always keeps its coding, so
every imported 2026 file still codes exactly as the workbook did.

**The page is for GENERAL rules, so a service card is just the service name** (A–Z, every
service billed so far plus every service the legend knows; header = a count). No money, no line
counts — per Lam 2026-10-01; where the money lands is the Cost per GL page's job.

`scripts/add-nri-class-rule-kind.js` (idempotent, `--dry-run`) added the `kind` column and
sorted the stored rules into kinds by shape. `GET /rules` returns the rules plus
`services[]` for the cards; `PUT /rules` replaces the entity's list and `normalizeRule`
enforces each kind's shape.

⚠️ **Testing drag-and-drop with Playwright: do NOT use `locator.dragTo()`.** It scrolls the drop
target into view between mouse-down and the first move, which slides a DIFFERENT card under the
pressed pointer — measured: the press was on Storage, `dragstart` fired on Cycle Count, and the
wrong service was saved. Drive `page.mouse` (move → down → small move → move to target → up)
with both elements already in the viewport.

### Order data — pulled from NetSuite, not pasted (2026-10-01, per Lam)

The workbook's "NRI Order data" sheet exists for ONE lookup: an invoice line's `Client Ref 1`
→ the order's type (`VLOOKUP(..., 10)`). Those orders ARE NetSuite **Item Fulfillments** —
`Client Ref 1` is the IF number and the sheet's `Ref2` is its internal id — so the portal
pulls them (READ-ONLY, `integrationService.fetchNriItemFulfillments` → `lib/nriOrderSync.js`)
into the same `nri_order_master` the lookup already reads.

- **Fields**, copied onto the IF from its sales order: `custbody6` = order type (Online,
  Prebook, Prebook ATP, In-season ATP, POP, Special Make Ups, Promo, Replacement, …) and
  `cseg_tt_salechannel` = NetSuite's own channel ("CA - Ecommerce" / "CA - Wholesale").
  Scoped by the line-level `location` (every location named "NRI CA…" / "NRI US…") and
  `trandate`. ~6,000 CA fulfilments a month; the full 2026 pull (13,760) takes ~35 s, an
  incremental one ~2 s.
- **Verified against production**, all 8,824 orders the pasted sheet held: 8,796 found; the
  channel agrees with NRI's OrderType on every one (6,944 ECOM ↔ CA - Ecommerce, every trade
  type ↔ wholesale). NRI's labels are its own — NetSuite's are finer ("AT ONCE" =
  Replacement, "WHOLESALE" = POP / Special Make Ups).
- **Merge:** NetSuite REPLACES type/channel/ref2/customer/date and marks the row
  `source: 'netsuite'`; a value NetSuite lacks never wipes a held one (transfer orders carry
  no type); a pasted order NetSuite does not have is KEPT (28 in 2026). The fallback file
  upload (`POST /nri-invoices/order-data`) no longer overwrites a NetSuite row.
- **Kept current automatically:** uploading (or previewing) an invoice first calls
  `ensureCurrent` through its PERIOD END, pulling from a week before what is covered to today.
  A NetSuite failure never blocks the upload — the preview says so. "Synced through" is the
  contiguous date the pull is known complete to (`_documents.nri_order_sync`), not the latest
  fulfilment. Manual: Uploads → **Sync from NetSuite** (`POST /nri-billing/order-data/sync`).
- **New order types are placed in Rules step 1** the first time they appear, by their orders'
  majority sales channel (Ecommerce → Ecomm, else Wholesale), so the page shows exactly what
  codes. A type already placed is never moved. First sync placed 12 (ONLINE → Ecomm; POP,
  IN-SEASON ATP, PREBOOK ATP, … → Wholesale; DONATION and VERITREE → Wholesale — worth a look).
- **Effect on 2026 CA:** IF-numbered invoice lines with an order type 36,016 → **44,485 of
  44,630 (99.7%)** — January–June had none before. Coded as if every file were open: 0 lines that
  already had a type changed class; of 8,469 that gained one, 2 ($21.70) would code differently
  (all files are Booked, so nothing moved).
- ⚠️ `modelStore.readDocument` answers an EMPTY ARRAY for a missing document; a property set on
  it is dropped by `JSON.stringify` — that lost the first sync record. `readLog` normalises it.
- Migration: `scripts/add-nri-order-sync-columns.js` (`salesChannel`, `source`, `recordType`,
  `altRef`; idempotent).

#### Returns: verified against NetSuite Return Authorizations (2026-10-01, per Lam)

A returns line (Returns / Restock / Service Center Labor) quotes its **Return Authorization**,
which carries the same order type + channel as a sales order. Verified on production:
`Client Ref 2` = the RA's internal id (4,774 of 5,124 lines; 1,450 of 1,454 ids resolve, 1,448
RtnAuth); a numeric `Client Ref 1` ("RMA89832") is the RA number; an "RMA #V0NUF99J" one is the
RA's `otherrefnum` (the ecom form). So the lookup is THREE keys, in order — Client Ref 1 as an
order/RMA number, as an RA external ref, then Client Ref 2 as the NetSuite id (`#<id>`; only rows
pulled FROM NetSuite, since a pasted Ref2 is not guaranteed to be one). `orderTypeIndex` /
`orderTypeOf` in the service and `lookupIndex` in the sync implement the same rule.

- The sync pulls RAs by date at the NRI locations (2,017 in 2026) AND `resolveRefs` fetches
  exactly the RAs an invoice quotes that are not held (63 older ones) — a return is often billed
  months after its RA. Uploads and the Sync button both run it.
- ⚠️ **"Numeric RMA = wholesale" is FALSE** — it looked true from the hand coding (281 of 291
  numeric-RMA lines Wholesale) only because those lines were LEFT AT THE DEFAULT: NetSuite says
  Ecomm for 204 of the 216 that lack a Client Ref 2. An "RMA0–9 → Wholesale" exception was
  proposed and withdrawn on that evidence. Do not reintroduce it.
- Aug 31 2026 re-uploaded raw and OPEN reads CA - Whsle **$29,518.19** vs the workbook's
  $29,569.12. The $50.93 is 36 consumer returns the team left at the default: 21 NetSuite marks
  Ecomm, 15 have no RA at all ("NO RMA", or a consumer order # like CA987024). Nothing the team
  actually coded disagrees. Marked **Booked**, the file reads exactly $29,569.12.
- Year, every file treated as open: rules vs the team's coding disagree on $4,541.95 (was
  $8,040.29 before returns data); the remainder is mostly lines NetSuite identifies as ecom
  orders/returns that the team left Wholesale.

### Layer 1 resolves by the SHAPE of Client Ref 1 (2026-10-02, per Lam)

An invoice line names a NetSuite record in Client Ref 1; its shape says which one
(`nriOrderSync.refKind`). Anything not already held is fetched by exactly that
reference at upload and on Sync (`resolveRefs` → `fetchNriReturnAuthorizations` /
`fetchNriReferencedRecords`, READ-ONLY):

| Client Ref 1 | NetSuite record | Order type taken from |
|---|---|---|
| `RMA92505` · `RMA #K0Z3WP82` | Return Authorization (tranid · otherrefnum) — also Client Ref 2 = its id | the RA |
| `IF4041483465` | Item Fulfillment — by number when older than the synced window | the IF |
| `CA987809` · `#CA987809` | **Sales Order** whose otherrefnum (web order #) is `#CA987809` | the SO |
| `PO04728` | **Purchase Order** → the location carrying most of its lines | `PO - <location>` |
| `CC 09-01-2026`, `Overtime billing`, `TO# 8`, … | none | Exceptions / service columns |

- **POs: First = Ecomm, Reserved = Wholesale (Lam).** The type is synthesised from the
  location (`PO - FIRST INVENTORY`, `PO - RESERVED`; US also `PO - ECOMMERCE`) and placed
  in Rules step 1 the first time it appears — `/first|ecommerce/` → Ecomm, anything
  else → Wholesale — so the decision is visible and draggable on the Rules page, not
  buried in code. Verified: PO04728 → NRI CA First Inventory, PO04823 → NRI CA Reserved.
  ⚠️ This differs from the team's 2026 hand coding, which put receipts on supplier
  POs in Wholesale regardless of location; the GL still comes from the service (5202).
- **A return with an RA is coded by the RA, not the order.** The index gives a
  record's own number first, then an RA's external ref, then a sales order's web
  order # — `#CA984653` matches both an RA and an SO, and the RA wins.
- **Why web orders needed it:** `CA987809` (Sept 15, $3.41 return + 3 lines) had no
  RA in NetSuite — NRI received the goods without one — and quoted the web order #,
  which neither the IF nor an RA carries. It fell to the service columns, where its
  Storage line landed Wholesale while the rest of the same order was Online.
- References are compared by `svc.refKey`: upper-case, no spaces, no leading `#`.
- **One lookup, not two.** `nriOrderSync.lookupIndex/lookup` now delegate to
  `nriBillingService.orderTypeIndex/orderTypeLookup`. They were separate copies, and
  the coder's Client Ref 2 test read `/^d+$/` — its `\d` lost to an edit script's
  template literal, the same way this change's first draft lost five more. No line
  depended on it (0 of 12,486 on Sept 15), so no figure moved. ⚠️ **Write regexes
  with the Edit tool, never through a shell-quoted or template-literal edit script**;
  a lost `\d` fails silently as "matches nothing".
- Measured on Sept 15 (12,486 lines): the refactor alone left every line and the pivot
  byte-identical; fetching the references then re-decided 8 lines (PO04823 ×4,
  CA987809 ×4) by layer 1, and moved one: CA987809 Storage $0.15 Wholesale → Online.

### GL Codes — service → GL, reviewable and changeable (2026-10-01, per Lam)

Two layers, both shown per service:
- the **coding legend** (`nri_charge_codes`) — what every **Booked** file is coded by. NOT edited
  from this page (it is shared with `/nri-invoices`, and editing it would re-code booked months);
- the **GL for open files** — `nri_gl_rules` (entity, service, gl), applied by `buildCoder` only to
  files NOT marked Booked; `glSource: 'rule'`. Precedence: a hand-coded GL > this page > the legend.
  Only services whose GL DIFFERS from the legend are stored; a GL the legend cannot describe is
  refused, so every line keeps a GL description.

Per service the page also shows lines billed this year and **"Recoded by hand"** — the lines whose
`glOverride` differs from the legend, with their target GL — linking to Cost per GL with that
drill-down open (`/invoices/results?service=…&glSource=manual`). That column is why a GL row and a
service total disagree: Aug 31 2026, GL 5205 $20,151.78 vs Storage $21,019.56 = 7 Storage lines the
team recoded to 5204 (−$1,145.65) + Recoverable Materials coded to 5205 (+$277.87). Services billed
but absent from the legend (Order Cancel/Mod., Rush Order) are listed first, and a warning counts the
lines with no GL at all (not hand-coded).
Verified: setting Order Processing → 5204 moved exactly its 2,239 Aug 31 lines ($2,949.50) from 5201
to 5204 on the open file, Sept 15 (Booked) byte-identical, and reverting restored Aug 31 exactly.

**New services (2026-10-01, per Lam — "they may have new service").** GL Codes → **Add service**: a name exactly as NRI writes it + a GL from the legend's GL list. It is saved in the month's GL settings (from that month on, carried forward); the legend is not edited. Refused: no name, a name already listed (case-insensitive), no GL. A service the legend does not know and with no lines that month can be removed again (×). An added service also gets a card in Rules step 2 (`serviceCards` includes `nri_gl_rules` services) so its channel can be set. GL Codes lists only services the month knows — the legend, its billed lines, and its own/inherited settings — so a service added for October does not read "no GL" in September. Verified in the GUI on October: both refusals, add → saved for Oct (gl 5204), absent from Sept, present in Rules step 2, removed again, October cleared back to inheriting September.

#### By month (2026-10-01, per Lam — "the service could differ by month")

GL settings are **effective by invoice PERIOD-END month** (`nri_gl_rules.month`, YYYY-MM; a file's
month = `periodEnd`, so the Aug 15 and Aug 31 files are August and "July 1 2026.csv" — period
ending 30 Jun — is June; one invoice never splits across two settings). Saving a month stores its
COMPLETE service → GL list; a month with none of its own uses the latest earlier month that has
one, else the legend (`glMonthResolver`) — so a change carries forward, and a one-month exception
is that month changed and the next changed back. `GET /gl-codes?month=` reports `source`
(own / inherited / legend) and lines + hand recodes for THAT month's files; `DELETE /gl-codes`
clears a month. Page: month picker (months with files + the next one), "Save for <month>",
"Clear <month>'s settings"; the "recoded by hand" link opens Cost per GL scoped to the month.
Verified on the open Aug 31: July → Order Processing 5204 moved Aug 31 by $2,949.50 (inherited);
saving August with the legend GLs restored it; clearing August re-inherited July; clearing July
restored the original exactly; booked Sept 15 never moved. Migration:
`scripts/add-nri-gl-rules-month.js` (rebuilds the table, refuses if it holds rows).

#### On wholesale orders (2026-10-05) — and the not-sure flags

`nri_gl_rules.glWholesaleOrder` (NULL = same as `gl`): the GL a service's lines take when the
line sits on a **wholesale order** — it resolves to an order whose type Rules step 1 (in force
for the month) codes Whsle. Warehouse / Data Entry Labour there is fulfilment (5211), not an
Extra Charge. Precedence: hand-coded > **wholesale-order GL** (`glSource: 'wholesaleOrder'`) >
the month's GL > legend. `glMonthResolver(month)` returns `{ from, map, whsle }`.
The coder also raises the review's NOT-SURE flags (`questionsFor` turns them into questions; an
answer is a hand coding, so it is never asked again): `orderNotFound` / `orderNoType` (Client
Ref 1 has an order shape per `nriOrderSync.refKind`, but no / a typeless order is held) and
`glWholesaleAsk` (a Whsle line of a service with a wholesale-order GL, no order behind it).
⚠️ On 2026-10-05 `nriBillingService.js` + `models/NriGlRules.js` were found ROLLED BACK to a
version without any of this while the controller, frontend and DB column kept it: GL Codes 500'd
(`inForce.whsle` undefined), saves dropped the column silently, and the review asked nothing. It
had only kept working because the running process held the newer code. Restored; verified in
memory on Sept 30 (Order Processing → 5211 on wholesale orders moved exactly 125 lines / $250,
5201 → 5211, total unchanged) and over HTTP (GL Codes 200 for Aug/Sept/Oct; review shows 4
`orderNotFound` questions on Sept 30).

### Raw files have no hand coding — so the rules carry the month-by-month decisions (2026-10-01)

Going forward an invoice arrives RAW (NRI's CSV) — nobody types channels or GLs. Measured on the two
raw files with every hand override stripped: Sept 15 rules-only was ~$1.1k off the team, but **Aug 31
was $54k off**, because the team coded whole services differently by MONTH (Aug: Storage 93% Online,
Warehouse Labour 99%, Overtime 100%, Repackaging 100% + GL 5204; Sept: Storage back to Wholesale).

So the **service columns (Rules step 2) are effective by period-end month too** — `nri_class_rules.month`
(serviceColumn rules only; NULL = the starting columns; order-type and exception rules apply to every
month). Same carry-forward rule as GL Codes (`ruleMonthResolver`). The Rules page has a month picker
on step 2; a save only writes the month's columns when they changed (`saveColumns`), so editing an
exception never gives a month its own columns; `DELETE /rules/columns` clears a month.

**Every section is by month (2026-10-01, per Lam — "for the rules, can we have by month also?").**
Step 1 (order type), the Exceptions and step 2 each carry forward ON THEIR OWN: `ruleMonthResolver`
resolves each kind to the rows of its latest saved month at or before the target, else its month-NULL
rows (the starting rules). One month picker at the top of Rules; each section says where its settings
come from ("Set for this month" / "Using August 2026's" / "Using the starting rules"). A save writes only
the sections that CHANGED (`saveKinds`), so editing an exception never freezes the month's order-type or
service columns. A section saved EMPTY (every exception removed for a month) is stored as one disabled
placeholder named `__empty__` (`EMPTY_SET`), so "set to nothing" is not mistaken for "not set" and the
month does not inherit. `DELETE /rules/month` clears everything set for a month. New NetSuite order types
are placed in the starting step 1 AND in every month that has its own (`nriOrderSync.placeNewTypes`).
Verified over HTTP: an exception added for Sept → Sept own, Oct inherits it, Aug keeps the starting ones,
Sept's step 1/2 untouched; Oct emptied → Oct has none; cleanup → all rules identical to the start.

⚠️ OPEN: an intermittent HTTP 500 from the Next.js dev server on a full-page GET of `/invoices/rules`,
seen 3 times, each on the first test run after a backend restart / code change; never on demand, the page
still rendered, and the backend logged nothing. The message is only in the `npm run dev` terminal.

**Seeded from the team's 2026 coding** — `scripts/seed-nri-month-settings.js` (`--dry-run`, skips
months already set unless `--force`): per month and service, the channel by $ majority over the lines
the columns decide, and the GL by $ majority; saved only where a month differs from what it inherits
(6 months each). Rules-only vs the team, whole year: **channel off $154,454 → $34,147; GL off $71,085
→ $53,849**. Aug 31 rules-only: Whsle $31,904 / Online $87,973 (team $29,569 / $90,125); Sept 15:
$30,162 / $46,688 (team $30,660 / $46,191).

The seeded settings are KEPT as the portal's record of how the team coded each 2026 month (Lam, 2026-10-01), independent of which invoices are loaded — deleting invoices never removes them, and a new month inherits the latest. September 2026's GL list was missing after the seed (cause not established) and was saved by hand; an audit of every 2026 month against the team's majority coding then found 0 GL and 0 channel disagreements.

**What is left is within-month SPLITS** the script reports (majority < 80%) — a per-service setting
cannot express them:
- Receiving / Receipt Mixed Carton / Inbound Units Audit / Receipt Processing: receipts on supplier POs
  (`PO04728`, `TO01206`) → Wholesale + 5202; receipts on transfers / returns-type refs
  (`S07539371 / GoBolt Final Transfer`, `Transfer Order …`, `FO-…`, `IF…`) → **Online + 5204** ($19.8k
  Jun–Aug). An exception could express this, but exceptions set only the channel today — not the GL.
- One-off freight lines: "GoBolt to Kamloops – 14 pallets" → GL 2057 ($12,865, Jul); "16 pallets tentree
  transfer" → 5204 ($8,673, Aug). One-time decisions — a hand correction on the line, not a rule.

### Review after upload — confirm services → channel + GL, THEN Cost per GL (2026-10-01, per Lam)

The flow is **upload → review popup → confirm → Cost per GL**. Saving an invoice on Uploads
opens `ReviewDialog`: one row per NRI service on that file (lines, charges), a Wholesale/Ecomm
toggle and a GL select, both **pre-filled** from the settings in force for the file's
period-end month, each with a hint — `set for September 2026` (the month's own setting),
`from August 2026` (carried forward), `starting rules`, `coding legend`. A service with no GL
anywhere is listed first, highlighted, and must be given one before Confirm.

- `GET /nri-billing/files/:id/review` → `{ file, month, locked, services[], glOptions[] }`.
  `byOrder` = lines that step 1 (order type) or an exception decide, so the hint reads "2,617 of
  2,618 lines go by order type" — the toggle is the SERVICE column (step 2) and does not recode
  those lines. Without that hint, flipping Outbound Freight to Wholesale would look like it
  moves $32k when it moves one line.
- `POST /nri-billing/files/:id/confirm { services:[{service, channel, gl}] }`. Answers are
  MERGED into the month's in-force lists; the month gets its OWN service columns only if a
  channel differs, its own GL list only if a GL differs (each written whole, so it carries
  forward like a save on Rules / GL Codes). Confirming the suggestions unchanged writes NO
  settings — it only stamps `nri_billing_files.confirmedAt/By`
  (`scripts/add-nri-file-confirmed.js`). 400 on a missing GL or a GL not in the legend; 409 on
  a booked file.
- **Only what needs a person is shown open** (2026-10-02, Lam: "quite a lot of things to
  verify"). Each service carries `check[]`: `noGl`; `channelVaries` / `channelNew` —
  only when the service column actually decides some of its lines (NetSuite and the
  exceptions decide the rest) and the team has put it on both sides in months that saved
  their own settings, or no month has ever set it; `glVaries` — posted to more than one
  GL across those months. `channelHistory` / `glHistory` are the runs the popup prints
  ("Wholesale Feb–Jul · Ecomm Aug–Sep"). The starting rules are a default, not a
  decision, so they are not history. Everything without a reason folds under "N services
  decided automatically", still editable. Sept 15: **4 of 28** (Warehouse Labour,
  Overtime, Repackaging, Data Entry Labour); 12,449 lines / $68,733.31 folded.
- Unconfirmed is a STATE, not a gate: Cost per GL still renders an unreviewed file (with the
  suggestions) and shows a banner with a **Review services** button. Uploads has a Review
  column (`Needs review` · `✓ Confirmed`, click to review again · `Booked`). **Later** closes
  the popup and leaves the file Needs review. A re-upload starts unreviewed.
- Verified: a GL change moved exactly that service's charges between GL rows (Shop Supplies
  5210 → 5204, $43.02), grand total unchanged; confirming back restored the month's GL list and
  a byte-identical pivot; in the GUI, upload → popup → Confirm lands on
  `/invoices/results?files=<id>` with no banner and the list shows ✓ Confirmed; the table
  scrolls inside the dialog so Confirm stays on screen with 31 services; 0 console errors.

### The rate check — the card VALIDATES, it never produces a charge

Charges come only from NRI's lines. `nriBillingRates.checkLine` compares each billed line to
the card and returns a verdict, which is rolled into buckets that always sum to the
selection: **verified · flagged (over/under) · hours don't tie · storage blend ·
pass-through · not in agreement**.
`SERVICE_RATES` maps NRI service names to Rate Codes (the names differ: "Order NonMasterPack"
is "Outbound Handling – B2C"); the RATES are read from the uploaded card, so replacing a card
re-validates everything.
- **Channel-aware outbound (CA).** Order Type ECOM → B2C codes (FUL-02/06), trade types → B2B
  (FUL-03/07). Measured on Sept 15: every ECOM line is billed 1.25/0.65, every trade line
  2.00/0.50. Over the year 112 ECOM lines were billed the B2B $0.50/unit (−$38.25).
- **Storage is billed as one BLENDED line per month** (Aug 31: 282,015 units at $0.068 — between
  the $0.05 and $0.07 tiers). It is `tierBlend` when inside [lowest × units, highest × units],
  and flagged only outside. All 9 storage months in 2026 are inside.
- **Tested by tampering** a copy of Sept 15 over HTTP: +10% rate → overcharge +$0.13;
  qty 3→4 at the same charge → undercharge −$0.65 vs B2C; an unknown "Mystery Fee" →
  not in agreement + unmapped + no class.
- Year to date: verified 28,574 lines / $393,574 · flagged 124 / $277 · hours don't tie
  2,237 / $57,425 (see Units below) · storage blend 9 / $106,700 · pass-through 21,569 /
  $329,696 · not in agreement 112 / $37,618.

### Data findings — read before trusting the workbook's history

1. **`NRI CA Invoice June 1 2026.csv` IS the May 31 invoice.** 814 identical lines, every
   completion date in May, $14,838.78. The workbook's year view counts it twice. The
   portal detects re-sends (fingerprint = OrderID, Service, Completed, Units, Charges; ≥20
   shared lines and ≥50% of the smaller file): an upload is refused with 409 `duplicate`
   unless forced, and Results warns about any duplicate pair. Both files are kept as imported —
   deleting one is the team's decision.
2. **The workbook rounded `Units` to whole numbers.** Its Power Query typed the column as an
   integer, so NRI's fractional hours became 0.42 → 0 and 11.5 → 12 (3,085 lines in Sept 15
   alone). Charges are unaffected, so the GL pivot is right; but every hourly line in the 17
   months imported from the workbook reads "hours don't tie". Sept 15 was re-uploaded from
   NRI's RAW file (11,072 overrides carried, pivot byte-identical) and reads 0. **Re-upload
   the other months' raw CSVs** to clear it: unlock the file, upload, then lock it again.
3. **NRI's CSV is Windows-1252, not UTF-8** — "Hélène", "Frédérique". Read as UTF-8, the accents
   became the workbook's `STÃ‰`-style mojibake. `decodeText` tries strict UTF-8 first, then
   falls back to Windows-1252.
4. The report is a printout: 4 banner rows (the invoice # and period end exist ONLY there), an
   unnamed column after Client Ref 1, `$`-text money, `MM/DD/YYYY` dates, a page footer, and
   repeated headers. The header row is found, not assumed.

### ONE rate table (2026-09-30, per Lam)

`nri_contract_rates` — the uploaded cards — is the only rate table. `lib/nriRateCard.load()`
(the older `/nri-invoices` validator) DERIVES its rows from the cards through the same
`SERVICE_RATES` map, so both checks price a service from the same number. Verified: the
derived US rows match the old hand-seeded `nri_rate_card` on 36 of 37 current-period
services; the 37th ("Pallet storage (non-standard products)") was missing from the map and was
added. `nri_rate_card` is no longer read; its rows were left in place.
Consequence: a card has ONE effective period (US from 2026-02-01), so the hand-seeded 2025
US rates are gone from the old validator — a line dated before the card reads
`noRateOnFile` until the earlier card is uploaded. Uploading a card clears the old
validator's cache (`nriRateCard.reload()`).

Still shared: the legend (`nri_charge_codes`) and the order master (`nri_order_master`).
Still separate: `nriLineClass` (the old US order-inference classifier) — no page uses it now.

---

## The older flow: US three-way verification (`/nri-invoices` API)

Replaces the `NRI US_ALL Invoices 2026.xlsx` Power Query workbook.

## ⚠️ Naming: camelCase FIELDS, snake_case stored VALUES (2026-09-22)

Every field in this module is camelCase — `invAmt`, `codingStatus`, `tieOut`,
`impliedHours`, `byGl` — in the database, the service, the API and the UI.
497 identifiers were renamed across 21 files.

**Three things were deliberately NOT renamed, and the distinction is the point:**

1. **`nri_rate_card.basis` VALUES** — `per_month`, `per_hour`, `per_unit_month`,
   `per_receipt`, `per_order`, `per_unit`, `per_pallet`, `per_shipment`,
   `per_edit`, `composite`, `market`, `none`, `passthrough`. These are **stored
   data** in 41 rows that `rateCard.checkLine` switches on. Renaming the code
   without migrating the rows would stop every rate matching **silently** — the
   same trap that hit `transit_time_standards.segment`.
2. **Table names** — `nri_rate_card`, `nri_charge_codes`, … are `models.<table>`
   registry keys.
3. **Row ids and parser names** — `ncc_administration_fee`, `nlo_48872_1710`,
   `nri_us`. Values, not fields.

The DERIVED vocabulary DID move, because nothing stores it (the invoice tables
were empty) and both ends changed together: verdicts are now `qtyUnsupported`,
`noRateOnFile`, `noContractRate`, `agingPremium`, `needsCoding`, `needsClass`.
Backend and frontend were verified to use an identical set of 11 strings.

### ✅ FIXED 2026-09-28: `verify-reconcile.js` had drifted twice over

The CLI had been dead for its whole life and nothing required it, so nothing
said so. Two separate faults, and the second is the interesting one:

1. It required `./returnsClass` — a module that has **never existed anywhere in
   this repository's history** (confirmed against `git log --diff-filter=A`).
   That threw `MODULE_NOT_FOUND` on load.
2. It passed the result as **`orderContext`**, but `nriInvoiceService.reconcile`
   destructures **`orderIndex`** and has never read `orderContext`. So even once
   the require was satisfied, the argument would have been silently dropped and
   the NetSuite CLASS would have come back unresolved on every line — a wrong
   answer rather than a crash.

Both now mirror `orderMaster()` in `nriInvoiceController`, which is the live
path this script exists to reproduce: `nriOrderData.load({ workbook, stored })`
→ `nriLineClass.buildOrderIndex(master)` → `reconcile({ …, orderIndex })`, with
portal-uploaded rows ingested last so they win.

Measured over 3,000 real charge lines from the combined workbook: with the index
the reconcile resolves **`(unclassed) · Amazon-US · INTL - Online · US - Online ·
US - Whsle`**; without it only **`(unclassed) · Amazon-US · US - Whsle`**. The
two order-dependent classes are exactly what had been silently dead.

Also fixed while there: the script now honours `NRI_ORDER_DATA_WORKBOOK` like the
controller, and closes the Sequelize pool on exit (it reads three DB-backed
indexes, so without that it printed its report and then hung).

⚠️ It still needs a real per-invoice NRI **detail export**; no such fixture is in
the repo, so a full run cannot be demonstrated here. Pointing it at the combined
`_ALL Invoices` workbook fails with `could not find the detail header row`, which
is the correct domain error for the wrong input.

## One tab per invoicing WAREHOUSE (2026-09-10)

The section was called "NRI Invoices" with NRI US hardcoded, which named one
vendor after the whole capability — and every warehouse sends a differently-built
invoice workbook. Which warehouses exist is now DATA:
`data/nri/nri_invoice_sources.json`, one row per warehouse = one tab under
**All Invoices** (`/invoices/<code>`, e.g. `/invoices/nri-us`).

| field | meaning |
|---|---|
| `code` | URL segment (`nri-us`) |
| `label` | what the tab says (`NRI US`) |
| `entity` | the key the REST of the module already turns on — `nri_charge_codes.class_us`/`class_ca`, the entity-keyed rate card, `lineClass`, the `nri_<entity>_<invoice_no>` id |
| `facility_id` | optional link to `warehouse_facilities` |
| `parser` | which detail-file layout to read the workbook with. **NULL = none mapped** |
| `upload_enabled` | false while `parser` is null |
| `note` | why uploads are off — shown on that warehouse's page |

`parser: null` is the important part. A warehouse registered through the UI is a
**shell**: its tab, invoice list and slice of the legend/rate card exist at once,
but uploads are refused *with the reason* rather than parsed with somebody else's
layout — registering a warehouse cannot invent a reader for a format nobody has
seen, and guessing one loads misread charges into the GL. `POST /sources`
deliberately does not accept `parser`/`upload_enabled`: enabling a warehouse means
mapping its layout in code.

This replaced `if (entity !== 'US') return 400` in `preview`/`create`, so adding a
warehouse is no longer a code change. `?warehouse=<code>` is accepted everywhere
`?entity=<US>` was, and the old form still works.

**NRI CA is registered but shelved on purpose** — its workbook is built
differently (`Summary_Coded` plus its own *diverged* embedded legend, 60 rows
against the master's 61) and no raw CA file has been checked. The legend and rate
card already hold CA columns, so CA invoices will code and validate the moment the
layout is mapped.

Removing a warehouse is refused while it holds invoices (they key on `entity`, so
it would orphan them).

**Additive & isolated.** Owns `data/nri/*` and reads nothing from `sms_*`,
`mainline_*` or `po_*`. Mounted with one line in `server.js`; one nav entry in the
sidebar. Reuses the `landed_costs` permission (Admin + Logistics), so **no role
file needs editing** to deploy it.

## The three-way verification

| Side | Document | Question it answers |
|---|---|---|
| **Invoice** | the PDF | Does the detail add up to what NRI is actually billing? |
| **Data** | the detail `.xlsx` | What are we coding? |
| **Agreement** | `nri_rate_card.json` | Is each line priced per the contract? |

Only the PDF carries the invoice number, dates, terms, FX rate and per-service
control totals — none of that is in the workbook, which is why the existing
pipeline has no invoice number and no way to prove a detail file is complete.

⚠️ **NRI stopped filing invoice PDFs after 2022** (2026: 16 xlsx, 0 PDFs). Without
one the tie-out returns `noSummary` — loadable but visibly unproven. Getting the
PDFs filed alongside the workbook is a process change worth more than any code
here.

## Files

⚠️ These lived in `modules/nriinvoices/` until the 2026-09-28 move to layer-first
MVC (see `backend/README.md`). They are now spread across `lib/`, `services/`,
`controllers/` and `routes/`, and the eight helpers gained an `nri` prefix —
`rateCard.js` said "the NRI rate card" inside a module folder and says nothing in
a shared `lib/`.

| File | Role |
|---|---|
| `lib/nriXlsxStream.js` | dependency-free streaming `.xlsx` reader (the sheets are 50–112 MB inflated — SheetJS cannot open them) |
| `lib/nriInvoiceParser.js` | PDF header + per-service totals; detail xlsx; combined `_ALL` workbook; order master |
| `lib/nriChargeCodes.js` | `Service` → GL + class, per entity (the coding legend as data) |
| `lib/nriSyncLegend.js` | re-sync the legend from the shared drive; reports its defects |
| `lib/nriRateCard.js` | the agreement as an effective-dated validator |
| `lib/nriLineClass.js` | derives the NetSuite CLASS per line from the order (see below) |
| `lib/nriOrderData.js` | loads + merges the order master (periodic CSVs + workbook snapshot) |
| `lib/nriInvoiceSources.js` | which warehouses exist, and which have a parser |
| `services/nriInvoiceService.js` | **pure** three-way reconcile: tie-out, coding, validation, rollups, findings |
| `lib/NriInvoiceModels.js` | its own five tables under `data/nri/` |
| `controllers/nriInvoiceController.js` / `routes/nriInvoiceRoutes.js` / `validators/nriInvoiceValidator.js` | HTTP |
| `scripts/verify-reconcile.js` | read-only CLI: `node scripts/verify-reconcile.js <pdf> <detail.xlsx> [US\|CA]`. Mirrors the upload endpoint; needs a per-invoice DETAIL export, not the combined `_ALL` workbook |

## Flow

Two lookups are CONFIGURED once (Setup, `/invoices/<warehouse>/setup`), then each
invoice runs through the same four steps:

```
1. legend      POST /charge-codes/sync   (multipart `legend`=xlsx, or a path, or the shared drive)
               `dryRun=true` reports the file's defects WITHOUT adopting it
2. order data  POST /order-data          (multipart `file`=the `NRI Order data` sheet or a period CSV)
               UPSERTS by order #, so a later period tops the master up
3. invoice     POST /preview   reconcile, save NOTHING
               POST /          commit; 422 unless the tie-out balances (force=true to override)
4. exceptions  PUT  /:inv/lines/:seq   per-line human decision
               POST /:id/submit        freeze; refuses while any value-bearing line is uncoded
```

**Why 1 and 2 are both required, and what each answers.** The legend fixes the GL
per SERVICE. The class is a property of the ORDER, and no invoice line states the
channel or the ship-to country — those come from the order master (`OrderType`,
`Ship To Country`), joined on `Client Ref 1` → `Order #`. Without step 2 the GL is
right and the class is `null`, which is a flag, never a guess. Both inputs used to
be read off a mapped `G:` drive; both can now be uploaded, so the pipeline runs on
any machine.

**The result is the workbook's `Pivot` tab**: rows = GL + description, columns =
class, values = Σ Charges, grand totals both ways (`GlClassPivot`, computed from
the lines so an override moves it immediately). Anything uncoded sits in its own
**Needs coding** column — in the grand total, so the total always equals the
invoice, but never folded into a real class. Measured on invoice 48872: grand total
$39,511.77 = Σ Charges = the PDF SubTotal, with $5,487.73 across 1,444 lines
flagged; coding one $1.70 line moved exactly $1.70 out of Needs coding into
`US - Whsle` and left the grand total untouched.

Re-uploading an invoice **replaces its lines wholesale**, never appends.

## Four legend defects this fixes

Verified against the live legend (61 rows):

1. **`EDI Transmission` appears twice** (once with a trailing space).
   `Table.NestedJoin` + Expand multiplies rows on duplicate keys, so if both ever
   matched the same value **the charge would silently double**. The key is unique
   by construction here.
2. **`"Recoverable Materials "` and `"EDI Transmission "` carry trailing spaces.**
   The M join is exact-match, so they resolve only because NRI's file happens to
   carry the same space. Matching is normalised (trim + case-fold + collapse).
3. **`Warehouse Labor` → GL 5211 but `Warehouse Labour` → GL 5204.** Same service,
   two spellings, two accounts. `ALIASES` collapses them.
4. **A `LeftOuter` miss yields a NULL GL, which the pivots render as GL 0.** Here an
   unmapped service is `needsCoding` and blocks submit. Never a silent zero.

Plus: 7 legend rows have a blank US class. They code to `needsCoding` for that
entity rather than posting unclassed.

## Rate card: three principles the data forced

1. **Effective-dated.** The 2026 agreement starts 2026-02-01 and the GRI moved four
   rates ($1.66→$1.70, $0.64→$0.657, $0.126→$0.129, $10.50→$10.76). A single-rate
   table gets all 1,430 January order lines wrong.
2. **Compare the LINE TOTAL, never the implied rate.** NRI rounds each line to
   cents, so `charge / units` produces 30 distinct "rates" for a flat $0.657
   (1 unit → $0.66; 2 units → $1.31 → 0.655). Tolerance is $0.01 + $0.01 per 100
   units, which absorbed every clean line across all 16 US invoices.
3. **Hourly quantity is not verifiable.** The `Units` column on hourly lines is a
   rounded hour count that does not tie to the charge (Cycle Count: Units 332
   against 340.00 actual hours). Hours are derived from the charge and only the
   RATE is checked — the verdict says `qtyUnsupported` rather than pretending.

Storage is special: the base rate is a floor and the agreement permits +50/+100/+200%
aging uplift, so it reports an `agingMultiple` instead of passing/failing, and only
calls `overcharge` above the 3× ceiling.

## Class derivation — verified against finance's coding of invoice 48872

The GL is a property of the SERVICE. The **CLASS is a property of the ORDER**, and
the legend's one-class-per-service cannot express it. Finance's correct coding uses
four classes the legend does not contain:

| | rule |
|---|---|
| `Amazon-US` | Amazon customer |
| `INTL - Online` | ECOM + ship-to outside the US |
| `US - Online` | ECOM + ship-to United States |
| `US - Whsle` | WHOLESALE / PREBOOK / AT ONCE, and every non-order charge |

**Result on invoice 48872: all 9 GL totals match finance to the cent**, and in 6 of
9 GLs the entire class-level difference equals the lines whose order is missing —
exactly. True residual disagreement is **$98.58 of $39,511.77 (0.25%)**.

⚠️ **The limiting factor is order-data coverage, not the rule.** NRI delivers order
data as periodic CSVs (`NRI US Order Data/<period> order data US.csv`); only
"August 1-14" exists, so 1,443 lines / $5,497 of the Aug 31 invoice cannot be
classed. Those are reported as a BLOCKER, never defaulted to wholesale — that
default is what makes the workbook read `US - Whsle $38,369` against finance's
`$26,543`. Drop the missing CSV in and `POST /order-data/refresh`.

`Mobile Mini` (the legend's class for Recoverable Materials) does **not** appear in
finance's coding — that $784.00 is `US - Whsle`. Legend classes are never emitted.

### Returns (GL 5203) are the hard case

The legend assigns **one hardcoded class** to all three returns services and notes
*"majority is usually ecom"*. That is **true by row count and false by dollar** —
and the two entities picked opposite defaults, so each is wrong in a different
direction:

| Entity | Legend default | Measured truth (by dollar) |
|---|---|---|
| US | `US - Online` | **69.4% wholesale** ($15,796 misclassed) |
| CA | `CA - Whsle` | **61.9% online** ($7,395 misclassed) |

Per-row economics: wholesale return **$87.91**, ecom return **$1.99** — 44×, which
is why counting rows misleads.

### Why not just join on OrderType

That route — `Client Ref 1` → order master `Order #` → `OrderType` — is what the
workbook's XLOOKUPs do and it **resolves 1.4% of returns lines (51 of 3,527)**.
Returns carry *return* identifiers (`RMA #8IZT9J1W`, `RMA88141`, `RA: AMAZON`), not
outbound order numbers. SANMAR and NORDSTROM are absent from the order master
entirely.

### Precedence

| # | Basis | Confidence | Key |
|---|---|---|---|
| 0 | `customerDeclared` | `declared` | `CUSTOMER_CHANNEL[custcode ‖ name]` |
| 1 | `orderNo` | `exact` | `Client Ref 1` → order master `Order #` |
| 2 | `ref2` | `exact` | `Client Ref 2` → order master `Ref2` |
| 3 | `custCode` | `derived` | CustCode from `Customer` → dominant `OrderType` |
| 4 | `custName` | `derived` | name from `Customer` → dominant `OrderType` |
| 5 | `refFormat` | `inferred` | `Client Ref 1` format |
| — | none | `unresolved` | `class: null` — blocks submit, never guessed |

`Client Ref 1` format rule: `^RA[:#]` → wholesale; `^RMA\s*#\s*\d+$` → wholesale;
`^RMA\s*#` (alphanumeric) → online; `^RMA\d+$` → wholesale.

**Measured agreement of basis 5 against an authoritative lookup, where both fire:**
US **2,559/2,564 (99.8%)**, CA **273/273 (100%)**. That is the evidence for trusting
it where only it fires. ⚠️ CA leans much harder on it (93% of rows) because its
order master holds 4,790 rows against the US's 33,065.

### Prep spec ≠ sales channel

`OrderType` is a **clean channel field**, not a packing flag — `BACKCOUNTRY.COM` is
tagged `WHOLESALE`, which a packing-mode field never would be. The confusion comes
from the shipping instruction: Nordstrom's reads *"ECOM ORDER TYPE - UNITS NEED TO
BE FLAT PACKED AND POLYBAGGED - UPC STICKER ... AFFIXED TO THE OUTSIDE OF THE
POLYBAG"*. That is retail-ready unit prep, so a Nordstrom return is *handled* like
an ecom return (one polybagged unit, scan, restock: **$1.67/row**) while SANMAR's
bulk cartons need Service Center Labor (**$204/row**). Both are wholesale revenue.

**Cost shape follows the prep spec; the GL class must follow the revenue channel.**
They diverge exactly for retail-ready / dropship accounts, which is why basis 0
exists and outranks every inference.

`SANMAR` is deliberately not in `CUSTOMER_CHANNEL` — basis 5 already classes it
correctly. Add it to stop depending on an inference.

## Coverage (US 2026 YTD)

| | |
|---|---|
| Returns lines | 3,527 · $22,771.79 |
| Resolved | **98.8% rows · 95.7% $** |
| Unresolved | 44 rows · $981.53 — **89% of it is 15 rows with a blank `Customer`** |

## Verified against invoice 48872

- 3,775 lines — the same count the existing Power Query pipeline produces
- Σ Charges **$39,511.77** = the PDF SubTotal; Σ Inv. Amt **$39,648.09** = the PDF Total
- Tie-out **balanced** across all 28 services, variance $0.00
- Found 3 anomalous `Handling` lines of 834 (10 units charged $27.10 against $6.57)
- Storage at **1.649× base**, +$5,359.30 premium, no aging breakdown on the invoice

## Deliberate deviation from the workbook

`parseDetailWorkbook` **detects** the header row instead of `Table.Skip(7)`. That 7
was measured against a 2025 exemplar (the `Sample File` query still points at the
2025 folder) and the 2026 files put the header on sheet row 7, so a blind skip
lands past it. NRI has already moved the banner once.

## Not done

- **CA's file layout.** Its workbook is built differently (`Summary_Coded`, its own
  *diverged* embedded legend — 60 rows vs the master's 61, and `Transfer Order
  fulfillment & receipt` differs). It is registered as a warehouse with
  `parser: null`, so its tab and list are live and `POST /preview` refuses uploads
  with that reason until a raw CA invoice file has been checked. Mapping it means
  adding its layout to `invoiceParser` and setting `parser` + `upload_enabled` on
  its registry row.
- **Credit memos.** NRI issues them as numbered invoices with negative amounts
  (e.g. 39646 −$52.40). The parser sets `isCredit`, but no credit has been loaded
  and 2026 has none on file — so the loaded total is gross.
- No NetSuite push. `submit` produces the posting lines (GL × class); posting them
  is a separate decision.
