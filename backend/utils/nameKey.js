'use strict';

// Shared matching keys for master-data NAMES. Pure helpers — no I/O, no module
// state — so the mainline and SMS ingestion paths can both use them without
// coupling (they stay separate datasets; only reference data is shared).
//
// `norm` is the long-standing key: trim → lowercase → collapse whitespace. It is
// what every name→id resolver uses.
//
// `supplierKey` exists because `norm` is NOT punctuation-insensitive, and that
// let the SMS NetSuite sync mint duplicate supplier rows: NetSuite sends
// "Best Star Fashions Co., Ltd." while the legacy master data holds
// "Best Star Fashions Co Ltd" — same vendor, different `norm`, so the
// insert-if-not-found path appended a second row (merged 2026-08-12; six pairs).
// Punctuation becomes a SPACE, never nothing: "Co.,Ltd" must key as "co ltd",
// not "coltd". Deliberately conservative — it does NOT try to equate legal-suffix
// spellings ("Co Ltd" vs "Limited"), which would risk merging distinct vendors.
//
// This is a matching key, computed at compare time. It is never stored on a row
// (it is functionally dependent on `name` — a stored copy would be redundant
// derived data). At the Postgres migration this becomes a functional unique
// index over the same expression, backing the `unique` already declared on
// suppliers.name in database.dbml.
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase().replace(/\s+/g, ' '));

const supplierKey = (s) => norm(s).replace(/[.,/&()'"-]+/g, ' ').replace(/\s+/g, ' ').trim();

module.exports = { norm, supplierKey };
