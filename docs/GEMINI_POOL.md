# Gemini project pool

OpenCode is the Gemini harness. Watari's optional connector forwards its
Google GenerateContent requests through an explicitly enrolled pool of Free
Tier projects. It does not add a model provider to the generic agent roster or
choose a project's agent roles.

The connector listens on `127.0.0.1:4466`. Its private store defaults to
`$XDG_CONFIG_HOME/watari/gemini-pool`, or `~/.config/watari/gemini-pool`.
Configuration, the local access token, quota evidence and copied Google key
files have mode 600 inside mode-700 directories. Never put Google keys in
chat, command arguments, Git, `agents.json` or an OpenCode project file.

## Free-only enrollment

Disable billing on each exact Google project before enrolling its key. The
`--billing-disabled` option records your attestation. The connector cannot
verify billing from an API key and cannot prevent charges if billing is later
enabled. Multiple keys in one project share quota and are not separate pool
entries. Use the exact project ID consistently across accounts.

Google's paid-project rate limits are not free allowances. Project spending
caps can overrun because of billing delays and running tasks. For zero paid
API usage, keep enrolled projects without billing. See Google's
[billing guide](https://aistudio.google.com/docs/billing#revert-to-free) and
[spending-cap limits](https://aistudio.google.com/docs/billing#project-spend-caps).

Initialize the empty store:

```bash
watari gemini-pool init
watari gemini-pool --help
```

Save a key in a regular file owned by your user with mode 600. Then run the
`add` command with a label, the exact Google project ID, `--key-file` naming
that file, and `--billing-disabled`. The key is copied into the connector's
private store. Enrollment makes no Google request. Repeated project IDs,
labels or keys are rejected. Stop the connector before changing enrollment.
Key values may contain dots. Embedded whitespace and control characters are
rejected before a key can be used as an HTTP header.

The store accepts at most 16 projects. `config.json` holds labels, project
IDs, key-file names and an explicit model allowlist. Initialization allows
`gemini-4-hydrogen`. Changing that allowlist is an operator decision, not an
automatic model fallback.

```bash
watari gemini-pool status
watari gemini-pool profile
watari gemini-pool serve
```

`status` reads local evidence without contacting Google. It reports attempted
model calls, observed exhaustion and cooldowns. It cannot know quota spent by
other applications or compute an authoritative remaining allowance.
`serve` runs in the foreground until interrupted. No service is installed
automatically. `--directory` selects another private store, and `--port`
selects a port for `profile` or `serve`.

An exclusive `owner.lock` prevents two servers from using the same quota
state and prevents enrollment during serving. A crash can leave that file.
Inspect its recorded PID and the exact store before removing a stale lock.
Corrupt quota state fails closed instead of resetting observed exhaustion.

### Manage existing keys

Key management currently uses the CLI and private store. The provider dashboard
has no Gemini key editor. `status` lists enrolled labels and project IDs without
printing keys. The CLI supports adding projects, but has no replace/remove
subcommand yet.

Stop the connector before you add a project. If you run `serve` as a systemd user service, stop and start that unit around the change. The unit name below is an example:

```bash
chmod 600 ~/new-google.key
systemctl --user stop watari-gemini-pool.service
watari gemini-pool add project-05 YOUR_PROJECT_ID --key-file ~/new-google.key --billing-disabled
systemctl --user start watari-gemini-pool.service
```

The source file contains only the API key. Confirm billing is disabled on that
exact project before using the attestation flag. Enrollment copies the key, so
remove the temporary source file once enrollment succeeds.

To replace an existing project's key, stop that same service, find its label in
`config.json`, and replace only the file named by its `keyFile` under `keys/`.
Keep it a regular file owned by you with mode 600, then start the service.
Keep the project ID and `state.json` unchanged: another key for the same project
does not grant fresh project quota. Duplicate credentials are rejected when
the connector loads. Never paste a key into a command argument or chat.

### A cooldown does not resume a failed agent

A temporary or unclassified 429 sets `cooldownUntil`, without setting the daily
`exhaustedUntil`. After that timestamp, a new request may try the same project.
Watari does not start an automatic retry turn for quota errors. OpenCode can
still keep its existing prompt pending after the pool returns HTTP 429, leaving
the peer displayed as busy while the pool itself is idle. Check pool status
before retrying. If every project is `daily_exhausted`, wait until the reported
`exhaustedUntil` (normally midnight Pacific). A minute's wait will not restore it.
Stop only the affected peer through Watari to cancel a pending prompt while
preserving its native conversation. Check active tools before interrupting.
After capacity returns, address a continuation message to that peer. If it has
already failed, `/retry <alias>` (for example `/retry gemini`) resumes its saved conversation. Both actions
start work and can consume quota. Neither requires clearing context or restarting
the shared coordinator.

`attemptsToday` counts upstream attempts, including retries and rejected calls.
It is not the number of successful requests or a remaining daily allowance.
Status reports each bucket as `ready`, `cooldown` or `daily_exhausted`.
New quota failures retain their classification, observation/retry timestamps,
bounded quota IDs and numeric limits. Raw Google errors and credentials are
never retained. Older cooldowns have no quota IDs, so their original RPM, TPM
or unknown cause cannot be reconstructed.

Waiting a minute does not guarantee the next request will fit a TPM limit.
A harness can resend substantial conversation context on each request, and
other applications using the project share its quota. These are possible
causes of repeated throttling, not a diagnosis from a cooldown timestamp.

## Connect OpenCode for one project

`profile` writes private `opencode.json` beside the pool config. It selects
the first allowed model for both primary and small-model tasks, restricts
Google's catalog to that model and redirects Google requests to loopback.
It contains a native `{file:...}` reference to the local access token, with
no Google key. It disables sharing and automatic OpenCode updates.

For the default store, launch the project's Watari service with this
environment set before it starts:

```bash
export OPENCODE_CONFIG="$HOME/.config/watari/gemini-pool/opencode.json"
cd ~/src/my-project
watari .
```

An already-running project service retains its launch environment. Setting
this variable in another terminal does not retarget that service. Finish
active work and reopen its service with the intended environment before
adding an OpenCode agent. The connector does not change global OpenCode
configuration.

To avoid an environment variable on each launch, merge the generated profile
into the project's ignored `opencode.json` instead. Preserve existing MCP and
instruction settings, keep it outside Git, and restrict its file permissions.
OpenCode reads this native project configuration automatically. Restrict
`enabled_providers` to `["google"]` when that project's OpenCode harness is
dedicated to this connector. This does not affect the separate Codex or Claude
harnesses. Verify the merged result with native `opencode debug config`
without printing its credentials.

Select an allowed Google model and one of its reported variants through
Watari's OpenCode catalog. The connector does not add or start an agent. A
managed agent in Global can consume model requests before it receives a
dedicated assignment.

The generated profile uses the installed OpenCode v1 schema. Newer OpenCode
web documentation may describe another schema. Qualify a harness update
before replacing the installed executable.

## Routing and request ownership

- Only allowlisted models and `generateContent`/`streamGenerateContent`
  operations are accepted. There is no paid route, Vertex route, web route,
  alternate model or arbitrary upstream URL.
- Each attempted Google model call is recorded before it is sent. Tool loops,
  retries and summaries produce more calls than visible user messages.
- New requests prefer the ready project with the fewest attempts today, with
  configured order breaking ties. This uses previously unused projects without
  first requiring another project to fail. Local attempts balance use, rather
  than estimate remaining Google quota.
- A structured Google Free Tier daily project/model quota failure marks that
  bucket exhausted until midnight Pacific and tries the next available
  project. It makes at most one attempt per project for the incoming call.
- Recognized Free Tier project/model RPM and TPM failures set a per-project
  cooldown and try another available project. Every reported violation must
  match a supported minute quota and the requested model, when specified.
  Confirmed minute cooldowns are skipped. When all projects are limited, the
  response reports the earliest relevant retry time.
- Unknown, paid, mixed and mismatched-model minute limits return without
  rotating. Active unclassified cooldowns, including older records without
  quota evidence, block balancing until expiry because their scope is unknown.
  Authentication errors, redirects, transport errors and other failures are
  returned without replaying a possibly accepted call.
- Exhausted buckets and attempt counts survive restart. Pacific daylight
  saving transitions are accounted for. Actual Google quotas remain authoritative.
- One request owns the connector through response consumption or cancellation.
  Busy callers get HTTP 429. Cancellation and shutdown abort the upstream.
  There is no unbounded request queue or background retry loop.
- Inputs are limited to 8 MiB, upstream error bodies to 64 KiB and responses
  to 32 MiB. Body intake has a 30-second deadline and the complete operation
  a five-minute deadline. Errors and status never include upstream keys.
  Persisted quota state is limited to 4 MiB, enough for all 256 supported
  project/model buckets and their bounded violation evidence.

The endpoint requires its private local token, rejects browser origins and
foreign Host headers, forwards no client cookies/authorization, and sends
Google keys only to the fixed HTTPS Google API endpoint without redirects.
Successful JSON/SSE bytes and thought signatures pass through unchanged.
This is a same-user connector, not isolation from other processes with the
same OS privileges.

## Gemini Web status

Watari can read status from a separate loopback bridge. See
[Gemini Web observations](GEMINI_WEB.md) for configuration. The project pool
uses only the official Google API and has no automatic web fallback.

## Verification

`tests/gemini-pool.test.ts` uses injected Google responses and loopback
requests. It covers daily and confirmed-minute rotation, ready-project
balancing, persisted quota evidence, DST, attempt reservations, ambiguous
failures, authentication, streaming cleanup, private files and enrollment.
No test sends a model request to Google.
Inspect the native OpenCode configuration and catalog before using a model
in a live turn. Catalog inspection verifies discovery only.
