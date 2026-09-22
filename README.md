# Amplify Console plugin for Claude Code

Runs your organization's Amplify security detections against the code Claude commits, while you are
still in the Claude Code session. Findings come back to Claude with instructions to fix what is valid
and call out anything it believes is a false positive, so policy violations are caught before a pull
request exists.

## What it does

Each time Claude commits in a repository that is onboarded in Amplify, the plugin:

1. Tells you a check has started. Claude mentions it in its reply, so you know it is running.
2. Sends the committed changes to Amplify, which runs your organization's detections against them.
3. Wakes Claude with the results one to two minutes later. Claude fixes valid findings in place and
   explains any it disagrees with, then carries on with what you asked.

Every commit gets exactly one follow-up: the findings, a one-line "no findings", or a one-line reason
the commit was not checked and what to do about it. The check never blocks or fails a commit, and it
runs in the background so the session stays responsive.

## Requirements

- [Claude Code](https://code.claude.com) with plugins enabled.
- [Bun](https://bun.sh). Install it with `curl -fsSL https://bun.sh/install | bash`. Without it the
  plugin tells you on each `git commit` that it was not checked (it cannot tell whether the commit
  succeeded), and otherwise does nothing.
- An Amplify API key for your user.
- A repository that is onboarded as a project in your Amplify organization, with a hosted `origin`
  remote and at least one pushed commit. Amplify checks out the last pushed commit and applies your
  new changes on top, so a repository that has never been pushed cannot be checked yet.

## Install

```sh
claude plugin marketplace add amplify-security/console-claude-plugin
claude plugin install console@amplify-security
```

Claude Code asks for your API key when it enables the plugin. You can also pass it on the command line:

```sh
claude plugin install console@amplify-security --config api_key=<your Amplify API key>
```

The key is a sensitive setting, so it is kept in your system keychain and does not appear in
`/plugin configure`; the other settings do.

If your key belongs to exactly one Amplify organization, that is all. If it belongs to several, the
plugin lists them by name and ID the first time it runs and asks you to set `org_id`; commits are not
checked until you do.

Restart Claude Code after installing or changing configuration.

## Configuration

| Setting      | Required | Purpose                                                                                   |
|--------------|----------|-------------------------------------------------------------------------------------------|
| `api_key`    | yes      | Your Amplify API key. Stored securely by Claude Code.                                     |
| `org_id`     | no       | Your Amplify organization ID. Detected automatically when your key belongs to one organization; otherwise the plugin lists your organizations and asks you to choose. |
| `api_url`    | no       | Base URL of the Amplify API. Leave the default unless Amplify tells you otherwise.        |
| `tenant_url` | no       | Base URL of the Amplify account service, used only to look up your organizations. Leave the default. |
| `cadence`    | no       | When to run. Only `commit` is supported today.                                            |

Each setting can also be supplied as an environment variable in the shell that launches Claude Code:
`AMPLIFY_API_KEY`, `AMPLIFY_ORG_ID`, `AMPLIFY_API_URL`, `AMPLIFY_TENANT_PROVISIONER_URL`,
`AMPLIFY_CADENCE`. Configuration set through Claude Code takes precedence.

## What is sent to Amplify

Only the diff of the commit Claude just made, computed against the most recent commit that already
exists on your remote, together with the base commit's SHA. Uncommitted work, untracked files, and
binary files are never sent. If all unpushed changes together exceed 1 MiB or 300 files, commits are skipped until the next push. Amplify applies the diff to a
fresh checkout of the base commit for the duration of the check and does not store it.

Findings from these checks are reported into the Claude Code session and are kept separate from your
project's baseline findings in the Amplify Console.

## Troubleshooting

Messages from the plugin start with "Amplify Console:" and are relayed by Claude. A commit that could
not be checked says so on the commit itself, every time, with the reason and what to do; a check that
started and failed is reported when it fails. Setup problems that Amplify reports, such as a repository
that is not onboarded, are reported once and then repeated briefly on each later commit until you
start a new Claude Code session.

| Message                                  | Meaning                                                                                       |
|------------------------------------------|-----------------------------------------------------------------------------------------------|
| "no findings in commit"                  | The check finished and your organization's detections reported nothing in the changed lines. |
| "was not checked. The plugin is not configured" | No API key. Set `AMPLIFY_API_KEY` or reinstall with `--config api_key=…`, then start a new session. |
| "was not checked. The plugin's cadence is set to" | Only `commit` is supported. Set `cadence` back to `commit` or clear it.              |
| "Your API key belongs to N organizations" | Pick one from the list and set `org_id`, then start a new session.                          |
| "Your organizations could not be looked up" | Amplify's account service was unreachable or rejected the key. Set `org_id` to skip the lookup. |
| "is not onboarded as a project"          | The repository's `origin` URL does not match a project in your organization. Onboard it, then start a new session. |
| "has no hosted origin remote"            | `origin` is missing or is not a hosted repository URL.                                        |
| "Nothing in this repository has been pushed yet" | Push at least once so Amplify has a base commit to check out.                       |
| "has no changes Amplify can check"       | The commit is empty or changes only binary files.                                             |
| "The unpushed changes now span" / "now exceed" | All unpushed changes together exceed 300 files or 1 MiB. Push to start a new range.    |
| "the check for commit … failed"          | The run could not be started, finished, or read. The message says whether Amplify was unreachable, rejected the key, or errored; the commit's changes stay in scope for the next check. |
| "The plugin hit an unexpected error"     | A bug in the plugin. The log has the stack trace.                                             |
| "was not checked because Bun is not installed" | Install Bun (see Requirements).                                                         |

Every message that mentions details points at the plugin log, `log.txt` in the plugin's data directory,
`~/.claude/plugins/data/console-amplify-security/`. It records every run, every skipped commit, and the
status behind each notice (HTTP status and error code, run ID). Quote the run ID when contacting Amplify
support; the log never contains text sent by Amplify's servers.

## Contributing

The plugin is Bun + TypeScript with no runtime dependencies.

```sh
bun install                    # development dependencies only
bun test
bun run typecheck
claude plugin validate . --strict
```

To try a working copy without installing it, run `claude --plugin-dir /path/to/console-claude-plugin`
with the `AMPLIFY_*` environment variables set. Setting `AMPLIFY_DRY_RUN=1` makes the plugin stop
before contacting Amplify and write the diff it would have sent to the plugin data directory under
`dry-run/`, which is useful when changing how the diff is built.

## License

MIT. See [LICENSE](LICENSE).
