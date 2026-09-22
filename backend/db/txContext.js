// ---------------------------------------------------------------------------
// One transaction per write request.
//
// This is the JSON stack's "No transactions" limitation being paid off, which
// CLAUDE.md lists under "Postgres migration notes (fix AT migration, not
// before)": booking-approve writes shipments then shipment legs, the shipping-data
// upload writes five tables, an SMS shipment writes a header then a junction —
// and a crash between two of those writes left the portal in a state no rule
// allows. Wrapping the request means those either all land or none do.
//
// It is also what makes foreign keys possible at all. Every write here is a
// whole-table replace (BaseModel.write hands over the entire array), so deleting
// a booking necessarily leaves its junction rows dangling until the NEXT
// writeData call fixes them up. Constraints are DEFERRABLE INITIALLY DEFERRED and
// checked at COMMIT, so the momentary inconsistency inside a request is fine and
// a request that ends inconsistent is refused.
//
// READS DELIBERATELY DO NOT GET A TRANSACTION. They need no atomicity, and
// holding a pooled connection across a streamed file download would tie up the
// pool for the length of the transfer.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('node:async_hooks');
const { pool } = require('./pool');

const storage = new AsyncLocalStorage();

/** The ambient transaction's client, or null when not inside one. */
function currentClient() {
    const ctx = storage.getStore();
    return ctx && !ctx.settled ? ctx.client : null;
}

async function begin(client) {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
}

/**
 * Run `fn` inside a transaction. Joins the ambient one if there is already a
 * transaction open, so a service that wants atomicity does not start a nested
 * one it cannot commit.
 */
async function withTransaction(fn) {
    const existing = currentClient();
    if (existing) return fn(existing);

    const client = await pool.connect();
    const ctx = { client, settled: false };
    try {
        await begin(client);
        const result = await storage.run(ctx, () => fn(client));
        ctx.settled = true;
        await client.query('COMMIT');
        return result;
    } catch (err) {
        ctx.settled = true;
        try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
        throw err;
    } finally {
        client.release();
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

    pool.connect().then(async (client) => {
        const ctx = { client, settled: false };
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            client.release();
        };

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
                await client.query(commit ? 'COMMIT' : 'ROLLBACK');
                return null;
            } catch (err) {
                if (commit) {
                    try { await client.query('ROLLBACK'); } catch (_) { /* gone */ }
                }
                return err;
            } finally {
                release();
            }
        };

        req.on('aborted', () => {
            if (ctx.settled) return;
            ctx.settled = true;
            client.query('ROLLBACK').catch(() => {}).then(release);
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

        try {
            await begin(client);
        } catch (err) {
            release();
            return next(err);
        }
        storage.run(ctx, next);
    }).catch(next);
}

module.exports = { currentClient, withTransaction, transactionMiddleware, storage };
