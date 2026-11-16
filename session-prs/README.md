# session-prs

A Claude Code mod that shows every pull request created in your session in a band above the prompt.

## Install

At the prompt of a terminal session:

```
/plugin install session-prs --marketplace bhanurp/claude-mods
```

From a shell:

```
claude plugin install session-prs --marketplace bhanurp/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

Each row shows the repo, the PR number, the status (open, draft, merged, closed), whether it can merge (ready, conflicts, checks failing, behind, blocked) the review state, and how many review comment threads are still unresolved (read through the GitHub GraphQL API with `gh api`, first 100 threads). The repo, number, status and merge badge are links that open the PR. The list refreshes every minute and after `git push` or a `gh pr` command.

It tracks only the PRs the session used or you asked about. A PR is added when:

- a Bash command names it: a PR link, `gh pr view 12 --repo <owner/name>`, or `gh api repos/<owner>/<name>/pulls/<number>/...`, in the main chat or in a subagent,
- a `gh pr` command that names none (for example a create) prints a PR link: the first link is added,
- you type or paste a PR link in a message.

These are not added: links Claude writes in its replies, other command output, results from connected servers, and commands that list many PRs (`gh pr list`, `gh pr status`, `gh search`). If a PR you do not need still shows, press `dismiss` on its row.

It reads PR state with the `gh` CLI, so `gh` must be installed and signed in.

## Requirements

1. **Claude Code** in a terminal or the desktop app, in a build that supports mods. The band shows on those two only.
2. **GitHub CLI (`gh`)**, installed and on your `PATH`. The mod tracks a PR when `gh pr create` runs, and reads its state with `gh pr view`. It does not work without `gh`.
   - macOS: `brew install gh`
   - Windows: `winget install --id GitHub.cli`
   - Linux and other systems: see <https://cli.github.com>
3. **A `gh` login** that can read the repos you open PRs in. Check with `gh auth status`. If you are not signed in, run `gh auth login`. For a GitHub Enterprise Server host, run `gh auth login --hostname <host>`.
4. **PR links in the session.** The mod finds a PR when a command names it, a `gh pr` command prints it, or you write its link. A PR that was never named in the session, and a `gh pr view 12` with no `--repo`, are not found.

## Use

- `/prs` shows the band, refreshes it, and brings back any PRs you dismissed.
- The `Show:` row filters the band by status (all, open, draft, merged, closed). Each button shows its count, and the active one is highlighted. `/prs` resets the filter to open.
- The `Needs:` row is a second filter for what needs attention: open comments, CI failing, conflicts, changes requested, needs review, approved, ready to merge. It combines with the status filter, and each button shows its count. A button shows only when some PR matches. `/prs` resets it.
- The CI column shows `failing`, `running` or `passing`, from the PR's checks. Click it to open the checks page.
- `Author:` and `Show:` share one line. Each header has its own color (blue, teal, and amber for `Needs:`), and the chosen button has a solid background in that color. Other buttons stay plain.
- The `Author:` filter shows only **your** PRs by default (the login `gh` is signed in as). Press `everyone` to include PRs others wrote. `/prs` goes back to mine.
- The defaults are `Author: mine`, `Show: open` and `Needs: any`. They apply when the band first shows and each time you type `/prs`.
- `dismiss merged (N)` removes every merged PR from the band at once. `/prs` brings them back.
- A PR whose CI fails has a `fix CI` button. It sends `/<skill> <PR link>` to Claude, so your own skill runs on that PR. Set the skill name once: open `/plugin`, pick `session-prs`, and fill in `Fix-CI skill` (for example `ci-fix`). Until it is set, the button tells you how.
- An open or draft PR has a `review` button. It runs each of your review skills on that PR, one after the other, sending `/<skill> <PR link>` for each. Set them once: open `/plugin`, pick `session-prs`, and fill in `Review skills`, separated by commas (for example `code-review, my-plugin:security-review`). Until it is set, the button tells you how.
- Every row has a `copy` button that puts the PR link on your clipboard.
- Every row has a `dismiss` button that removes it from the band. It does not change the PR on GitHub.
- `/prs hide` hides it. While hidden and PRs are tracked, one colored line (`▸ Session PRs  ● 2 open  ✔ 1 merged  click here or type /prs to expand`) shows where the band was. Click it to expand.
- The band also has `hide` and `refresh` buttons at the top left.
- The buttons are Material Design icons in colored pills: eye = review (blue), wrench = fix CI (amber), copy = copy (teal), close = dismiss (red), chevron = hide (gray), refresh (green). They come from the Nerd Fonts set, so the terminal needs a [Nerd Font](https://www.nerdfonts.com) (Ghostty has one built in). If you see empty boxes, open `/plugin`, pick `session-prs`, and set `Button style` to `words`. Each column is as wide as its widest cell, so the table takes only the space it needs. In a narrower window the gaps tighten, then long text wraps inside its column, and under about 80 columns (110 with words) each PR takes two lines.

## License

MIT. See [LICENSE](LICENSE).
