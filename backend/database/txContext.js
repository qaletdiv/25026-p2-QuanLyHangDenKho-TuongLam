// ---------------------------------------------------------------------------
// One transaction per write request — now on Sequelize.
//
// This is the JSON stack's "No transactions" limitation being paid off: booking
// -approve writes shipments then shipment legs, the shipping-data upload writes
// five tables, an SMS shipment writes a header then a junction — and a crash
// between two of those writes left the portal in a state no rule allows.
// Wrapping the request means those either all land or none do.
//
// It is also what makes foreign keys possible at all. Every write here is a
// whole-table replace (BaseModel.write hands over the entire array), so deleting
// a booking necessarily leaves its junction rows dangling until the NEXT
// writeData call fixes them up. Constraints are DEFERRABLE INITIALLY DEFERRED
// and checked at COMMIT, so the momentary inconsistency inside a request is fine
// and a request that ends inconsistent is refused.
//
// ⚠️ WHY THIS HAD TO MOVE ONTO SEQUELIZE AT THE SAME TIME AS THE MODELS.
// It used to hold a raw pg client checked out of db/pool.js. Sequelize owns its
// OWN connection pool, so a model query would have run on a DIFFERENT connection
// than that client — outside the transaction, self-committing, with the ambient
// BEGIN having no effect on it. Nothing would have thrown; the atomicity would
// simply have been gone. So the ambient object here is now a Sequelize
// Transaction, and database/modelStore.js passes it to every query it makes.
//
// READS DELIBERATELY DO NOT GET A TRANSACTION. They need no atomicity, and
// holding a pooled connection across a streamed file download would tie up the
// pool for the length of the transfer.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('node:async_hooks');
const { sequelize } = require('./sequelize');

const storage = new AsyncLocalStorage();

/** The ambient Sequelize transaction, or null when not inside one. */
function currentTransaction() {
    const ctx = storage.getStore();
    return ctx && !ctx.settled ? ctx.transaction : null;
}

/**
 * Query options carrying the ambient transaction, for database/modelStore.js.
 * Returns {} outside a transaction, which is what a read wants.
 */
function txOptions() {
    const transaction = currentTransaction();
    return transaction ? { transaction } : {};
}

async function begin() {
    const transaction = await sequelize.transaction();
    await sequelize.query('SET CONSTRAINTS ALL DEFERRED', { transaction });
    return transaction;
}

/**
 * Run `fn` inside a transaction. Joins the ambient one if there is already a
 * transaction open, so a service that wants atomicity does not start a nested
 * one it cannot commit.
 */
async function withTransaction(fn) {
    const existing = currentTransaction();
    if (existing) return fn(existing);

    const transaction = await begin();
    const ctx = { transaction, settled: false };
    try {
        const result = await storage.run(ctx, () => fn(transaction));
        ctx.settled = true;
        await transaction.commit();
        return result;
    } catch (err) {
        ctx.settled = true;
        try { await transaction.rollback(); } catch (_) { /* connection already gone */ }
        throw err;
    }
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Express middleware. Opens a transaction for write requests and settles it
 * BEFORE the response body goes out, so a failed COMMIT can still turn into a
 * 500 rather than a success the client has already been told about.
 */
function transactionMiddleware(req, res, next) {
    if (READ_ONLY_METHODS.has(req.method)) return next();

    begin().then((transaction) => {
        const ctx = { transaction, settled: false };

        // Settle once, whichever happens first: the response ending, or the
        // client hanging up mid-request.
        const settle = async () => {
            if (ctx.settled) return null;
            ctx.settled = true;
            // A 4xx/5xx means a guard refused the request or a handler threw.
            // Some controllers write before validating something else, so the
            // only safe reading of an error status is "undo it".
            const commit = res.statusCode < 400;
            try {
                await (commit ? transaction.commit() : transaction.rollback());
                return null;
            } catch (err) {
                if (commit) {
                    try { await transaction.rollback(); } catch (_) { /* gone */ }
                }
                return err;
            }
        };

        req.on('aborted', () => {
            if (ctx.settled) return;
            ctx.settled = true;
            transaction.rollback().catch(() => {});
        });

        const originalEnd = res.end.bind(res);
        res.end = function patchedEnd(...args) {
            if (ctx.settled) return originalEnd(...args);
            settle().then((err) => {
                if (!err) return originalEnd(...args);
                console.error('[db] COMMIT failed, rolled back:', err.message);
                if (res.headersSent) return originalEnd(...args);
                // Discard the handler's body — it describes a write that did not
                // survive — and answer with the failure instead.
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                return originalEnd(JSON.stringify({
                    message: 'The change could not be saved and was rolled back.',
                }));
            }).catch((err) => {
                console.error('[db] transaction settle failed:', err.message);
                originalEnd(...args);
            });
            return res;
        };

        storage.run(ctx, next);
    }).catch(next);
}

module.exports = {
    currentTransaction,
    txOptions,
    withTransaction,
    transactionMiddleware,
    storage,
};
