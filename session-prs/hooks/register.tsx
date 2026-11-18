import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderChildren,
  SessionMessage,
} from 'claude-code'

import type { Pr } from '../types'

const REFRESH_MS = 60_000
const MAX_PRS = 100
// Any GitHub host (github.com, GHES): https://host/owner/repo/pull/123
const PR_URL = /https?:\/\/([^\s/]+)\/([^\s/]+\/[^\s/]+)\/pull\/(\d+)/g
// API path: repos/owner/name/pulls/12
const API_PR = /\brepos\/([^\s/"']+)\/([^\s/"']+)\/pulls\/(\d+)/g
// The host an API URL names: https://api.github.com/... or https://host/api/v3/...
const API_HOST = /https?:\/\/api\.([^\s/]+)\/repos\/|https?:\/\/([^\s/]+)\/api\/v3\/repos\//
// Commands that list many PRs: what they print is not this session's work.
const LISTS_PRS = /\bgh\s+(?:pr\s+(?:list|status)|search)\b/
// `gh pr view 12 --repo owner/name`, and the same with the flag first.
const PR_SUB = '(?:view|comment|review|checks|diff|edit|merge|close|reopen|ready|checkout)'
const CMD_NUM_FIRST = new RegExp(
  `\\bgh\\s+pr\\s+${PR_SUB}\\s+(\\d+)\\b([^\\n|;&]*)`,
  'g',
)
const CMD_REPO_FIRST = new RegExp(
  `\\bgh\\s+pr\\s+${PR_SUB}\\s+[^\\n|;&]*?(?:--repo|-R)[\\s=]+(\\S+)\\s+(\\d+)\\b`,
  'g',
)
const REPO_FLAG = /(?:--repo|-R)[\s=]+(\S+)/
// A Bash command that can change a PR's state: a push, or a PR command.
const CHANGES_PR =
  /\bgit(?:\s+-[Cc]\s+\S+|\s+-\S+)*\s+push\b|\bgh\s+pr\s+(?:create|merge|close|reopen|ready|review|edit|comment)\b/
// Extra refreshes after such a command, in ms.
const LATE_REFRESH_MS = [10_000, 45_000]

const prs = atom({ plugin: 'session-prs', key: 'prs' } as const, [], {
  shape: 'prs-6',
})
const notice = atom({ plugin: 'session-prs', key: 'notice' } as const, '', {
  shape: 'notice-1',
})

const isShown = atom({ plugin: 'session-prs', key: 'isShown' } as const, false, {
  shape: 'isShown-1',
})

// URLs of PRs the person dismissed from the band. /prs brings them back.
const dismissed = atom({ plugin: 'session-prs', key: 'dismissed' } as const, [], {
  shape: 'dismissed-1',
})

// Show only PRs the signed-in `gh` user wrote. On by default.
const onlyMine = atom({ plugin: 'session-prs', key: 'onlyMine' } as const, true, {
  shape: 'onlyMine-1',
})

// Which status the band shows: all, open, draft, merged, closed or unknown.
// Default: open.
const DEFAULT_FILTER = 'open'
const filter = atom({ plugin: 'session-prs', key: 'filter' } as const, DEFAULT_FILTER, {
  shape: 'filter-1',
})
// One color per filter group: Author blue, Show teal, Needs amber. Only the
// header and the chosen button are colored. Other buttons stay plain.
const AUTHOR_COLOR = { on: '#1f6feb', off: '#58a6ff' }
const SHOW_COLOR = { on: '#0f8b8d', off: '#39c5cf' }
const NEEDS_COLOR = { on: '#b45309', off: '#e3b341' }
const STATUS_ORDER = ['open', 'draft', 'merged', 'closed', 'unknown']

// A second filter, for what needs attention. '' = none. It combines with the
// status filter: both must match.
const attn = atom({ plugin: 'session-prs', key: 'attn' } as const, '', {
  shape: 'attn-1',
})
const ATTN: Record<string, { label: string; icon: string; test: (p: Pr) => boolean }> = {
  comments: { label: 'open comments', icon: '✎', test: p => p.unresolved > 0 },
  ci: { label: 'CI failing', icon: '✖', test: p => p.ci === 'failing' },
  conflicts: { label: 'conflicts', icon: '✖', test: p => p.merge === 'conflicts' },
  changes: { label: 'changes requested', icon: '✖', test: p => p.review === 'changes' },
  review: { label: 'needs review', icon: '■', test: p => p.review === 'needed' },
  approved: { label: 'approved', icon: '✔', test: p => p.review === 'approved' },
  ready: { label: 'ready to merge', icon: '✔', test: p => p.merge === 'ready' },
}
const attnTest = (k: string): ((p: Pr) => boolean) => ATTN[k]?.test ?? (() => false)
const ATTN_ORDER = ['comments', 'ci', 'conflicts', 'changes', 'review', 'approved', 'ready']

// Hex colors draw the same in every theme. Each status also has a symbol,
// so it reads without color.
const STATUS_COLOR: Record<string, string> = {
  open: '#238636',
  draft: '#6e7681',
  merged: '#8957e5',
  closed: '#da3633',
  unknown: '#9e6a03',
}
const STATUS_ICON: Record<string, string> = {
  open: '●',
  draft: '○',
  merged: '✔',
  closed: '✖',
  unknown: '?',
}
const UNKNOWN_COLOR = '#9e6a03'
const REPO_COLOR = '#58a6ff'
const NUM_COLOR = '#e3b341'

// Column widths follow what the rows hold. In a narrow band the flexible
// columns shrink to these minimums, and below that each PR takes two lines.
const FLEX_MIN = { repo: 14, merge: 13, review: 12 }
// Four pills in fixed slots, one cell apart. Icons take 3 cells each, words
// take the width of the word and a space on each side.
const SLOT_ICONS = { review: 3, fix: 3, copy: 3, dismiss: 3 }
const SLOT_WORDS = { review: 8, fix: 8, copy: 6, dismiss: 9 }
const slotsWidth = (slot: typeof SLOT_ICONS) =>
  slot.review + slot.fix + slot.copy + slot.dismiss + 3
const COLUMNS = ['repo', 'num', 'status', 'merge', 'ci', 'review', 'comments'] as const
type Column = (typeof COLUMNS)[number]
// The header word of each column is its least width.
const HEAD: Record<Column, string> = {
  repo: 'REPO',
  num: 'PR',
  status: 'STATUS',
  merge: 'MERGE',
  ci: 'CI',
  review: 'REVIEW',
  comments: 'COMMENTS',
}

// Material Design icons, from the Nerd Fonts set (the md- glyphs). They need
// a Nerd Font in the terminal, or a terminal that ships one, such as Ghostty.
// The iconStyle setting "words" shows plain words instead.
const md = (code: number) => String.fromCodePoint(code)
const ICON = {
  review: md(0xf0208), // eye
  fix: md(0xf05b7), // wrench
  copy: md(0xf018f), // content-copy
  dismiss: md(0xf0156), // close
  hide: md(0xf0143), // chevron-up
  refresh: md(0xf0450), // refresh
}
const WORD = {
  review: 'review',
  fix: 'fix CI',
  copy: 'copy',
  dismiss: 'dismiss',
  hide: 'hide',
  refresh: 'refresh',
}
const ICON_COLOR = {
  review: '#1f6feb',
  fix: '#b45309',
  copy: '#0f8b8d',
  dismiss: '#da3633',
  hide: '#6e7681',
  refresh: '#238636',
}
type IconName = keyof typeof ICON

// Terminals that draw clickable links (OSC 8). Where a terminal cannot, the
// engine writes the whole URL after the text, which wrecks the table. So
// links are drawn only where they work.
const LINK_TERMS = [
  'ghostty', 'iTerm.app', 'WezTerm', 'vscode', 'kitty', 'Hyper', 'WarpTerminal',
  'rio', 'alacritty', 'contour', 'foot', 'tabby',
]
const hasLinks = async ($: EngineInterface, mode: string): Promise<boolean> => {
  if (mode === 'on') return true
  if (mode === 'off') return false
  const program = (await $.env.get('TERM_PROGRAM')) ?? ''
  const term = (await $.env.get('TERM')) ?? ''
  const vte = (await $.env.get('VTE_VERSION')) ?? ''
  const wt = (await $.env.get('WT_SESSION')) ?? ''
  return (
    LINK_TERMS.some(t => t.toLowerCase() === program.toLowerCase()) ||
    /kitty|alacritty|foot|wezterm/i.test(term) ||
    vte !== '' ||
    wt !== ''
  )
}

type Api = EngineInterface

const toStatus = (state: string, isDraft: boolean): string => {
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  if (state === 'OPEN') return isDraft ? 'draft' : 'open'
  return 'unknown'
}

// Merge column: can this PR merge now? Shown for open and draft PRs only.
// label, symbol, color. Symbols differ, so it reads without color.
const MERGE_VIEW: Record<string, [string, string, string]> = {
  ready: ['ready', '✔', '#238636'],
  conflicts: ['conflicts', '✖', '#da3633'],
  checks: ['checks failing', '✖', '#da3633'],
  behind: ['behind base', '↓', '#9e6a03'],
  blocked: ['blocked', '■', '#9e6a03'],
  draft: ['draft', '○', '#6e7681'],
  checking: ['checking', '…', '#6e7681'],
}
// label with symbol, color
const CI_VIEW: Record<string, [string, string]> = {
  failing: ['✖ failing', '#f85149'],
  running: ['… running', '#d29922'],
  passing: ['✔ passing', '#3fb950'],
}
const REVIEW_VIEW: Record<string, [string, string]> = {
  approved: ['approved', '#3fb950'],
  changes: ['changes requested', '#f85149'],
  needed: ['review needed', '#d29922'],
}

type View = {
  state: string
  isDraft: boolean
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string
  author?: { login?: string }
  // A CheckRun has status and conclusion; a StatusContext has state.
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[]
}

// CI column: failing beats running, and running beats passing.
const FAILED_CONCLUSIONS = ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']
const toCi = (v: View): string => {
  if (v.state !== 'OPEN') return ''
  const checks = v.statusCheckRollup ?? []
  if (checks.length === 0) return ''
  const isFailing = checks.some(
    c =>
      FAILED_CONCLUSIONS.includes(c.conclusion ?? '') ||
      c.state === 'FAILURE' ||
      c.state === 'ERROR',
  )
  if (isFailing) return 'failing'
  const isRunning = checks.some(
    c =>
      (c.status !== undefined && c.status !== 'COMPLETED') ||
      c.state === 'PENDING' ||
      c.state === 'EXPECTED',
  )
  return isRunning ? 'running' : 'passing'
}

const toMerge = (v: View): string => {
  if (v.state !== 'OPEN') return ''
  if (v.mergeable === 'CONFLICTING' || v.mergeStateStatus === 'DIRTY') {
    return 'conflicts'
  }
  if (v.isDraft || v.mergeStateStatus === 'DRAFT') return 'draft'
  switch (v.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return 'ready'
    case 'UNSTABLE':
      return 'checks'
    case 'BEHIND':
      return 'behind'
    case 'BLOCKED':
      return 'blocked'
    default:
      return 'checking'
  }
}

const toReview = (v: View): string => {
  if (v.state !== 'OPEN') return ''
  if (v.reviewDecision === 'APPROVED') return 'approved'
  if (v.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  if (v.reviewDecision === 'REVIEW_REQUIRED') return 'needed'
  return ''
}

type Fresh = {
  status: string
  merge: string
  review: string
  ci: string
  mine: string
  unresolved: number
}

const THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}'
const PR_PARTS = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/

// Count the review threads still unresolved. -1 when it cannot be read.
// Reads the first 100 threads: a PR with more shows 100.
const fetchUnresolved = async ($: Api, url: string): Promise<number> => {
  const parts = PR_PARTS.exec(url)
  if (parts === null) return -1
  const [, host = '', owner = '', name = '', num = ''] = parts
  try {
    const out = await $.process.run(
      [
        'gh', 'api', 'graphql', '--hostname', host,
        '-f', `query=${THREADS_QUERY}`,
        '-F', `owner=${owner}`,
        '-F', `name=${name}`,
        '-F', `number=${num}`,
      ],
      { timeoutMs: 20_000 },
    )
    if (out.exitCode !== 0) return -1
    const data = JSON.parse(out.stdout) as {
      data?: {
        repository?: {
          pullRequest?: { reviewThreads?: { nodes?: { isResolved: boolean }[] } }
        }
      }
    }
    const nodes = data.data?.repository?.pullRequest?.reviewThreads?.nodes
    return nodes === undefined ? -1 : nodes.filter(n => !n.isResolved).length
  } catch {
    return -1
  }
}

// The login `gh` is signed in as, per host. Cached once read.
const viewers = new Map<string, string>()
const viewerOf = async ($: Api, url: string): Promise<string> => {
  const parts = PR_PARTS.exec(url)
  if (parts === null) return ''
  const host = parts[1] ?? ''
  const known = viewers.get(host)
  if (known !== undefined) return known
  try {
    const out = await $.process.run(
      ['gh', 'api', 'user', '--hostname', host, '--jq', '.login'],
      { timeoutMs: 20_000 },
    )
    const login = out.exitCode === 0 ? out.stdout.trim() : ''
    if (login !== '') viewers.set(host, login)
    return login
  } catch {
    return ''
  }
}

// yes = signed-in user wrote it, no = someone else did, '' = not known.
const toMine = (author: string, viewer: string): string =>
  author === '' || viewer === ''
    ? ''
    : author.toLowerCase() === viewer.toLowerCase()
      ? 'yes'
      : 'no'

// What `gh` says when the number is an issue, or nothing at all. GitHub opens
// /pull/N as /issues/N for an issue, so such a link must not be tracked.
const NOT_A_PR = /could not resolve to a pullrequest|no pull requests? found|not a pull request/i
const NOT_PR = 'not-pr'

const viewPr = async (
  $: Api,
  url: string,
  fields: string,
): Promise<View | typeof NOT_PR | { error: string }> => {
  const out = await $.process.run(
    ['gh', 'pr', 'view', url, '--json', fields],
    { timeoutMs: 20_000 },
  )
  if (out.exitCode !== 0) {
    if (NOT_A_PR.test(out.stderr)) return NOT_PR
    const reason = out.stderr.trim().split('\n')[0] ?? ''
    return { error: reason === '' ? `gh exited ${out.exitCode}` : reason }
  }
  return JSON.parse(out.stdout) as View
}

const isFailed = (v: unknown): v is { error: string } =>
  typeof v === 'object' && v !== null && 'error' in v

// Ask `gh` for the state of one PR. Returns the new values, or undefined.
// Falls back to fewer fields for a host that lacks the merge fields.
const fetchStatus = async (
  $: Api,
  url: string,
): Promise<Fresh | typeof NOT_PR | { error: string }> => {
  try {
    const fields = 'state,isDraft,author,mergeable,mergeStateStatus,reviewDecision'
    let data = await viewPr($, url, `${fields},statusCheckRollup`)
    if (isFailed(data)) data = await viewPr($, url, fields)
    if (isFailed(data)) data = await viewPr($, url, 'state,isDraft,author')
    if (isFailed(data) || data === NOT_PR) return data
    return {
      status: toStatus(data.state, data.isDraft),
      merge: toMerge(data),
      review: toReview(data),
      ci: toCi(data),
      mine: toMine(data.author?.login ?? '', await viewerOf($, url)),
      unresolved: data.state === 'OPEN' ? await fetchUnresolved($, url) : -1,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// Read every open PR again. A manual refresh says what happened, and any
// refresh says so when a PR could not be read, so old numbers are never passed
// off as fresh.
const refreshAll = async ($: Api, isManual = false): Promise<void> => {
  const list = await read($, prs)
  const live = list.filter(p => p.status !== 'merged' && p.status !== 'closed')
  const found = await Promise.all(
    live.map(async p => [p.url, await fetchStatus($, p.url)] as const),
  )
  const next = new Map(found)
  await update($, prs, all =>
    all
      // An issue that was taken for a PR: drop it.
      .filter(p => next.get(p.url) !== NOT_PR)
      .map(p => {
        const fresh = next.get(p.url)
        return fresh === undefined || fresh === NOT_PR || isFailed(fresh)
          ? p
          : { ...p, ...fresh }
      }),
  )
  const failed = found.flatMap(([url, r]) => (isFailed(r) ? [{ url, why: r.error }] : []))
  if (failed.length > 0) {
    const first = failed[0]
    const name = first === undefined ? '' : first.url.replace(/^https?:\/\/[^/]+\//, '')
    await update($, notice, () =>
      `Could not refresh ${failed.length} of ${live.length} PR(s). Numbers shown may be old. ${name}: ${first?.why ?? ''}`,
    )
  } else if (isManual) {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
    await update($, notice, () => `Refreshed ${live.length} PR(s) at ${time}.`)
  }
}

// Status is `unknown` until the first `gh pr view` answers.
const mkPr = (host: string, repo: string, num: number): Pr => ({
  url: `https://${host}/${repo}/pull/${num}`,
  repo,
  num,
  status: 'unknown',
  merge: 'checking',
  review: '',
  ci: '',
  mine: '',
  unresolved: -1,
})

// The host of the PRs already tracked, for a PR named without a host.
const hostOf = async ($: Api): Promise<string> => {
  const first = (await read($, prs))[0]
  const m = first === undefined ? null : /^https?:\/\/([^/]+)\//.exec(first.url)
  return m?.[1] ?? 'github.com'
}

// PRs named in text: a PR link, or an API path such as repos/o/r/pulls/12.
const findPrs = (text: string, fallbackHost: string): Pr[] => {
  const found: Pr[] = []
  let host = fallbackHost
  for (const m of text.matchAll(PR_URL)) {
    host = m[1] ?? host
    found.push(mkPr(host, m[2] ?? '', Number(m[3])))
  }
  const api = API_HOST.exec(text)
  const apiHost = api === null ? undefined : (api[1] ?? api[2])
  for (const m of text.matchAll(API_PR)) {
    found.push(mkPr(apiHost ?? host, `${m[1]}/${m[2]}`, Number(m[3])))
  }
  return found
}

// `owner/name` or `host/owner/name`, as gh's --repo flag takes it.
const fromRepoSpec = (spec: string, host: string, num: string): Pr[] => {
  const parts = spec.replace(/^["']|["']$/g, '').split('/')
  if (parts.length === 2) return [mkPr(host, parts.join('/'), Number(num))]
  if (parts.length === 3) {
    return [mkPr(parts[0] ?? '', `${parts[1]}/${parts[2]}`, Number(num))]
  }
  return []
}

// PRs a gh command names by number with --repo: gh pr view 12 --repo o/r
const findCommandPrs = (command: string, host: string): Pr[] => {
  const found: Pr[] = []
  for (const m of command.matchAll(CMD_NUM_FIRST)) {
    const flag = REPO_FLAG.exec(m[2] ?? '')
    if (flag !== null) {
      found.push(...fromRepoSpec(flag[1] ?? '', host, m[1] ?? ''))
    }
  }
  for (const m of command.matchAll(CMD_REPO_FIRST)) {
    found.push(...fromRepoSpec(m[1] ?? '', host, m[2] ?? ''))
  }
  return found
}

// A `gh pr` command that acts on a PR. With no PR named, it acts on the PR of
// the current branch, and prints that PR's link.
const GH_PR_CMD =
  /\bgh\s+pr\s+(?:create|view|checks|checkout|merge|close|reopen|ready|review|edit|comment)\b/

// The PRs one Bash command used: the ones it names, or, for a gh pr command
// that names none, the first link it prints (a create prints the new PR).
// A link deeper in the output is not used: it may be any PR it mentions.
const usedPrs = (command: string, output: string, host: string): Pr[] => {
  if (LISTS_PRS.test(command)) return []
  const named = [...findPrs(command, host), ...findCommandPrs(command, host)]
  if (named.length > 0 || !GH_PR_CMD.test(command)) return named
  return findPrs(output, host).slice(0, 1)
}

// PRs this session used or was asked about: what its Bash commands named or
// created, and the links in what the person wrote. Not what Claude wrote, not
// other output, not what connected servers returned.
const scanMessages = (
  messages: readonly SessionMessage[],
  host: string,
): Pr[] => {
  const found: Pr[] = []
  const results = new Map<string, string>()
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, result.text)
    }
  }
  for (const message of messages) {
    // A person's message holds their own text and tool results. Only the text.
    if (message.role === 'user') found.push(...findPrs(message.text, host))
    for (const use of message.toolUses) {
      if (use.tool !== 'Bash' || typeof use.input.command !== 'string') continue
      const output = use.text ?? results.get(use.tool_use_id) ?? ''
      found.push(...usedPrs(use.input.command, output, host))
    }
  }
  return found
}

// Add PRs not tracked yet. Returns how many were added.
const addPrs = async ($: Api, found: Pr[]): Promise<number> => {
  if (found.length === 0) return 0
  let added = 0
  await update($, prs, all => {
    const known = new Set(all.map(p => p.url))
    const fresh: Pr[] = []
    for (const pr of found) {
      if (known.has(pr.url)) continue
      known.add(pr.url)
      fresh.push(pr)
    }
    added = fresh.length
    return [...all, ...fresh].slice(-MAX_PRS)
  })
  return added
}

// Scan this session's messages, and its subagents', for PRs. Adds the new
// ones. Returns how many were added.
const backfill = async ($: Api): Promise<number> => {
  const host = await hostOf($)
  const found: Pr[] = []
  try {
    found.push(...scanMessages(await $.session.messages(), host))
  } catch {
    // No transcript to read: keep what is tracked.
  }
  try {
    for (const agent of await $.agent.list()) {
      const sub = await $.session.messages({ agentId: agent.id })
      if (Array.isArray(sub)) found.push(...scanMessages(sub, host))
    }
  } catch {
    // An agent's messages cannot be read: skip the rest.
  }
  return addPrs($, found)
}

// Skill names from a setting: a list, or one string split at commas and spaces.
// "/ci-fix" and "ci-fix" are the same. Repeats are dropped.
const parseSkills = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,\s]+/)
  const names = raw.map(v => String(v).trim().replace(/^\//, '')).filter(v => v !== '')
  return [...new Set(names)]
}

// Messages that start this way are problems, drawn in red.
const PROBLEMS = ['No skill set', 'Not a valid skill name', 'Not sent', 'Could not refresh']

// A skill name: letters, digits, dash, underscore, colon (plugin:skill).
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/

export const register: Register = (on, options) => {
  // The skill the person set to fix CI: "ci-fix" or "/ci-fix". None = not set.
  const fixSkills = parseSkills(options.fixSkill).slice(0, 1)
  // The skills that review a PR, in the order the person listed them.
  const reviewSkills = parseSkills(options.reviewSkills)
  // Icons (Material, from a Nerd Font) or plain words on the buttons.
  const useWords = String(options.iconStyle ?? 'icons').trim().toLowerCase() === 'words'
  const LABEL = useWords ? WORD : ICON
  const SLOT = useWords ? SLOT_WORDS : SLOT_ICONS
  const ACTIONS_W = slotsWidth(SLOT)
  // auto (default): links where the terminal draws them. on / off to force.
  const linkMode = String(options.links ?? 'auto').trim().toLowerCase()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: 'Show PRs created in this session, with status',
    })
    $.clock.every(REFRESH_MS, () => {
      void refreshAll($)
    })
    void backfill($)

    return next(e)
  })

  // /prs shows the band above the prompt and refreshes it. /prs hide hides it.
  on('command.run', { command: 'prs' }, async ($, e) => {
    if (e.args.trim() === 'hide') {
      await update($, isShown, () => false)
      return { text: 'PR band hidden. Type /prs to show it.' }
    }
    await update($, isShown, () => true)
    await update($, dismissed, () => [])
    await update($, filter, () => DEFAULT_FILTER)
    await update($, attn, () => '')
    await update($, onlyMine, () => true)

    const added = await backfill($)
    void refreshAll($)
    const total = (await read($, prs)).length

    return {
      text: `PR band shown. ${total} PR${total === 1 ? '' : 's'} tracked` +
        (added > 0 ? ` (${added} found in earlier messages).` : '.'),
    }
  })

  // A PR link the person types or pastes is a PR they ask about.
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta !== true && typeof e.text === 'string') {
      const found = findPrs(e.text, await hostOf($))
      if ((await addPrs($, found)) > 0) {
        await update($, isShown, () => true)
        void refreshAll($)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Catch the PRs a Bash command uses, in the main
  // chat and in subagents. Refresh the list after a push or a PR command,
  // since those change a PR's state.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    if (e.tool !== 'Bash') return ran
    const command = e.command

    const host = await hostOf($)
    const found = usedPrs(command, ran.text ?? '', host)
    if ((await addPrs($, found)) > 0) {
      await update($, isShown, () => true)
      void refreshAll($)
    }
    if (CHANGES_PR.test(command)) {
      void refreshAll($)
      // GitHub needs a little time to recompute checks and merge state.
      for (const ms of LATE_REFRESH_MS) {
        $.clock.after(ms, () => {
          void refreshAll($)
        })
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const linksOn = await hasLinks($, linkMode)
    // A link where the terminal draws it, else the text alone.
    const link = (href: string, node: RenderChildren) =>
      linksOn ? <Link href={href}>{node}</Link> : node
    const all = await read($, prs)
    const away = await read($, dismissed)
    const notAway = all.filter(p => !away.includes(p.url))
    const hiddenCount = all.length - notAway.length
    const mineOnly = await read($, onlyMine)
    const notMine = notAway.filter(p => p.mine === 'no').length
    const list = mineOnly ? notAway.filter(p => p.mine !== 'no') : notAway
    const counts = new Map<string, number>()
    for (const p of list) counts.set(p.status, (counts.get(p.status) ?? 0) + 1)

    // Hidden: one colored line says there is a panel, and how to open it.
    if (!(await read($, isShown))) {
      if (list.length === 0) return next(e)

      return (
        <Button key="expand" onPress={() => update($, isShown, () => true)}>
          <Text color={REPO_COLOR} bold>
            {'▸ Session PRs  '}
          </Text>
          {STATUS_ORDER.filter(s => (counts.get(s) ?? 0) > 0).map(s => (
            <Text color={STATUS_COLOR[s]} bold>
              {`${STATUS_ICON[s]} ${counts.get(s)} ${s}  `}
            </Text>
          ))}
          <Text color={NUM_COLOR}>click here or type /prs to expand</Text>
        </Button>
      )
    }

    const picked = await read($, filter)
    // A filter with no PRs left falls back to all.
    const active = (counts.get(picked) ?? 0) > 0 ? picked : 'all'
    const byStatus =
      active === 'all' ? list : list.filter(p => p.status === active)
    // Counts for the attention chips are over what the status filter leaves.
    const attnCounts = new Map(
      ATTN_ORDER.map(k => [k, byStatus.filter(attnTest(k)).length] as const),
    )
    const pickedAttn = await read($, attn)
    const activeAttn = (attnCounts.get(pickedAttn) ?? 0) > 0 ? pickedAttn : ''
    const rows =
      activeAttn === '' ? byStatus : byStatus.filter(attnTest(activeAttn))
    const mergedCount = counts.get('merged') ?? 0
    // The width and height the band has. The table follows them: each column
    // is as wide as its widest cell, with room between. When the band is too
    // narrow the loose gap tightens, then the flexible columns shrink, then
    // each PR is stacked in two lines.
    const cols = Math.max(30, e.props.bodyColumns)
    const inner = cols - 2 // inside the table's border
    const need: Record<Column, number> = {} as Record<Column, number>
    for (const c of COLUMNS) need[c] = HEAD[c].length
    for (const pr of rows) {
      const bump = (c: Column, n: number) => {
        need[c] = Math.max(need[c], n)
      }
      bump('repo', pr.repo.length)
      bump('num', `#${pr.num}`.length)
      bump('status', pr.status.length + 4)
      bump('merge', (MERGE_VIEW[pr.merge]?.[0].length ?? 0) + 4)
      bump('ci', CI_VIEW[pr.ci]?.[0].length ?? 0)
      bump('review', REVIEW_VIEW[pr.review]?.[0].length ?? 0)
      bump('comments', pr.unresolved > 0 ? `✎ ${pr.unresolved} open`.length : 6)
    }
    const widths = { ...need }
    const sumOf = () => COLUMNS.reduce((n, c) => n + widths[c], 0) + ACTIONS_W
    let gap = 2
    if (sumOf() + gap * 7 > inner) gap = 1
    const excess = sumOf() + gap * 7 - inner
    const flexKeys = ['repo', 'merge', 'review'] as const
    const give = (k: (typeof flexKeys)[number]) => widths[k] - FLEX_MIN[k]
    const room = flexKeys.reduce((n, k) => n + Math.max(0, give(k)), 0)
    const isTable = excess <= room
    if (excess > 0 && isTable) {
      let left = excess
      for (const k of flexKeys) {
        const cut = Math.min(Math.max(0, give(k)), Math.ceil((excess * Math.max(0, give(k))) / room))
        widths[k] -= Math.min(cut, left)
        left -= Math.min(cut, left)
      }
    }
    const repoW = isTable
      ? widths.repo
      : Math.max(8, inner - 6 - 10 - ACTIONS_W - 3)
    const tableW = sumOf() + gap * 7

    // Lines a PR takes: text that is wider than its column wraps inside it.
    const lines = (n: number, w: number) => Math.max(1, Math.ceil(n / w))
    const rowHeight = (pr: Pr): number =>
      !isTable
        ? 2
        : Math.max(
            lines(pr.repo.length, widths.repo),
            lines((MERGE_VIEW[pr.merge]?.[0].length ?? 0) + 4, widths.merge),
            lines(REVIEW_VIEW[pr.review]?.[0].length ?? 0, widths.review),
          )
    // The engine counts rows it cannot fit as "n more" lines, not PRs. Fit the
    // tree to the band ourselves, and say how many PRs are not shown.
    const chromeRows =
      1 + // top buttons
      (notAway.length > 0 || list.length > 0 ? 1 : 0) + // Author and Show
      (list.length > 0 ? 3 : 0) + // Needs, table border
      (list.length > 0 && isTable ? 2 : 0) + // column heads, divider
      1 + // a filter row that wraps
      (hiddenCount > 0 && list.length > 0 ? 1 : 0) + // dismissed hint
      1 // "more PRs" line
    const budget = Math.max(2, e.props.maxRows - chromeRows)
    const shownRows: Pr[] = []
    let used = 0
    for (const pr of rows) {
      const h = rowHeight(pr)
      if (shownRows.length > 0 && used + h > budget) break
      shownRows.push(pr)
      used += h
    }
    const cutRows = rows.length - shownRows.length
    const msg = await read($, notice)
    // A message that says something is wrong shows in red. Others in green.
    const isProblem = PROBLEMS.some(w => msg.startsWith(w))

    // Ask Claude to run each skill on one PR, one after the other. Each is a
    // prompt of its own, sent once the one before it is done.
    const runSkills = async (pr: Pr, skills: string[], setting: string) => {
      if (skills.length === 0) {
        await update($, notice, () =>
          `No skill set. Open /plugin, pick session-prs, and set "${setting}".`,
        )
        return
      }
      const bad = skills.filter(k => !SKILL_NAME.test(k))
      if (bad.length > 0) {
        await update($, notice, () =>
          `Not a valid skill name: ${bad.join(', ')}. Use letters, digits, - _ and :.`,
        )
        return
      }
      // Send each as the person's own words, so it reads in this session as a
      // prompt they typed. When Claude is busy it waits its turn in the queue.
      const label = `${pr.repo}#${pr.num}`
      for (const k of skills) {
        const sent = await $.prompt.submit({ text: `/${k} ${pr.url}`, asUser: true })
        if (sent.drop !== undefined) {
          await update($, notice, () => `Not sent: /${k} on ${label}. ${String(sent.drop)}`)
          return
        }
      }
      await update($, notice, () =>
        `Sent ${skills.map(k => `/${k}`).join(', ')} on ${label} to this session.`,
      )
    }

    // One table cell. A fixed width that never shrinks: text wraps inside it.
    const cell = (width: number, node: RenderChildren) => (
      <Box width={width} flexShrink={0}>
        {node}
      </Box>
    )
    // What the symbols on the buttons mean, shown while there are no words.
    const icon = (name: IconName, text: string = LABEL[name]) => (
      <Text color="#ffffff" backgroundColor={ICON_COLOR[name]} bold>
        {` ${text} `}
      </Text>
    )

    // A filter chip. On: white text on the group's color. Off: plain, no color.
    const chip = (
      key: string,
      label: string,
      isOn: boolean,
      color: { on: string; off: string },
      onPress: () => unknown,
    ) => (
      <Button key={key} onPress={onPress}>
        <Text
          color={isOn ? '#ffffff' : undefined}
          backgroundColor={isOn ? color.on : undefined}
          bold={isOn}
        >
          {` ${label} `}
        </Text>
      </Button>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={2}>
          <Button key="hide" plain onPress={() => update($, isShown, () => false)}>
            {icon('hide')}
          </Button>
          <Button key="refresh" plain onPress={() => refreshAll($, true)}>
            {icon('refresh')}
          </Button>
          {mergedCount > 0 && (
            <Button
              key="dismiss-merged"
              plain
              onPress={() =>
                update($, dismissed, d => [
                  ...d,
                  ...all
                    .filter(p => p.status === 'merged' && !d.includes(p.url))
                    .map(p => p.url),
                ])
              }
            >
              {icon('dismiss', `${LABEL.dismiss} merged ${mergedCount}`)}
            </Button>
          )}
          <Text dimColor>Session PRs</Text>
          {msg !== '' && (
            <Text color={isProblem ? '#f85149' : '#3fb950'} bold>
              {msg}
            </Text>
          )}
        </Box>
        {(notAway.length > 0 || list.length > 0) && (
          <Box flexDirection="row" gap={1}>
            {notAway.length > 0 && (
              <Text color={AUTHOR_COLOR.off} bold>
                Author:
              </Text>
            )}
            {notAway.length > 0 &&
              chip(
                'author-mine',
                `mine ${notAway.length - notMine}`,
                mineOnly,
                AUTHOR_COLOR,
                () => update($, onlyMine, () => true),
              )}
            {notAway.length > 0 &&
              chip(
                'author-all',
                `everyone ${notAway.length}`,
                !mineOnly,
                AUTHOR_COLOR,
                () => update($, onlyMine, () => false),
              )}
            {list.length > 0 && <Text dimColor>│</Text>}
            {list.length > 0 && (
              <Text color={SHOW_COLOR.off} bold>
                Show:
              </Text>
            )}
            {list.length > 0 &&
              chip(
                'filter-all',
                `all ${list.length}`,
                active === 'all',
                SHOW_COLOR,
                () => update($, filter, () => 'all'),
              )}
            {STATUS_ORDER.filter(st => (counts.get(st) ?? 0) > 0).map(st =>
              chip(
                `filter-${st}`,
                `${STATUS_ICON[st]} ${st} ${counts.get(st)}`,
                active === st,
                SHOW_COLOR,
                () => update($, filter, () => st),
              ),
            )}
          </Box>
        )}
        {list.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Text color={NEEDS_COLOR.off} bold>
              Needs:
            </Text>
            {chip('attn-none', 'any', activeAttn === '', NEEDS_COLOR, () =>
              update($, attn, () => ''),
            )}
            {ATTN_ORDER.filter(k => (attnCounts.get(k) ?? 0) > 0).map(k =>
              chip(
                `attn-${k}`,
                `${ATTN[k]?.icon ?? ''} ${ATTN[k]?.label ?? k} ${attnCounts.get(k)}`,
                activeAttn === k,
                NEEDS_COLOR,
                () => update($, attn, () => k),
              ),
            )}
          </Box>
        )}
        {all.length === 0 && (
          <Text dimColor>No PRs created in this session yet.</Text>
        )}
        {notAway.length > 0 && list.length === 0 && (
          <Text dimColor>None of these PRs are yours. Press everyone to see them.</Text>
        )}
        {all.length > 0 && notAway.length === 0 && (
          <Text dimColor>All PRs dismissed. Type /prs to show them again.</Text>
        )}
        {list.length > 0 && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="gray"
            alignSelf="flex-start"
          >
            {isTable && (
              <Box flexDirection="row" gap={gap}>
                {COLUMNS.map(c => cell(widths[c], <Text dimColor>{HEAD[c]}</Text>))}
                {cell(ACTIONS_W, <Text dimColor>ACTIONS</Text>)}
              </Box>
            )}
            {isTable && <Text dimColor>{'─'.repeat(tableW)}</Text>}
            {shownRows.map(pr => {
              const merge = MERGE_VIEW[pr.merge]
              const ci = CI_VIEW[pr.ci]
              const review = REVIEW_VIEW[pr.review]
              const repoCell = cell(
                repoW,
                link(pr.url, <Text color={REPO_COLOR} bold>
                    {pr.repo}
                  </Text>),
              )
              const numCell = cell(
                widths.num,
                link(pr.url, <Text color={NUM_COLOR} bold underline>
                    {`#${pr.num}`}
                  </Text>),
              )
              const statusCell = cell(
                widths.status,
                link(pr.url, <Text
                    backgroundColor={STATUS_COLOR[pr.status] ?? UNKNOWN_COLOR}
                    color="#ffffff"
                    bold
                  >
                    {` ${STATUS_ICON[pr.status] ?? '?'} ${pr.status} `}
                  </Text>),
              )
              const mergeNode = merge ? (
                link(pr.url, <Text backgroundColor={merge[2]} color="#ffffff" bold>
                    {` ${merge[1]} ${merge[0]} `}
                  </Text>)
              ) : (
                <Text dimColor>-</Text>
              )
              const ciNode = ci ? (
                link(`${pr.url}/checks`, <Text color={ci[1]} bold>
                    {ci[0]}
                  </Text>)
              ) : (
                <Text dimColor>-</Text>
              )
              const reviewNode = review ? (
                <Text color={review[1]} bold>
                  {review[0]}
                </Text>
              ) : (
                <Text dimColor>-</Text>
              )
              const commentsNode =
                pr.unresolved > 0 ? (
                  link(pr.url, <Text color="#d29922" bold>
                      {`✎ ${pr.unresolved} open`}
                    </Text>)
                ) : pr.unresolved === 0 ? (
                  <Text color="#3fb950">✔ none</Text>
                ) : (
                  <Text dimColor>-</Text>
                )
              const buttons = (
                <Box flexDirection="row" gap={1} flexShrink={0} width={ACTIONS_W}>
                  {cell(
                    SLOT.review,
                    (pr.status === 'open' || pr.status === 'draft') && (
                      <Button
                        key={`review-${pr.url}`}
                        plain
                        onPress={() => runSkills(pr, reviewSkills, 'Review skills')}
                      >
                        {icon('review')}
                      </Button>
                    ),
                  )}
                  {cell(
                    SLOT.fix,
                    pr.ci === 'failing' && (
                      <Button
                        key={`fix-${pr.url}`}
                        plain
                        onPress={() => runSkills(pr, fixSkills, 'Fix-CI skill')}
                      >
                        {icon('fix')}
                      </Button>
                    ),
                  )}
                  {cell(
                    SLOT.copy,
                    <Button
                      key={`copy-${pr.url}`}
                      plain
                      onPress={async press => {
                        const out = await $.ui.copy({
                          text: pr.url,
                          surface: press.surface,
                        })
                        const label = `${pr.repo}#${pr.num}`
                        await update($, notice, () =>
                          out.isCopied
                            ? `Copied link to ${label}.`
                            : `Could not copy ${label}: ${out.reason}`,
                        )
                      }}
                    >
                      {icon('copy')}
                    </Button>,
                  )}
                  {cell(
                    SLOT.dismiss,
                    <Button
                      key={`dismiss-${pr.url}`}
                      plain
                      onPress={() => update($, dismissed, d => [...d, pr.url])}
                    >
                      {icon('dismiss')}
                    </Button>,
                  )}
                </Box>
              )

              // A band too narrow for a table: two lines for each PR.
              if (!isTable) {
                return (
                  <Box flexDirection="column">
                    <Box flexDirection="row" gap={1}>
                      {repoCell}
                      {numCell}
                      {statusCell}
                      {buttons}
                    </Box>
                    <Box flexDirection="row" flexWrap="wrap" gap={2} paddingLeft={2}>
                      {mergeNode}
                      {ciNode}
                      {reviewNode}
                      {commentsNode}
                    </Box>
                  </Box>
                )
              }
              return (
                <Box flexDirection="row" gap={gap}>
                  {repoCell}
                  {numCell}
                  {statusCell}
                  {cell(widths.merge, mergeNode)}
                  {cell(widths.ci, ciNode)}
                  {cell(widths.review, reviewNode)}
                  {cell(widths.comments, commentsNode)}
                  {buttons}
                </Box>
              )
            })}
          </Box>
        )}
        {cutRows > 0 && (
          <Text dimColor>
            {`${cutRows} more PR${cutRows === 1 ? '' : 's'} not shown. Use the filters to narrow the list.`}
          </Text>
        )}
        {hiddenCount > 0 && list.length > 0 && (
          <Text dimColor>
            {hiddenCount} dismissed. Type /prs to show all.
          </Text>
        )}
      </Box>
    )
  })
}
