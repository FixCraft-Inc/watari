# Provider dashboard

Use `watari providers` for a one-time status read or `watari dashboard` for a local browser view. The dashboard can show account capacity, reset times, billing periods, and reasons a provider reports an account as unavailable. Fields the provider omits appear as unreported.

The dashboard can also read two optional account pools that run on the same machine: [CodexLB](https://github.com/Soju06/codex-lb) for Codex and [TeamClaude](https://github.com/KarpelesLab/teamclaude) for Claude Code. Set `WATARI_CODEXLB_URL` or `WATARI_TEAMCLAUDE_URL` to override their loopback URLs, or set either to `off` to disable it. Those tools handle their own logins and account enrollment. Watari reads CodexLB accounts through `/api/accounts`. Suggest and automatic routing for CodexLB also need the `/api/provider-status` routing endpoints, which stock CodexLB does not serve. The Watari dashboard itself listens on `127.0.0.1` and prints its access link when it starts.

The default routing mode is off. Suggest mode shows proposed changes, and automatic mode applies them through the provider's own controls using fresh usage data. Each provider still picks the account for an individual request. Where accounts are known to be exhausted, Watari can queue a checkpoint notice for affected agents. It leaves capacity unknown if the evidence is stale or missing.

On a systemd system, `watari dashboard --install` registers a user service. `watari dashboard --link` prints the private dashboard link again. Run `watari --help` for the available flags.

The [Gemini project pool](GEMINI_POOL.md) and [Gemini Web status reader](GEMINI_WEB.md) have separate setup.
