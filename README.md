# claude-mods

Mods for Claude Code, by [bhanurp](https://github.com/bhanurp). Each folder is one mod.

## Install

Add the store once, then install any mod from it. At the prompt of a terminal session:

```
/plugin install session-prs --marketplace bhanurp/claude-mods
```

From a shell:

```
claude plugin install session-prs --marketplace bhanurp/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

## Prerequisites

Each mod lists its own. For `session-prs`: Claude Code with mods, and the GitHub CLI (`gh`) signed in. A Nerd Font and a terminal with link support are optional. See [its README](session-prs/README.md#prerequisites).

## Mods

| Mod | What it does |
|---|---|
| [session-prs](session-prs) | A band above the prompt that tracks the PRs your session used: status, CI, review, open comments, and buttons to review, fix CI, copy and dismiss. |

## License

MIT. See [LICENSE](LICENSE).
