# Control-loss terminal receipts

This section describes terminal control loss. With negotiated
`recovery-judgment-v1`, an eligible extension may first send a nonterminal
recovery judgment request; see [recovery negotiation](PROTOCOL.md#agent-control-recovery-negotiation).
It must not send terminal control loss and then revive that same task.

An extension may attach `interruption` to `agent-turn-end` with status
`interrupted`. The additive field preserves execution evidence when control
is lost before the next observation can be produced:

```json
{
  "reason": "CONTROL_LOST",
  "results": [{ "method": "fill", "outcome": "completed" }],
  "observation": "unavailable",
  "resume": "new-user-message-required"
}
```

The relay validates structure, outcome enums, bounded method identifiers and at
most ten results. Browser method/privacy classification belongs to the extension.
It excludes raw arguments, outputs, messages, URLs and page content.
An invalid field is discarded without preventing task termination. Clients
that omit the field retain the existing terminal behavior.

The pending `/decision` response remains `finished:true,status:interrupted` and
includes the validated interruption. It never includes a new decision request.
The decision CLI already prints that complete response unchanged. A duplicate
request for this terminal exchange reaches extension idempotency validation
before returning the retained receipt; it never reexecutes the action. Changed
decision or inputId returns `DECISION_CONFLICT`. An unrelated ID is still refused.
An expired or ended recovery judgment is an exception: its current request ID
returns `RECOVERY_CLOSED` directly without another extension RPC.
Negotiated recovery terminal evidence may also include
`recoveryOutcome: "expired" | "failed" | "revoked"`. This optional field
distinguishes expiry, failed recovery and revoked control. It never changes the
preserved action outcomes. Unknown values or fields invalidate the optional
evidence without blocking termination; legacy receipts remain valid.

`completed` records an action that returned successfully; `uncertain` does not
mean the action had no effect. `not-executed` must only be used when execution
did not start. None of these outcomes proves the resulting page state. The
Agent must retain completed work, report unavailable observation and await a
new owner message rather than replaying actions or reacquiring control.
