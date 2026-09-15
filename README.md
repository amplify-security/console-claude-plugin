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

A commit with no findings produces no interruption. The check never blocks or fails a commit, and it
runs in the background so the session stays responsive.

## Requirements

- [Claude Code](https://code.claude.com) with plugins enabled.
- [Bun](https://bun.sh). Install it with `curl -fsSL https://bun.sh/install | bash`. Without it the
  plugin reminds you once a day and otherwise does nothing.
- An Amplify API key for your user.
- A repository that is onboarded as a project in your Amplify organization, with a hosted `origin`
  remote and at least one pushed commit. Amplify checks out the last pushed commit and applies your
  new changes on top, so a repository that has never been pushed cannot be checked yet.

## Install

```sh
claude plugin marketplace add amplify-security/console-claude-plugin
claude plugin install console@amplify-security
```

Then provide your API key, either inside Claude Code:

```
/plugin configure console@amplify-security
```

or on the command line:

```sh
claude plugin install console@amplify-security --config api_key=<your Amplify API key>
```

If your key belongs to exactly one Amplify organization, that is all. If it belongs to several, the
plugin lists them by name and ID the first time it runs and asks you to set `org_id`.

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

Messages from the plugin start with "Amplify Console:" and are relayed by Claude. A configuration
problem is reported once per session; a check that was skipped or failed is reported once per commit.

| Message                                    | Meaning                                                                                  |
|--------------------------------------------|------------------------------------------------------------------------------------------|
| "is not configured"                        | No API key. Run `/plugin configure console@amplify-security`.                           |
| "cadence is set to"                        | Only `commit` is supported. Set `cadence` back to `commit` or clear it.                  |
| "belongs to N organizations"               | Pick one from the list and set `org_id`.                                                 |
| "is not onboarded as an Amplify project"   | The repository's `origin` URL does not match a project in your organization.              |
| "no commit in this repository has been pushed yet" | Push at least once so Amplify has a base commit to check out.                    |
| "could not reach Amplify"                  | Network or credential problem. The message includes the HTTP status.                     |
| "Bun is not installed"                     | Install Bun (see Requirements).                                                          |

A log of every run and every skipped commit is written to `log.txt` in the plugin's data directory,
`~/.claude/plugins/data/console-amplify-security/`.

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
