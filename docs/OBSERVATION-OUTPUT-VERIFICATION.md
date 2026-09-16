# Screenshot / observe output verification

Verified 2026-09-16 with Node.js 24.18.0 and Chrome for Testing 149.0.7827.55.
The code under test is the working-tree CLI fix based on Remote `00afd30` and
the built Extension `a31989a`. No production service was changed.

## Correctness

- `npm test`: 7 Node tests, 40 relay smoke assertions and 41 CLI assertions passed.
- CLI coverage now uses the actual CDP `{data}` shape and a complete small PNG,
  rather than injecting a `format` field that the real extension does not return.
- Both image commands remove Base64 from stdout, preserve decoded image bytes,
  use the correct MIME/file extension, and return an absolute agent-host path.
- `observe` preserves page text, viewport, timestamps, version and other metadata.
- Storage failure, invalid bytes and MIME mismatch return an error without the image payload.

## Local browser sample

Used the setup and local page fixture from the sibling extension's
`tests/e2e/browser-actions.mjs`: disposable Chrome profile, built extension,
real WebSocket relay and real CLI subprocess. Opened the fixture, filled the
text input with `Observation output verification`, checked a checkbox, then
ran each image command three times. All six saved images matched the received
bytes exactly. The final `observe` PNG was opened with an image tool and visibly
contained the populated form and checked checkbox.

| Command | Sample | CLI wall time, ms | Image bytes | CLI stdout bytes | Same response with Base64, bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| screenshot | 1 | 93.78 | 42,293 | 316 | 56,473 |
| screenshot | 2 | 82.55 | 42,293 | 316 | 56,473 |
| screenshot | 3 | 76.52 | 42,293 | 316 | 56,473 |
| observe | 1 | 101.56 | 42,293 | 4,907 | 61,089 |
| observe | 2 | 77.12 | 42,293 | 4,907 | 61,089 |
| observe | 3 | 86.42 | 42,293 | 4,907 | 61,089 |

The final column is computed by serializing the exact original RPC response
before CLI image conversion. It is not a timed run of the previous CLI.
For `observe`, this corresponds to the old intended stdout content and the
new output is approximately 92% smaller. `screenshot` already saved ordinary
images before this fix, so its final-column comparison is **not** a new saving.

Wall time includes process startup, local RPC, browser capture, image storage
and JSON output. These are three local samples per command, not a WAN/LLM
benchmark or a before/after speed comparison. No model token or billing
measurement was performed; image bytes still cross the network and reading
the image with the model's image tool still has its normal cost. Output size
also varies with page text, image content and the configured output path.

The fixture script's browser bootstrap was reused in a temporary verification
harness; the permanent regression coverage is `tools/test-cli.js`.
