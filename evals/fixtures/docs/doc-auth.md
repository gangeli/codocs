# Project Alpha Design Doc

## Overview

Project Alpha is a small HTTP service that authenticates users and exposes a paginated listing of known accounts. It is the reference implementation we point new contributors at when they want to see our standard shape for a Node service — a request handler, a tiny data module, and no framework dependencies.

## Authentication

The service accepts `POST /login` with a JSON body of `{username, password}`. The handler looks the user up in the in-memory store and compares the supplied password against the stored value. On a bad password, /login returns HTTP 401. On an unknown username, /login also returns HTTP 401 — we do not distinguish between the two cases to avoid leaking user existence. On success, the handler returns HTTP 200 with a JSON body `{ok: true, userId: <n>}`.

Passwords are stored in plaintext today. We plan to migrate to bcrypt; see Open Questions.

## Data Model

Users live in a single in-memory map keyed by username. Each entry carries a numeric id and a password string. This will move to SQLite once we ship persistence.

## Pagination

`GET /users?limit=N&offset=K` returns the slice of usernames in the half-open range `[offset, offset+limit)`. The default limit is 10 and the default offset is 0. Callers that pass a limit larger than the available users receive however many are available — there is no error.

## Rate Limiting (TBD)

We do not yet rate-limit either endpoint. The plan is to add per-IP and per-user limits backed by an in-process counter, but no code has landed.

## Open Questions

- When do we migrate to bcrypt, and how do we handle the existing plaintext rows?
- Do we want structured audit logging at the handler boundary?
- Is the in-memory user store ever going to be replaced with SQLite, or are we punting indefinitely?
