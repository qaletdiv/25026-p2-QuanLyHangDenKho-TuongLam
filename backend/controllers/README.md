# Controllers live with their feature, in `backend/modules/`

This folder is empty on purpose. It is a signpost, because `controllers/` is the
first place most people look.

Until 2026-09-22 the backend had **two** homes for request-handling code and no
rule for which to use:

- `controllers/` — auth, users, roles, contacts, freights, master-data
- `modules/` — PO, mainline, SMS, landed costs, NRI invoices

The split was historical, not a design: the 2026-07-03 rebuild put new work in
`modules/` and nobody moved the older files. Two schemes meant `routes/users.js`
reached into `controllers/` while `routes/reports.js` reached into `modules/`,
for no reason a newcomer could deduce.

There is now one scheme. **Everything is grouped by feature:**

```
modules/<feature>/
    <feature>Routes.js       mounted in server.js
    <feature>Controller.js   HTTP in/out, permissions, guards
    <feature>Service.js      business rules, no req/res
    <feature>Validator.js    Joi schemas
```

The layer is in the **filename suffix**, not the folder — so
`mainlineBookingController.js` is unambiguous wherever you meet it.

See `backend/modules/README.md` for the full map and the reasoning.

## Why not the other way round — flatten `modules/` into here?

Because mainline and SMS are two deliberately separate datasets that must not
share transactional state (separate tables, separate guards, separate
landed-cost bases; measured: **0** imports from SMS into mainline). The folders
mirror that wall, so crossing it is visible in review. Flattened, a
`mainlineBookingController.js` and an `smsBookingController.js` would sit
adjacent in one large folder, which invites exactly the "DRY these up" change
that CLAUDE.md warns against.

This directory can be deleted once that history stops being surprising.
