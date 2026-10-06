# NRI CA Invoice Coder (Node.js)

Replaces `NRI_CA_ALL_Invoices_2026.xlsx` (Power Query + Summary_Coded formulas + pivots).
Verified against the workbook: **52,625 lines, 0 differences** in Class, GL, GL Desc, Order Type, Month.
Sept 15 pivot = **$76,850.43** (Online $46,190.69 / Whsle $30,659.74) — same as Excel.

## Setup
```bash
npm install
node scripts/migrate-from-excel.js NRI_CA_ALL_Invoices_2026.xlsx   # one-time (already done, data/ is included)
```

## Monthly use
1. Drop the new NRI invoice CSV into `data/invoices/` (file name = Source.Name).
2. Refresh `data/orders.csv` with the latest NRI order export (for Order Type).
3. Run:
```bash
node src/index.js                                                  # all invoices
node src/index.js --source "NRI CA Invoice Sept 30 2026.csv"       # one invoice (like the pivot filter)
node src/index.js --json output/coded.json                         # also dump JSON for the portal
```
4. Check the **Exceptions** tab. Fix by adding a row to `data/overrides.csv` or the service to `config/coding.json`, then re-run.

## Excel → code map
| Excel | Code |
|---|---|
| Power Query folder combine | `io.readInvoiceFolder()` — drops repeated header/blank rows |
| NRI Invoice Coding sheet | `config/coding.json` |
| Manual Class / GL Override columns | `data/overrides.csv` (key = file + OrderID + Service) |
| Revised Class / GL / GL Desc formulas | `coder.js` |
| `TEXT(Completed,"mmm-yyyy")` | `month` |
| `VLOOKUP(Client Ref 1, NRI Order data)` | `orderType` from `data/orders.csv` |
| Pivot sheet | tabs *Pivot GL x Class*, *Service by Invoice* |
| Unit Rates sheet | tabs *GL x Service (Inv Amt)*, *Monthly Unit Rates* (no #DIV/0!), *Contract Unit Rates* |

## New vs Excel
- **Class rules** (`config/class-rules.json`) auto-code new invoices: ECOM → Online, GoBolt transfers → Online, returns → Online.
  On Sept 15 data they reproduce the hand coding to within ~$1.1k of $76.9k. Manual overrides always win.
- **Locked files** (`config/locked-sources.json`): the 18 historical invoices are already booked — rules never recode them.
- **Exception flags**: `UNMAPPED_SERVICE`, `NO_COMPLETED_DATE`, `TOTAL_MISMATCH` (Charges + Taxes ≠ Inv. Amt), `UNKNOWN_GL`.
- Each line shows `classSource` / `glSource` (coding / rule:name / manual) for audit.

## Use inside the portal
```js
import { loadConfig, codeInvoices, buildReports } from './src/pipeline.js';
const cfg = await loadConfig({ codingFile: 'config/coding.json', rulesFile: 'config/class-rules.json',
  ordersFile: 'data/orders.csv', overridesFile: 'data/overrides.csv', lockedFile: 'config/locked-sources.json',
  ratesFile: 'config/contract-rates.json' });
const lines = codeInvoices(rawRows, cfg);   // rawRows = parsed CSV rows + 'Source.Name'
const reports = buildReports(lines, cfg);
```
