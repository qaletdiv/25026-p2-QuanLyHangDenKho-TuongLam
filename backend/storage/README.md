# backend/storage — files, not records

Records live in Postgres (`backend/database/`). This directory holds actual
files: the documents the portal generates, the blank templates it serves, and
the source material the NRI module reads.

```
storage/
  fileStorage.js        uploadFile() — the only writer
  uploads/              ⚠ SERVED  generated CI / packing list / ASN workbooks
  templates/            ⚠ SERVED  blank templates staff download
  reference/            not served — source documents
    agreements/         signed 3PL rate agreements (COMMERCIALLY SENSITIVE)
    nri/                the ALL-Invoices workbooks + GL coding legend
    samples/            example invoice, WIP report, screenshot
  archive/              superseded backups, kept for history
```

## ⚠️ `uploads/` and `templates/` are reachable over HTTP. Nothing else is.

`server.js` mounts both **below the auth gate**, so they need a valid JWT — and
`/templates` additionally refuses Vendors, because some of those workbooks are
other suppliers' POs:

```js
app.use('/uploads',   require('./routes/documents'));     // per-document ownership check
app.use('/templates', vendorsRefused, express.static(...));
```

`/uploads` is **not** plain static: `routes/documents.js` resolves each filename
to its owning record and applies the same vendor scoping as the rest of the read
path, so a leaked URL for another supplier's commercial invoice returns 404.

**Do not put anything in `templates/` that every non-Vendor user should not be
able to download.** That is why the signed rate agreements live in
`reference/agreements/` and not there — `express.static` would have served a
commercially sensitive contract to any authenticated Logistics, Production or
Freight Forwarder account.

`reference/` and `archive/` are read from disk by code or by a human, never
served.

## What reads what

| path | read by |
|---|---|
| `uploads/` | `fileStorage.uploadFile()` writes; `routes/documents.js` serves |
| `templates/` | `express.static` in `server.js`; `scripts/generateCiTemplate.js` writes |
| `reference/nri/NRI US_ALL Invoices 2026.xlsx` | `nriInvoiceController` order-data loader — override with `NRI_ORDER_DATA_WORKBOOK` |
| `reference/nri/…Coding Legend.xlsx` | a local copy; `syncLegend.js` reads the **Google Drive** original |
| `reference/agreements/`, `reference/samples/` | humans |
| `archive/` | nobody — superseded backups |

## Not seed data

`database/seed-data/` holds JSON that seeds *tables*. Nothing here does — these
are opaque files. The two were mixed together under the old `backend/data/`,
which is why `uploads/` and a 24 MB source workbook once sat in the same tree as
the reference tables.
