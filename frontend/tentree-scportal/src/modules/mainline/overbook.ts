// G2 overbooking warning (409 from POST/PUT /mainline/bookings) — one shared
// wording for the create form and the edit form.
export type OverbookWarning = {
  legId: string;
  poNumber?: string | null;
  capacity: number;
  already_booked: number;
  requested: number;
  overage: number;
  booked_in?: string[];   // booking numbers already holding units on the leg
};

const n = (v: number) => Number(v || 0).toLocaleString();

// Names the already-booked units and where they sit, so "1000+1025 > 1000"
// can't be misread as the form double-counting the entry.
export function formatOverbook(w: OverbookWarning): string {
  const po = w.poNumber ?? w.legId;
  if (!w.already_booked) {
    return `${po}: ${n(w.requested)} requested exceeds capacity ${n(w.capacity)} (over by ${n(w.overage)}).`;
  }
  const where = w.booked_in?.length ? ` on ${w.booked_in.join(', ')}` : '';
  return `${po}: ${n(w.already_booked)} of ${n(w.capacity)} already booked${where}, `
    + `so ${n(w.requested)} more would make ${n(w.already_booked + w.requested)} (over by ${n(w.overage)}).`;
}
