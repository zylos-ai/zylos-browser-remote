# Start Browser Work From Another Chat Channel

Use this path for an authorized web task received outside the extension, such
as "search this site for me" or "fill this form using my logged-in browser".
Reuse an incoming extension decision's replyCommands instead when one exists.
Do not start another task to replace an active, stopped or uncertain task.

## Discover And Select

Run from the installed browser-remote skill directory. Use the bundled client
so discovery respects BROWSER_REMOTE_AGENT_URL / BROWSER_REMOTE_AGENT_PORT and
the loopback-only agent-lane boundary:

```bash
node --input-type=module <<'EOF_STATUS'
import client from './scripts/relay-client.js';
const response = await client.status();
console.log(JSON.stringify(response.body, null, 2));
EOF_STATUS
```

Read `extensions`, keyed by composite `endpointId` (`keyId.browserId`). Select a
connected endpoint mapped to the requester and authorized for this task. Browser
labels and online status alone do not establish that mapping. If several mapped
browsers are possible and the task does not select one, ask which browser. Do not
use a bare keyId, another user's browser or the first available connection.
Keep status metadata private to the requesting context.

Require `connected: true` and capability `agent-task-start-v1`. The capability
means implementation support, not that the session permission is enabled;
`/status` does not report that permission. The extension checks it on start.
If `agentTurn` indicates an active exchange, preserve it and its evidence;
do not launch a competing task. An absent agentTurn does not guarantee idle:
the extension can still reject a start with TASK_START_CONFLICT.

If no authorized browser is connected, ask the user to connect their Coco
extension. If the capability is missing, explain the compatibility requirement.
Do not alter services, keys or permissions as a workaround.

## Resolve The URL And Start Once

`task-start.js` requires an explicit HTTP(S) URL and opens a new task tab. It
cannot adopt an arbitrary existing tab, and `/status` is not a list of open
pages. Use a URL supplied by the user or already established in this task's
authorized context. Do not invent a URL or assume that a new tab preserves an
unsaved form or the state of an existing tab.

If the user means "this page" and no URL/page context is available, ask them to
send the request from the extension on that page, or provide its URL if a new
task tab is acceptable. Incoming extension requests can use use-current-tab
with their captured contextId; proactive start cannot fabricate that context.

Generate one fresh lowercase UUID v4 (for example with
`node -e 'console.log(require("node:crypto").randomUUID())'`). Substitute that ID,
the selected exact endpoint, and the actual authorized URL and goal below:

```bash
node scripts/task-start.js '<endpointId>' '<requestId>' <<'EOF_TASK'
{"prompt":"Search this site and report the matching results","url":"https://example.com/"}
EOF_TASK
```

Send only `prompt` (nonblank, at most 8000 characters) and `url` (at most 4096
characters, without credentials or whitespace) in stdin JSON. Preserve the exact
request ID and payload for any explicit retry; never retry automatically.

Handle outcomes without guessing whether work ran:

- TASK_START_DISABLED: ask the user to enable "Allow Agent to start tasks this
  session" in the extension if they want this workflow. Do not enable it yourself.
- TASK_START_UNSUPPORTED, EXT_OFFLINE or UNKNOWN_ENDPOINT: explain the specific
  missing connection/capability; do not silently choose another endpoint.
- TASK_START_CONFLICT or TASK_START_REVOKED: respect the active task or revoked
  permission. Do not mint another request ID or force a replacement task.
- A timeout, transport error or invalid response can have an unknown outcome.
  Report uncertainty; do not resend as if the first request never happened.

## Continue To Verified Completion

`started` or `existing` acknowledges acceptance, not task completion. The
extension creates the task page and sends its first decision request through
C4. Continue that SAME task using the delivered endpoint, current request ID,
replyInputId when supplied, tool schemas and replyCommands. The start request ID
is not a substitute for the subsequent decision request ID. Do not create a
second loop or poll the browser to obtain observations.

Read returned evidence and verify the requested result before claiming success.
Send the terminal reply through the supplied correlated C4 reply command. When
also reporting back to the originating chat, report confirmed outcomes only and
respect that channel's audience; do not copy private browser contents into a
group merely because the request started there.
