'use strict';

// Lets an SMS SHIPMENT be Cancelled, by widening the status SMS already has.
//
// The first attempt here added a second `Cancelled` row for module='sms' and the
// database refused it: `statuses_module_name_uniq` on (module, name). That
// constraint is right, and it points at the shape mainline already uses — ONE
// `cancelled` row, category 'both', serving bookings and shipments alike. SMS had
// split its Cancelled into a booking-only row, so this promotes it:
//
//     sms_bk_cancelled · category 'booking'  →  sms_cancelled · category 'both'
//
// Why a shipment needs it at all: the courier scale ends at Delivered and a parcel
// already handed to FedEx cannot be called off — but a booking-approved DRAFT has
// no tracking number yet, so it is still a plan, and a plan can be cancelled. The
// guard in smsShipmentController.cancel refuses it on anything handed over, so the
// status can only ever reach a draft.
//
// The id is renamed as well because "bk" would be a lie on a shipment row, and it
// is free to do: NOTHING references the old id (0 of 5 bookings, 0 of 42
// shipments). The script REFUSES if that is no longer true, rather than orphaning
// a foreign key.
//
// Idempotent. `--dry-run` prints and writes nothing.

require('dotenv').config();
const { models } = require('../models');
const { atomically } = require('../database/tx');

const DRY = process.argv.includes('--dry-run');
const OLD_ID = 'sms_bk_cancelled';
const NEW_ID = 'sms_cancelled';

(async () => {
  const Statuses = models.statuses;
  const Bookings = models.sms_bookings;
  const Shipments = models.sms_shipments;

  const [rows, bookings, shipments] = await Promise.all([
    Statuses.read(), Bookings.read(), Shipments.read(),
  ]);

  const done = rows.find((r) => r.id === NEW_ID);
  if (done && done.category === 'both') {
    console.log(`already promoted: ${JSON.stringify(done)}`);
    console.log('nothing to do.');
    return;
  }

  const old = rows.find((r) => r.id === OLD_ID);
  if (!old) {
    console.error(`REFUSING: neither ${OLD_ID} nor a promoted ${NEW_ID} is present — nothing to promote.`);
    process.exitCode = 1;
    return;
  }

  const refs = [
    ...bookings.filter((b) => b.bookingStatusId === OLD_ID).map((b) => `booking ${b.bookingNumber || b.id}`),
    ...shipments.filter((s) => s.manualStatusId === OLD_ID).map((s) => `shipment ${s.id}`),
  ];
  if (refs.length) {
    console.error(`REFUSING: ${refs.length} row(s) still point at ${OLD_ID} — renaming would orphan them:`);
    refs.forEach((r) => console.error(`  ${r}`));
    console.error('Re-point those rows first, or change this script to rewrite them too.');
    process.exitCode = 1;
    return;
  }

  const next = rows.map((r) => (r.id === OLD_ID ? { ...r, id: NEW_ID, category: 'both' } : r));
  console.log(`${OLD_ID} (category ${old.category})  ->  ${NEW_ID} (category both)`);
  console.log(`statuses: ${rows.length} row(s), unchanged in count; 0 rows referenced the old id`);
  if (DRY) { console.log('\n--dry-run: nothing written.'); return; }

  await atomically(() => Statuses.write(next));
  console.log('written.');
})().then(() => process.exit(process.exitCode || 0))
  .catch((e) => { console.error(e); process.exit(1); });
