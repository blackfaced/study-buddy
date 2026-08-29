# Defer merging the single-photo and page-photo capture paths

The two photo capture paths (single-photo in-memory drafts in `mistake-photo-workflow.ts`, page-photo DB-backed drafts/candidates in `mistake-page-photo-workflow.ts` + `candidate-workflow.ts`) stay separate until the page-photo path gets a real client (T04-D). Both already converge on the same write path (`insertMistake`, post-#166); what remains duplicated is only draft persistence and TTL handling.

## Considered Options

Merging now (single-photo remodelled as a one-region page draft) was rejected: the page-photo path has zero clients and no real-use validation; merging would force changes onto the production buddy photo flow — image BLOB persistence (single-photo currently deletes the image after analysis), non-empty answers at confirm (buddy submits only `problemText`), and a dedupe partition change (`vision` → `vision_page`). Restart loss of in-memory drafts is bounded by the 10-minute TTL, so the pain does not justify the coupling.

## Consequences

Future architecture reviews should not re-suggest this merge until T04-D ships and the page-photo path has real usage. If the single-photo draft store ever needs restart durability beyond the 10-minute TTL, evaluate a DB-backed store for it alone rather than merging schemas.
