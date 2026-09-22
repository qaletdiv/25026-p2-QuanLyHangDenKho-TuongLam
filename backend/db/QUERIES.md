# Querying the portal database

Every query below was run against the live `tentree_portal` database and returned
the output shown in its comment. Schema reference: `../database.dbml`.

## Connecting

```bash
# psql inside the container (nothing to install)
wsl -e docker exec -it some-postgres psql -U postgres -d tentree_portal

# one-off query
wsl -e docker exec some-postgres psql -U postgres -d tentree_portal -c "SELECT count(*) FROM po_orders;"

# run a .sql file
wsl -e docker exec -i some-postgres psql -U postgres -d tentree_portal < myquery.sql
```

From a **GUI client** (DBeaver, pgAdmin, DataGrip, TablePlus) or any tool on
Windows:

| | |
|---|---|
| host | `localhost` |
| port | `5432` |
| database | `tentree_portal` |
| user | `postgres` |
| password | in `backend/.env` as `DATABASE_URL` |

If a client cannot connect while the container is `running`, it is the WSL port
relay, not the database — see the "Running it on this machine" section of
`README.md`.

## Two things to know before you trust a number

**Most of what the portal shows is DERIVED at read time, not stored.** PO
lifecycle state, the three-way match, shipment status, landed-cost splits, the
forecast, `Received`, ATA — none of these are columns. Querying the tables gives
you the *inputs*; the app computes the answers in JS per request (this is the
3NF "never store derived" rule in CLAUDE.md). For the derived figures, hit the
API instead of reinventing the logic in SQL, or you will quietly disagree with
the UI.

**Every table has a `_seq` column that is not part of the data.** It preserves
the row order the JSON files had, because SQL has no inherent row order and
several code paths depend on it. `SELECT *` will show it; ignore it, and never
write to it by hand.

## Orientation

```sql
-- what is here, biggest first
SELECT relname AS table_name, n_live_tup AS rows
  FROM pg_stat_user_tables WHERE n_live_tup > 0 ORDER BY n_live_tup DESC;

-- columns of one table
\d+ mainline_shipments

-- where a table is referenced from
SELECT conrelid::regclass AS child, conname
  FROM pg_constraint WHERE contype='f' AND confrelid='mainline_shipments'::regclass;
```

## 1. PO hierarchy — TRN → PO → legs

```sql
SELECT m.trn_number, s.name AS supplier, se.code AS season,
       count(DISTINCT o.po_number) AS pos,
       count(DISTINCT l.id)        AS legs
  FROM po_masters m
  LEFT JOIN suppliers s  ON s.id  = m.supplier_id
  LEFT JOIN seasons   se ON se.id = m.season_id
  LEFT JOIN po_orders o  ON o.trn_number = m.trn_number
  LEFT JOIN mainline_po_legs l ON l.po_number = o.po_number
 GROUP BY m.trn_number, s.name, se.code
 ORDER BY legs DESC;
-- TRN_1256  Shanghai Pucci  FW26  4 pos  10 legs
```

A PO with **0 legs** is `forecast` (not yet split by the WIP import) and is
therefore unbookable — that is the whole of the lifecycle rule, in one number.

## 2. Ordered vs allocated vs received, per PO

The three grains that feed the three-way match.

```sql
WITH ordered AS (
  SELECT po_number, sum(ordered_qty) AS qty FROM po_order_lines GROUP BY po_number),
allocated AS (
  SELECT l.po_number, sum(ll.allocated_qty) AS qty
    FROM mainline_po_legs l JOIN mainline_po_leg_lines ll ON ll.leg_id = l.id
   GROUP BY l.po_number),
received AS (
  SELECT r.po_number, sum(rl.qty) AS qty
    FROM mainline_item_receipts r
    JOIN mainline_item_receipt_lines rl ON rl.receipt_id = r.id
   GROUP BY r.po_number)
SELECT o.po_number, o.qty AS ordered, a.qty AS allocated, r.qty AS received,
       o.qty - COALESCE(r.qty,0) AS outstanding
  FROM ordered o
  LEFT JOIN allocated a ON a.po_number = o.po_number
  LEFT JOIN received  r ON r.po_number = o.po_number
 WHERE a.qty IS NOT NULL
 ORDER BY outstanding DESC;
-- PO04788  5109 ordered  5109 allocated  4738 received  371 outstanding
```

⚠️ Sum the leg lines — **do not** join legs and lines without aggregating, or a
PO with Air + Sea legs double-counts. `mainline_po_leg_lines` also has 22 rows
that duplicate `(leg_id, sku_code)` (see CLAUDE.md), so `sum()` is required for a
correct answer, not just for tidiness.

## 3. Booking → shipment → legs

Shipment grain is `(booking, facility, mode)`, so one booking can have several
shipments and each carries several PO legs.

```sql
SELECT b.booking_number, sp.name AS supplier, st.name AS status,
       sh.shipment_number, f.name AS facility, mo.name AS mode,
       sh.etd_pol, sh.e_del, sh.ata,
       count(sl.id) AS legs, sum(sl.expected_quantity) AS units
  FROM mainline_bookings b
  LEFT JOIN suppliers sp ON sp.id = b.supplier_id
  LEFT JOIN mainline_shipments sh ON sh.booking_id = b.id
  LEFT JOIN statuses st ON st.id = sh.status_id
  LEFT JOIN warehouse_facilities f ON f.id = sh.facility_id
  LEFT JOIN modes mo ON mo.id = sh.mode_id
  LEFT JOIN mainline_shipment_legs sl ON sl.shipment_id = sh.id
 GROUP BY b.booking_number, sp.name, st.name, sh.shipment_number,
          f.name, mo.name, sh.etd_pol, sh.e_del, sh.ata;
-- BKG-6  Eastern Warmth  Delivered  SHP-6  NRI CA  Sea  2 legs  20344 units
```

⚠️ `ata` here is the RAW column. The portal's actual ATA is derived from the
NetSuite Item Receipts and only falls back to this column — 8 of 9 shipments read
blank here while the UI shows a date. Use `/mainline/shipments` for the real one.

## 4. SMS consignments + latest courier scan

```sql
SELECT s.tracking_number, c.name AS courier, s.ship_date,
       string_agg(DISTINCT sp.po_number, ', ') AS pos,
       sum(sp.units) AS units,
       (SELECT e.description FROM sms_tracking_events e
         WHERE e.shipment_id = s.id ORDER BY e.event_time DESC LIMIT 1) AS latest_scan
  FROM sms_shipments s
  LEFT JOIN couriers c ON c.id = s.courier_id
  LEFT JOIN sms_shipment_pos sp ON sp.shipment_id = s.id
 WHERE s.tracking_number IS NOT NULL
 GROUP BY s.id, s.tracking_number, c.name, s.ship_date
 ORDER BY s.ship_date DESC NULLS LAST;
-- 876555655960  FedEx  2026-09-01  PO04823  125 units  Delivered
```

A NULL `tracking_number` is a booking-approved DRAFT that has not shipped yet —
excluded above on purpose. The displayed status is derived (latest event via
`courier_status_map`, else `manual_status_id`, then Delivered → Received); this
shows the raw latest scan only.

## 5. Posted landed costs, and which basis each used

There is no `basis` column — a NULL rate snapshot *is* the record of "actual".

```sql
SELECT module, shipment_id, po_number,
       round(invoice_value::numeric,2) AS ci_value,
       round(freight::numeric,2) AS freight,
       round(duty::numeric,2)    AS duty,
       CASE WHEN freight_pct IS NULL THEN 'actual bill'
            ELSE 'estimate '||freight_pct||'/'||duty_pct||'%' END AS basis,
       posted_at::date AS posted
  FROM landed_costs ORDER BY posted_at DESC;
-- sms  46  14665.02  actual bill     2026-09-10
-- sms  34   5734.88  estimate 40/25% 2026-09-01
```

`po_number` is populated on mainline rows (posted per PO) and NULL on SMS rows
(posted per shipment) — that is the real grain, not the dbml's declared one.

## 6. Integrity spot-checks

All of these should return 0. The foreign keys enforce most of it now, so a
non-zero row here means something bypassed the app.

```sql
SELECT 'orphan booking legs' AS check, count(*) FROM mainline_booking_po_legs j
   LEFT JOIN mainline_bookings b ON b.id=j.booking_id WHERE b.id IS NULL
UNION ALL SELECT 'orphan shipment legs', count(*) FROM mainline_shipment_legs j
   LEFT JOIN mainline_shipments s ON s.id=j.shipment_id WHERE s.id IS NULL
UNION ALL SELECT 'orphan receipt lines', count(*) FROM mainline_item_receipt_lines l
   LEFT JOIN mainline_item_receipts r ON r.id=l.receipt_id WHERE r.id IS NULL
UNION ALL SELECT 'orphan sms junction', count(*) FROM sms_shipment_pos j
   LEFT JOIN sms_shipments s ON s.id=j.shipment_id WHERE s.id IS NULL
UNION ALL SELECT 'cross-module statuses', count(*) FROM mainline_shipments s
   JOIN statuses st ON st.id=s.status_id WHERE st.module='sms';
```

## ⚠️ Writing by hand

Read freely. For writes, prefer the API — the app enforces the guards (G1–G4,
overbooking, chronology, vendor scoping) and the cascades that the schema alone
does not. If you must write SQL directly:

- Wrap it in a transaction; foreign keys are `DEFERRABLE INITIALLY DEFERRED` and
  are only checked at `COMMIT`.
- Set `_seq` on any row you INSERT (it is `NOT NULL`), or the insert fails.
- Never add `ON DELETE CASCADE` to a foreign key. The app replaces whole tables
  (`DELETE` all + `INSERT` all) on every save, so a cascade would fire on that
  routine delete and take every child row with it.

## Backup / restore

```bash
wsl -e docker exec some-postgres pg_dump -U postgres -Fc tentree_portal > portal.dump
wsl -e docker exec -i some-postgres pg_restore -U postgres -d tentree_portal --clean < portal.dump
```

`db/migrate.js --force` is NOT a restore — it reloads the frozen migration-day
JSON snapshot and discards everything since.
