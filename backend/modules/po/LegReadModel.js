'use strict';

// mainline_po_legs (+ leg lines) — READ-ONLY here. The mainline module formally
// owns these (Phase 2: MainlineLegModel handles writes/upsert). Phase 1 needs them
// only to derive PO lifecycle state (forecast vs split), so it reads them directly.
const BaseModel = require('../../models/BaseModel');

const legs     = new BaseModel('migrated/mainline_po_legs.json');
const legLines = new BaseModel('migrated/mainline_po_leg_lines.json');

module.exports = {
  readLegs:     () => legs.read(),
  readLegLines: () => legLines.read(),
};
