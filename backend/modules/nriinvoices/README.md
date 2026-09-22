# 3PL invoice verification — All Invoices (`/nri-invoices` API, `/invoices` UI)

Replaces the `NRI US_ALL Invoices 2026.xlsx` Power Query workbook.

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
one the tie-out returns `no_summary` — loadable but visibly unproven. Getting the
PDFs filed alongside the workbook is a process change worth more than any code
here.

## Files

| File | Role |
|---|---|
| `xlsxStream.js` | dependency-free streaming `.xlsx` reader (the sheets are 50–112 MB inflated — SheetJS cannot open them) |
| `invoiceParser.js` | PDF header + per-service totals; detail xlsx; combined `_ALL` workbook; order master |
| `chargeCodes.js` | `Service` → GL + class, per entity (the coding legend as data) |
| `syncLegend.js` | re-sync the legend from the shared drive; reports its defects |
| `rateCard.js` | the agreement as an effective-dated validator |
| `lineClass.js` | derives the NetSuite CLASS per line from the order (see below) |
| `orderData.js` | loads + merges the order master (periodic CSVs + workbook snapshot) |
| `nriInvoiceService.js` | **pure** three-way reconcile: tie-out, coding, validation, rollups, findings |
| `NriInvoiceModels.js` | its own five tables under `data/nri/` |
| `nriInvoiceController.js` / `nriInvoiceRoutes.js` | HTTP |
| `verify-reconcile.js` | read-only CLI: `node modules/nriinvoices/verify-reconcile.js <pdf> <xlsx>` |

## Flow

Two lookups are CONFIGURED once (Setup, `/invoices/<warehouse>/setup`), then each
invoice runs through the same four steps:

```
1. legend      POST /charge-codes/sync   (multipart `legend`=xlsx, or a path, or the shared drive)
               `dry_run=true` reports the file's defects WITHOUT adopting it
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
   unmapped service is `needs_coding` and blocks submit. Never a silent zero.

Plus: 7 legend rows have a blank US class. They code to `needs_coding` for that
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
   RATE is checked — the verdict says `qty_unsupported` rather than pretending.

Storage is special: the base rate is a floor and the agreement permits +50/+100/+200%
aging uplift, so it reports an `aging_multiple` instead of passing/failing, and only
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
| 0 | `customer_declared` | `declared` | `CUSTOMER_CHANNEL[custcode ‖ name]` |
| 1 | `order_no` | `exact` | `Client Ref 1` → order master `Order #` |
| 2 | `ref2` | `exact` | `Client Ref 2` → order master `Ref2` |
| 3 | `cust_code` | `derived` | CustCode from `Customer` → dominant `OrderType` |
| 4 | `cust_name` | `derived` | name from `Customer` → dominant `OrderType` |
| 5 | `ref_format` | `inferred` | `Client Ref 1` format |
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
  (e.g. 39646 −$52.40). The parser sets `is_credit`, but no credit has been loaded
  and 2026 has none on file — so the loaded total is gross.
- No NetSuite push. `submit` produces the posting lines (GL × class); posting them
  is a separate decision.
