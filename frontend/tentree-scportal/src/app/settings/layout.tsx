import React from 'react';

// The width of every Settings page, in ONE place.
//
// It used to be a `max-w-*` class repeated in each of the ten page files, which is
// how they drifted: Suppliers was sized at max-w-4xl when it had four columns and
// stayed there after growing to seven (two of them address textareas), so it
// scrolled sideways while Warehouses next door had room to spare.
//
// `w-[80%]` rather than a fixed cap so the content-heavy tables use the screen —
// but with a ceiling, because percentage tracks the WINDOW while readability
// tracks the CONTENT: at 80% of a 2560px monitor, the two-column tables
// (Couriers, Incoterms, Modes) would render a ~1900px-wide text input. Full width
// below `md`, where 80% would be cramped rather than generous.
//
// Per-page overrides do not belong here — if one table genuinely needs a different
// width, give the CARD a width, not the page.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-8 pb-20 w-full md:w-[80%] max-w-[1400px] mx-auto">
      {children}
    </div>
  );
}
