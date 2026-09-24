// ---------------------------------------------------------------------------
// The model registry.
//
// Loads every model in this directory onto the one Sequelize instance, wires
// the associations, and exposes the two lookups the rest of the backend needs:
//
//   models[tableName]      the Sequelize model (also keyed PascalCase)
//
// Each model carries .read() / .write(rows) for whole-table access — see
// database/modelStore.js. The filename->table registry that used to live here
// is gone: seed files are named after their table, so no mapping is needed.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const { DataTypes } = require('sequelize');
const { sequelize, Sequelize } = require('../database/sequelize');

// Keyed TWICE on purpose: by table name (`models.mainline_shipments`), which
// is what the file registry and the BaseModel facade resolve to, and by the
// PascalCase model name (`models.MainlineShipments`), which is what a model's
// own associate() names. One registry, two spellings of the same object.
const models = {};

/** `mainline_po_legs` -> `MainlinePoLegs`. */
function pascal(name) {
    return name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join('');
}

// ⚠️ `*Model.js` is SKIPPED. This directory also holds the legacy table
// facades (BaseModel.js, UserModel.js, MasterDataModel.js …), which export a
// class or a BaseModel instance rather than a (sequelize, DataTypes) factory.
// BaseModel is itself a class — and a class IS typeof "function" — so a
// duck-typed check would call it without `new` and throw. The name rule is
// the reliable one.
for (const file of fs.readdirSync(__dirname)) {
    if (file === 'index.js' || !file.endsWith('.js')) continue;
    if (file.endsWith('Model.js')) continue;
    const define = require(path.join(__dirname, file));
    const model = define(sequelize, DataTypes);
    models[model.name] = model;
    models[pascal(model.name)] = model;
}

// Second pass: every model exists now, so a belongsTo can name its target.
// Deduplicated because the registry holds each model under two keys, and
// associating twice would define every relation twice.
for (const model of new Set(Object.values(models))) {
    if (typeof model.associate === 'function') model.associate(models);

    // Whole-table read/write, the shape ~190 call sites use:
    //   const rows = await models.po_orders.read();
    //   await models.po_orders.write(next);
    // This is what replaced models/BaseModel.js. Semantics are unchanged —
    // write() REPLACES the table, so a row missing from the array is deleted.
    //
    // ⚠️ database/modelStore is required lazily INSIDE the functions. It requires
    // this file, so requiring it at the top would be a cycle and one of the
    // two would see a half-built module. Sequelize's Model has no `read` or
    // `write` static, so neither name shadows anything.
    model.read = function read() {
        return require('../database/modelStore').readAll(this);
    };
    model.write = function write(rows) {
        return require('../database/modelStore').replaceAll(this, rows);
    };
}

module.exports = { sequelize, Sequelize, models };
