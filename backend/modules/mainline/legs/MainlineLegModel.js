'use strict';

// mainline_po_legs (+ leg lines) — WIP-owned (Phase 2b). Read + write.
const BaseModel = require('../../../models/BaseModel');

const legs     = new BaseModel('migrated/mainline_po_legs.json');
const legLines = new BaseModel('migrated/mainline_po_leg_lines.json');

module.exports = {
  readLegs:      () => legs.read(),
  writeLegs:     (d) => legs.write(d),
  readLegLines:  () => legLines.read(),
  writeLegLines: (d) => legLines.write(d),
};
