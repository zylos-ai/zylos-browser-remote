# Start Browser Work From Another Chat Channel

Use this path for an authorized web task received outside the extension, such
as "search this site for me" or "fill this form using my logged-in browser".
Reuse an incoming extension decision's replyCommands instead when one exists.
Do not start another task to replace an active, stopped or uncertain task.

## Consider A Blocked Webpage Step

Use discovery when a webpage step in an existing task cannot be completed with
the current browser or tools, even when the user did not explicitly request the
extension. Typical triggers are unavailable browser automation, incompatible
page interaction, missing login or account role, or a proposed manual step.
Before recommending borrowed credentials, elevated roles, manual work or giving
up, check whether an authorized connected browser offers a workable path.

Examples:

- A test-environment template review needs an administrator session. Before
  proposing promotion of a test account or asking the administrator to click
  through it, discover connected browsers and check the existing trusted mapping
  and task scope. If the administrator has authorized that browser for this
  review, use its existing session through the workflow below. Do not infer the
  signed-in account or its role from a label or online status; verify only the
  relevant page state after authorization. A final approval still needs whatever
  confirmation the task's side effects require.
- A local browser cannot operate a page. Consider the connected browser as an
  alternative execution path before asking the user to perform the step. First
  reconcile any partial or uncertain effects in the original attempt; do not
  blindly replay a submit or launch a competing task. If the failure was a site denial,
  browser-owner Stop or revocation, do not change browser or tool to evade it.

Prefer the browser path when identity, task authority, compatibility and the
target are established. Reuse existing explicit authorization; ask only for
missing information or required consent. The browser owner must enable session
permission themselves. If no authorized connection is usable, explain that
specific limitation and offer other permitted options. Discovery is not a login,
account-role check or permission grant, and does not itself start browser work.

Distinguish the Zylos owner (who establishes trusted requester/endpoint mappings)
from the browser owner (the person controlling permission and Stop in that
browser). They can be the same person, but a requester or Zylos owner cannot
override a different browser owner's refusal.

## Discover And Select

Run from the installed browser-remote skill directory. Use the bundled client
so discovery respects BROWSER_REMOTE_AGENT_URL / BROWSER_REMOTE_AGENT_PORT and
the loopback-only agent-lane boundary:

```bash
node --input-type=module <<'EOF_STATUS'
import client from './scripts/relay-client.js';
const response = await client.status();
console.log(JSON.stringify(response.body, null, 2));
if (response.status !== 200 || response.body?.ok !== true) process.exitCode = 1;
EOF_STATUS
```

Read `extensions`, keyed by composite `endpointId` (`keyId.browserId`). Select a
connected endpoint mapped to the requester and authorized for this task. Accept
only an explicit owner confirmation of the exact endpoint/browser in a trusted
owner conversation, or an existing owner-confirmed mapping in memory that records
the requester, exact endpoint and allowed scope. A trusted owner can identify
their own browser or explicitly authorize a named requester to use it; being the
owner alone does not identify which of several endpoints is theirs. Honor later
revocations. Never persist connection-key plaintext in that mapping.
Keep a confirmed mapping in the host's private per-user memory/reference record,
including who confirmed it and the source conversation/message. A missing record
is not evidence of authorization. When asking the owner privately, send only the
requester's identity, the permission decision needed and minimal target context;
do not forward group history, private page contents or credentials.

Status has no owner or requester-mapping field. Labels, capability support and a
browser's session-permission switch do not establish identity or delegation. If
no trusted mapping exists, do not start: ask the owner privately to establish it.
For a non-owner's request, seek owner authorization rather than asking that person
to connect a browser or assuming the owner's connected browser is available.
If several authorized mapped browsers are possible, resolve the selection in a
private owner context. Do not expose endpoint IDs, labels or other users' browser
metadata in a group. Do not use a bare keyId or the first available connection.

Require `connected: true` and capability `agent-task-start-v1`. The capability
means implementation support, not that the session permission is enabled;
`/status` does not report that permission. The extension checks it on start.
If `agentTurn` indicates an active exchange, preserve it and its evidence;
do not launch a competing task. An absent agentTurn does not guarantee idle:
the extension can still reject a start with TASK_START_CONFLICT.

If a trusted mapping exists but its browser is offline, ask its owner privately
to connect that Coco extension. If browsers are online but none is authorized
for this requester, report missing authorization and seek the owner privately;
do not suggest merely connecting another extension. If the capability is missing,
explain the compatibility requirement.
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

- TASK_START_DISABLED: ask the browser owner to enable "Allow Agent to start tasks this
  session" in the extension if they want this workflow. Do not enable it yourself.
- TASK_START_UNSUPPORTED or UNKNOWN_ENDPOINT: explain the specific
  missing connection/capability; do not silently choose another endpoint.
- EXT_OFFLINE: the browser is unavailable, possibly after the request was sent.
  Unless delivery is positively known not to have occurred, treat the outcome
  as unknown and do not resend or start another task.
- TASK_START_CONFLICT: the browser cannot accept this start. Causes include an
  active task, an incognito/missing active tab, a changed payload under the same
  request ID or a full start-record cache. Do not assume only an active task.
- TASK_START_REVOKED: treat this as a refusal from the browser side. Causes include
  the browser owner pressing Stop, disabling permission, changing connection
  settings, or the startup task tab being closed, moved or lost. Do not infer an
  accidental context change.
  Check known outcomes and partial effects. A new start requires that browser
  owner's renewed explicit request or consent; the original requester's request
  alone is insufficient, even when an earlier mapping remains recorded.
- RELAY_DOWN (connection refused): the start was not delivered to the relay;
  report service unavailability, not an unknown browser execution result.
- A timeout, transport error or invalid response can have an unknown outcome.
  Report uncertainty; do not resend as if the first request never happened.

Do not automatically retry any refusal. Failed starts can be cached by request ID,
so the same ID can return its previous refusal after the cause is resolved. Once
the refusal and any partial effects are understood, the cause has been resolved,
no conflicting task remains, and the user explicitly requests a new start, use a
fresh request ID for that new logical start. Recheck the same owner mapping and
permission requirements. After REVOKED or browser Stop, also obtain the browser
owner's renewed explicit consent; resolving a technical cause or getting another
request from the requester does not replace it. Never use a new ID to evade a
refusal, revocation, completed/stopped task, or unknown outcome. For an explicit retry of the same
logical start (especially an uncertain one), retain the identical ID and payload.

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
