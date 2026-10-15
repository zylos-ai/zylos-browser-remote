# Extension diagnostics

The owner enables diagnostic collection in the extension panel. Collection is
off by default. The extension keeps a bounded, expiring local ring of structured
events; disabling collection clears that ring. It does not collect page URLs,
content, selectors, typed text, credentials, or arbitrary error messages.

List browser endpoints with the existing status client. Retrieve one browser's
ring using its exact endpoint ID:

```sh
node scripts/diagnostics.js <endpointId> --after 0 --limit 100
```

The CLI calls `POST /diagnostics` on the loopback agent lane. Its JSON body is
`{ "endpoint": "<endpointId>", "after": 0, "limit": 100 }`. `after` must be a
nonnegative safe integer; `limit` is 1 through 200. Both are optional. The relay
sends `diagnostics.get` over that endpoint's authenticated WebSocket connection
only when it advertises `diagnostics-v1`. No browser action or control grant is
required. The extension response is checked and bounded to 64 KiB. The relay
does not store it in files or monitor traces.

Success returns `{ok:true,endpointId,enabled,version,events,nextCursor,dropped}`.
Each event has `seq`, `at`, `event`, and optionally `reason`. `version` is the
extension's actual manifest version. Pass `nextCursor` as `after` on the next
pull. `dropped` reports events removed by the extension's retention policy;
this is not a durable or complete event archive. A new browser session may
reset the cursor, so start with `after:0` after restarting the browser.

Events do not contain task or operation IDs. For one reproduction, have the
owner turn collection off and on before reproducing, then retrieve promptly.
Sequence and time alone cannot establish task identity in a busy history.
Changing the extension's relay URL or connection key disables collection and
clears its local buffer before the new recipient is saved. Previously fetched
copies held by an Agent or other tool are not retracted by local clearing.

Disabled collection succeeds with `enabled:false` and an empty event list.
Old clients return `DIAGNOSTICS_UNSUPPORTED`; disconnected clients return
`EXT_OFFLINE`. `EXT_TIMEOUT` means no answer arrived within five seconds.
Malformed replies return `BAD_DIAGNOSTICS_RESPONSE`. The CLI itself has a
ten-second HTTP bound. None of these errors automatically retries the request.

The agent lane remains bound to `127.0.0.1`. Never route it publicly. The public
extension lane retains its existing authentication and exposes only `/ext`.
