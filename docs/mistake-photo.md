# Mistake photo confirmation

The mistake-photo path treats vision output as a proposal, not learning evidence.

## State machine

`idle → preview → analyzing → review → confirming → confirmed`

- `preview` is browser-only. Retake or cancel revokes the local object URL and sends no image to the server.
- `analyzing` requires an authenticated paired device and its exact active session. A client-generated `draftId` makes retries idempotent.
- `review` contains editable normalized problem text. It is an expiring in-memory draft, not a `mistakes` row.
- `confirmed` is reached only by an explicit button press. Unchanged text records `explicit_acceptance`; edited text records `explicit_correction`.

Refresh recovery stores only `{ sessionId, draftId }` in `sessionStorage`. The server can restore an unexpired in-memory proposal or a durable confirmation receipt. A server restart intentionally discards unconfirmed proposals.

## Media and privacy policy

- Accepted MIME types: JPEG, PNG, and WebP. The decoded image format must match the declared MIME type.
- Maximum upload size: 500 KB.
- Provider timeout: 20 seconds.
- Proposal lifetime: 10 minutes.
- Raw bytes are written only beneath `data/mistakes/.pending/` while the provider request is running. The file is deleted immediately when analysis succeeds, fails, or times out.
- Startup removes orphan files from `.pending/`. Cancel, retake, and expiry remove workflow state and create no learning evidence.
- Provider response bodies, Base64, raw media paths, and model reasoning are not returned to the browser, written to normal logs, or stored in normalized records.

The default policy has no raw-photo retention option. Adding one requires a separate explicit product and privacy decision.

## Confirmed record

The canonical `mistakes` row stores the normalized problem, `source = 'vision'`, `evidence_status = 'confirmed'`, the explicit confirmation method, model name, and timestamps. Legacy image/reasoning columns remain `NULL` for this flow.

`mistake_photo_confirmations` stores a small confirmed-only idempotency receipt (`draft_id`, record/session/device references, method, timestamp). It contains no image, provider response, reasoning, or rejected proposal text.
