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

## Prerequisites

Required:

| Need | Why | Check |
|---|---|---|
| **Claude Code** with mods, in a terminal or the desktop app | The band shows on those two only. | `claude --version` |
| **GitHub CLI (`gh`)** on your `PATH` | The mod reads PR state with `gh pr view` and `gh api`. It does not work without it. | `gh --version` |
| **A `gh` login** that can read the repos you open PRs in | Without it, PRs show no status. | `gh auth status` |
| **PR links in the session** | The mod tracks only PRs a command names, a `gh pr` command prints, or you write. A `gh pr view 12` with no `--repo` is not found. | |

Install `gh`: `brew install gh` (macOS), `winget install --id GitHub.cli` (Windows), or see <https://cli.github.com>. Sign in with `gh auth login`. For GitHub Enterprise Server, use `gh auth login --hostname <host>`.

Optional, for the best look:

- **A Nerd Font** draws the button icons (eye, wrench, copy, close). Ghostty has one built in. In other terminals, install one from <https://www.nerdfonts.com> and select it as the terminal font. Without one the icons show as empty boxes. Then open `/plugin`, pick `session-prs`, and set `Button style` to `words`.
- **A terminal that draws links** makes the repo, number, status and CI clickable. Ghostty, iTerm2, WezTerm, kitty, Alacritty and the VS Code terminal do. macOS Terminal does not, so the mod shows plain text there. Use the `copy` button to get a PR link. `Clickable links` in `/plugin` is `auto` by default. Set it to `on` or `off` to force it.

Each row shows the repo, the PR number, the status (open, draft, merged, closed), whether it can merge (ready, conflicts, checks failing, checks pending, behind, blocked) the review state, and how many review comment threads are still unresolved (read through the GitHub GraphQL API with `gh api`, first 100 threads). The repo, number, status, merge badge and open-comments count open the PR when you click them. The click reuses a browser tab: if Chrome, Brave, Edge, Chromium or Safari already shows that page, it switches to that tab; otherwise it opens a new tab in your default browser. The first click asks macOS to let your terminal control the browser; say yes. Arc and Firefox cannot be searched, so they get a new tab each time. Set `Reuse browser tabs` to `off` in `/plugin` to use the terminal's own links instead (Linux opens a new tab with `xdg-open`; Windows always uses the terminal's own links). The mod reads the system from the engine's own `platform` value. The list refreshes every minute and after `git push` or a `gh pr` command.

It tracks only the PRs the session used or you asked about. A PR is added when:

- a Bash command names it: a PR link, `gh pr view 12 --repo <owner/name>`, or `gh api repos/<owner>/<name>/pulls/<number>/...`, in the main chat or in a subagent,
- a `gh pr` command that names none (for example a create) prints a PR link: the first link is added,
- you type or paste a PR link in a message.

These are not added: links Claude writes in its replies, other command output, results from connected servers, and commands that list many PRs (`gh pr list`, `gh pr status`, `gh search`). If a PR you do not need still shows, press `dismiss` on its row.

Only real pull requests stay. GitHub opens a `/pull/N` link as an issue when N is an issue. The mod checks each link with `gh`, and drops any that is an issue (or does not exist) on the next refresh.

It reads PR state with the `gh` CLI, so `gh` must be installed and signed in.

## Use

- `/prs` shows the band, refreshes it, and brings back any PRs you dismissed.
- `/prs scan` also reads Claude's own replies and the session summary, and adds every PR link in them. Use it when Claude listed PRs that the band lacks.
- `/prs <link> <link>` adds those PRs.
- The `Show:` row filters the band by status (all, open, draft, merged, closed). Each button shows its count, and the active one is highlighted. `/prs` resets the filter to open.
- The `Needs:` row is a second filter for what needs attention: open comments, CI failing, conflicts, changes requested, needs review, approved, ready to merge. It combines with the status filter, and each button shows its count. A button shows only when some PR matches. `/prs` resets it.
- The CI column shows `failing`, `running` or `passing`, from the PR's checks. Click it to open the checks page.
- `Author:` and `Show:` share one line. Each header has its own color (blue, teal, and amber for `Needs:`), and the chosen button has a solid background in that color. Other buttons stay plain.
- The `Author:` filter shows only **your** PRs by default (the login `gh` is signed in as). Press `everyone` to include PRs others wrote. `/prs` goes back to mine.
- The defaults are `Author: mine`, `Show: open` and `Needs: any`. They apply when the band first shows and each time you type `/prs`.
- `dismiss merged (N)` removes every merged PR from the band at once. `/prs` brings them back.
- A PR whose CI fails has a `fix CI` button. It runs `/<skill> <PR link>` in this session as if you typed it, so you see the command and Claude's reply here. If the engine does not list the skill as a slash command, the mod asks Claude in words ("Use the <skill> skill on this pull request: <link>"), and Claude uses the skill by name. Either way a toast tells you what was sent. If Claude is busy, it waits its turn. Your own skill runs on that PR. Set the skill name once: open `/plugin`, pick `session-prs`, and fill in `Fix-CI skill` (for example `ci-fix`). Until it is set, the button tells you how.
- An open or draft PR has a `review` button. It runs each of your review skills in this session as if you typed it, one after the other: `/<skill> <PR link>`. Set them once: open `/plugin`, pick `session-prs`, and fill in `Review skills`, separated by commas (for example `code-review, my-plugin:security-review`). Until it is set, the button tells you how.
- Every row has a `copy` button that puts the PR link on your clipboard.
- Every row has a `dismiss` button that removes it from the band. It does not change the PR on GitHub.
- `/prs hide` hides it. While hidden and PRs are tracked, one colored line (`▸ Session PRs  ● 2 open  ✔ 1 merged  click here or type /prs to expand`) shows where the band was. Click it to expand.
- The band also has `hide` and `refresh` buttons at the top left. `refresh` reads every open PR again and says so ("Refreshed 3 PR(s) at 14:05."). If `gh` cannot read a PR, a red line says which one and why, and the numbers shown may be old.
- The buttons are Material Design icons in colored pills: eye = review (blue), wrench = fix CI (amber), copy = copy (teal), close = dismiss (red), chevron = hide (gray), refresh (green). They come from the Nerd Fonts set, so the terminal needs a [Nerd Font](https://www.nerdfonts.com) (Ghostty has one built in). If you see empty boxes, open `/plugin`, pick `session-prs`, and set `Button style` to `words`. Each column is as wide as its widest cell. In a tight window the merge and review columns shrink first, then the repo; when every PR is in one owner's repos, the owner (`jfrog/`) is left off before a repo name would break, so the table takes only the space it needs. In a narrower window the gaps tighten, then long text wraps inside its column, and under about 80 columns (110 with words) each PR takes two lines.

## License

MIT. See [LICENSE](LICENSE).
