# Control-loss terminal receipts

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

The relay validates the entire field against fixed enums and at most ten
results. It excludes raw arguments, outputs, messages, URLs and page content.
An invalid field is discarded without preventing task termination. Clients
that omit the field retain the existing terminal behavior.

The pending `/decision` response remains `finished:true,status:interrupted` and
includes the validated interruption. It never includes a new decision request.
The decision CLI already prints that complete response unchanged. A duplicate
request for this terminal exchange returns the receipt without forwarding a
browser request. An unrelated request ID is still refused.

`completed` records an action that returned successfully; `uncertain` does not
mean the action had no effect. `not-executed` must only be used when execution
did not start. None of these outcomes proves the resulting page state. The
Agent must retain completed work, report unavailable observation and await a
new owner message rather than replaying actions or reacquiring control.
