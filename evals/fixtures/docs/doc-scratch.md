# Meeting Notes 2026-04-15

## Attendees

- alice
- bob
- carol

## Discussion

- Talked about the upcomming release cadence. Need to decide: monthly or bi-weekly.
- Carol raised concern that our authentification flow doesn't rate-limit.
- Bob suggested we just add a Redis counter and move on.

## Action Items

- [ ] alice: draft the rate-limiting RFC
- [ ] bob: audit the existing `/login` handler for missing cases
- [ ] carol: file tickets for the typos in the last design doc

## Notes

- We should proably rename the project internally — "Alpha" is getting confusing now that we have Alpha-staging and Alpha-prod.
- The CLI's `greet` subcommand is cute but nobody uses it.
