# docs

Project documentation — design docs, build plans and audits, moved here from
`backend/` and `frontend/` on 2026-09-29.

## Schema

| doc | covers |
|---|---|
| [SCHEMA_REDESIGN.md](SCHEMA_REDESIGN.md) | the 3NF redesign: every violation found and what replaced it. Authoritative, together with `backend/database.dbml` |
| [QUERIES.md](QUERIES.md) | how to connect, plus worked example queries. ⚠️ Most of what the UI shows is DERIVED per read and is not a column — read this before writing SQL |

## Mainline (ocean/air freight via forwarder)

| doc | covers |
|---|---|
| [MAINLINE_MODULE_STRUCTURE.md](MAINLINE_MODULE_STRUCTURE.md) | module layout and the reasoning behind it |
| [MAINLINE_BUILD_PLAN.md](MAINLINE_BUILD_PLAN.md) | the build, phase by phase (checklist form) |

## SMS (small courier shipments)

| doc | covers |
|---|---|
| [SMS_MODULE_PLAN.md](SMS_MODULE_PLAN.md) | the SMS schema and its seven phases |
| [SMS_BOOKING_BUILD_PLAN.md](SMS_BOOKING_BUILD_PLAN.md) | the optional booking step added 2026-08-07 |
| [SMS_MAINLINE_BACKEND_AUDIT.md](SMS_MAINLINE_BACKEND_AUDIT.md) | audit of what the two modules shared before separation |
| [SMS_MAINLINE_FRONTEND_AUDIT.md](SMS_MAINLINE_FRONTEND_AUDIT.md) | the same, frontend side |

## Other

| doc | covers |
|---|---|
| [NRI_INVOICE_MODULE.md](NRI_INVOICE_MODULE.md) | 3PL invoice verification (`/nri-invoices` API, `/invoices` UI). The source of truth for that module |
| [SKU_EXPANSION_PLAN.md](SKU_EXPANSION_PLAN.md) | planned SKU-level expansion (frontend) |
| [CI_FIXTURES.md](CI_FIXTURES.md) | commercial-invoice test fixtures |

## What is deliberately NOT here

These stay where they are because their **location** is what makes them work:

| file | why it stays |
|---|---|
| `CLAUDE.md` (root) | auto-loaded agent context. Moving it stops it being read |
| `frontend/tentree-scportal/CLAUDE.md` | directory-scoped agent context |
| `frontend/tentree-scportal/AGENTS.md` | same convention, other tools |
| `backend/README.md` | the backend layout guide; GitHub renders it when you browse into `backend/` |
| `backend/database/README.md` | the data layer, next to the code it describes |
| `backend/storage/README.md` | files on disk, next to them |
| `.claude/skills/**/*.md` | skill definitions, loaded from that exact path |

⚠️ **Dates and history in these files are as-written.** Several carry a banner
noting their backend paths predate the 2026-09-28 move to layer-first MVC; the
file names in them are still right, only the folders changed. See
`backend/README.md`.
