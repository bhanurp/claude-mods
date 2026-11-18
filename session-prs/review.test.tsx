import { expect, test } from 'claude-code/testing'

const PR = 'https://github.com/o/r/pull/5'

const BAND = {
  plugin: 'session-prs',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const OPTIONS = { reviewSkills: 'my-review, other:deep-review', fixSkill: 'auto-fix' }

type On = Parameters<Parameters<typeof test>[2]>[1]

// What sits beneath the mod: one open PR with failing CI, and the commands the
// engine lists. Records what the mod asks the engine to run or to say.
const engine = (on: On, listed: string[]) => {
  const ran: { command: string; args: string }[] = []
  const sent: string[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'prs' } }))
  on('env.get', () => ({ value: 'ghostty' }))
  on('clock.every', () => ({ value: () => {} }))
  on('command.list', () => ({
    value: listed.map(name => ({ name, description: '', source: 'user' })),
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('command.run', (_, e) => {
    ran.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = e.argv as string[]
    if (argv.includes('user')) return { value: { exitCode: 0, stdout: 'me\n', stderr: '' } }
    if (argv.includes('graphql')) {
      return { value: { exitCode: 0, stdout: '{"data":{}}', stderr: '' } }
    }
    const view = {
      state: 'OPEN',
      isDraft: false,
      author: { login: 'me' },
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNSTABLE',
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(view), stderr: '' } }
  })
  return { ran, sent, toasts }
}

test('a listed skill runs as a slash command with the PR link', { options: OPTIONS }, async ($, on) => {
  const { ran, toasts } = engine(on, ['my-review', 'other:deep-review', 'auto-fix'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: `gh pr view ${PR}` })
  const ui = await $.ui.mount(BAND)
  await $.command.run({ command: 'prs', args: '' })

  await ui.press({ key: `review-${PR}` })
  expect(ran.filter(r => r.command !== 'prs')).toEqual([
    { command: 'my-review', args: PR },
    { command: 'other:deep-review', args: PR },
  ])

  ran.length = 0
  await ui.press({ key: `fix-${PR}` })
  expect(ran).toEqual([{ command: 'auto-fix', args: PR }])
  expect(toasts.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('a skill the engine does not list is asked of Claude in words', { options: OPTIONS }, async ($, on) => {
  const { ran, sent } = engine(on, ['something-else'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: `gh pr view ${PR}` })
  const ui = await $.ui.mount(BAND)
  await $.command.run({ command: 'prs', args: '' })
  ran.length = 0

  await ui.press({ key: `fix-${PR}` })
  expect(ran).toEqual([])
  expect(sent).toEqual([`Use the auto-fix skill on this pull request: ${PR}`])
  await ui.unmount()
})
