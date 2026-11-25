# Gemini Web observations

Watari can read status from a separately installed Gemini Web bridge. Set
`WATARI_GEMINI_WEB_URL` to its loopback HTTP or HTTPS URL before starting
Watari. Unset the variable or set it to `off` to disable the reader. The
URL must not include credentials.

The reader sends a credential-free GET to `/local/status`. It refuses redirects
and validates the response size, schema and counters. Watari does not receive
Google cookies or the bridge's API token. A stale, missing or invalid response
leaves capacity unknown.

The dashboard shows the bridge's observed submissions, completions and
failures by model and operation. The row also shows the last outcome and
any reported retry time. Requests made outside the bridge do not appear in
these counts. The reader has no data on remaining allowance, quota reset time
or shared Google limits.

If the bridge reports pending sign-in, follow its enrollment instructions.
Configure the model route separately in the provider harness. The dashboard
reader never sends a generation request or changes the agent roster. The
[Gemini project pool](GEMINI_POOL.md) uses the official Google API, with no
automatic switch to the web bridge.
