# Phase 7 — read-only Gmail reply detection (R11 decision record)

Audit item: A-05 / R11 — "decide the reply-tracking design before promising it: separate read-only consent, retention policy, untrusted-content handling".

Status: implemented as a manual, read-only local command (`npm run ops:sync-replies`). No live Gmail read has been executed against the owner mailbox; the evidence below is unit and local-MongoDB verification.

## Consent

- The OAuth request now asks for `gmail.send` **and** `gmail.readonly` in one consent screen, and `beginGmailAuthorization` refuses a grant that omits either scope.
- The read scope is a Google restricted scope. The owner enabled it in the Google Cloud Console and must re-run `npm run ops:gmail-connect` once so the stored token carries it; the token file is local, owner-only (Windows ACL / `0600`) and git-ignored.
- A stored send-only token keeps working for delivery. Reply sync refuses it with `gmail-read-scope-missing` and the message to re-run `npm run ops:gmail-connect`.
- No `gmail.modify`, `gmail.labels`, or delete scope is requested. The sync issues GET requests only, so it cannot mark read, label, trash, or delete anything.

## What is read

- `GET /users/me/profile` — the authenticated mailbox address, used only to recognise the owner's own messages.
- `GET /messages/{id}?format=minimal&fields=threadId` — the thread id of a message the agent already sent.
- `GET /threads/{id}?format=metadata&metadataHeaders=From` — message ids, label ids, `internalDate`, and the `From` header.
- Message bodies and subjects are never requested, so no email text is parsed, stored, sent to a model, or shown in a terminal. Only provider ids, the sender comparison outcome, and the detection timestamp are persisted (`replyStatus`, `replyRecordedAt`, `replyMessageId`).

## Matching rule

A message counts as a reply when it belongs to the thread of a sent attempt and it is not the sent message itself, does not carry the `SENT` label, is not authored by the authenticated owner address, and — when both timestamps are known — was received after the attempt's `sentAt`. The database write is guarded so an existing `replied` or a manual `declined` decision is never overwritten.

## Retention

The learning value is one id per attempt; the reply body and subject are not retained at all. Nothing is copied outside MongoDB and the local Gmail thread. Deleting an `outreach_attempts` row or the candidate removes the stored reference.

## Untrusted content and prompt injection

Email is untrusted input. Because no body, subject, or HTML is read, there is no text that could carry instructions into a model or a workflow. The only header consulted is `From`, which is used for an equality comparison against the authenticated address and is never interpreted as an instruction. Address parsing cannot silently accept a malformed sender: a message without a usable `From` address is ignored rather than assumed to be a reply.

## Failure, limits, and honesty

- Reads run sequentially with a 15 s timeout per request, at most 200 threads per run (`deferredAttempts` reports the remainder), and stop immediately on `401`/`403` instead of retrying every thread.
- Failures are reported as stable codes (`gmail-read-auth-unavailable`, `gmail-read-scope-missing`, `gmail-read-request-failed`, `gmail-read-invalid-response`, `thread-unavailable`, `reply-record-failed`) with no provider payload, sender address, or subject.
- Detection is header-level: an autoresponder, a mailing-list copy, or a colleague replying in the same thread will also be recorded as `replied`. The owner still reads the mail; the field means "a non-owner message exists in this thread", not "the professor accepted".
- Not implemented: body or intent analysis, automatic follow-up scheduling, changing `ProfessorCandidate.status` to `replied`, and reply notification. Sending, the five-per-day cap, pause control, and approval gates are unchanged.

## Verification

- `npm test` covers the matching rule, owner/`SENT` filtering, pre-send messages, missing `From`, `declined` preservation, missing scope, `401` stop, `429`/vanished-thread partial runs, per-run deferral, sanitized codes, and that every request is a GET with `format=minimal`/`format=metadata` and no subject or body.
- `npm run test:mongodb` asserts `recordReply` writes `replied`, `replyRecordedAt`, and `replyMessageId`, is idempotent, and rejects an invalid timestamp (run against a local `gradreach_test`).
- No live Gmail read, no live database write from a real mailbox, and no deployed worker were exercised. Treat the feature as verified logic, not as a proven live integration.
