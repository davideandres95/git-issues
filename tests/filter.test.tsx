import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'git-issues',
  component: 'Pane',
  requestId: 'git-issues',
  props: {
    title: 'Open issues',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const ISSUES = [
  { iid: 1, title: 'Tidy the loader', updated_at: '2026-10-20T10:00:00Z', labels: ['refactoring'] },
  { iid: 2, title: 'Rename helpers', updated_at: '2026-10-20T10:00:00Z', labels: ['refactoring', 'nice-to-have'] },
  { iid: 3, title: 'Fix the crash', updated_at: '2026-10-20T10:00:00Z', labels: ['bugfix'] },
]

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = (stderr: string) => ({ exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

const cmd = (args: string) => ({
  command: 'issues',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

function git(argv: readonly string[], url: string) {
  if (argv[1] === 'rev-parse') return ok('origin/master\n')
  if (argv[1] === 'remote' && argv[2] === 'get-url') return argv[3] === 'origin' ? ok(`${url}\n`) : fail('no such remote')
  if (argv[1] === 'remote') return ok('mirror\norigin\n')
  return fail(`unexpected git ${argv.join(' ')}`)
}

function gitlab(argv: readonly string[]) {
  if (argv[0] === 'git') return git(argv, 'git@gitlab.example.org:group/sub/project.git')
  if (argv[0] === 'glab') return ok(JSON.stringify(ISSUES))
  return fail(`unexpected ${argv[0]}`)
}

const GH_ISSUES = [
  { number: 7, title: 'Older issue', updatedAt: '2026-10-18T10:00:00Z', labels: [{ name: 'bug' }] },
  { number: 9, title: 'Newer issue', updatedAt: '2026-10-21T10:00:00Z', labels: [] },
]

const API_ISSUES = [
  { number: 4, title: 'A real issue', updated_at: '2026-10-21T10:00:00Z', labels: [{ name: 'enhancement' }] },
  { number: 5, title: 'A pull request', updated_at: '2026-10-22T10:00:00Z', labels: [], pull_request: {} },
]

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

function stubSession(on: Parameters<TestBody>[1]) {
  on('command.register', () => ({ value: { command: 'issues' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('a GitLab remote reads the issues through glab', async ($, on) => {
  stubSession(on)
  const ran: string[] = []
  on('process.run', (_, e) => {
    ran.push(e.argv[0] ?? '')
    return { value: gitlab(e.argv) }
  })
  await $.session.start(START)
  const out = await $.command.run(cmd(''))
  expect(out.text).toBe('3 open issues.')
  expect(ran.includes('glab')).toBe(true)
  expect(ran.includes('gh')).toBe(false)
})

test('a GitHub remote reads the issues through gh, newest first', async ($, on) => {
  stubSession(on)
  let repo = ''
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return { value: git(e.argv, 'git@github.com:octo/widgets.git') }
    if (e.argv[0] === 'gh') {
      repo = e.argv[e.argv.indexOf('-R') + 1] ?? ''
      return { value: ok(JSON.stringify(GH_ISSUES)) }
    }
    return { value: fail(`unexpected ${e.argv[0]}`) }
  })
  await $.session.start(START)
  const out = await $.command.run(cmd('bug'))
  expect(out.text).toBe('1 open issues with bug.')
  expect(repo).toBe('octo/widgets')

  await $.command.run(cmd('all'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /GitHub octo\/widgets/ })).toBeDefined()
  const rows = await ui.findAll({ type: 'Text', text: /^#\d+ / })
  expect(rows.map(r => r.text.slice(0, 2))).toEqual(['#9', '#7'])
  await ui.unmount()
})

test('without gh a GitHub remote falls back to the REST API and drops pull requests', async ($, on) => {
  stubSession(on)
  let asked = ''
  let auth: string | undefined
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return { value: git(e.argv, 'https://github.com/octo/widgets.git') }
    if (e.argv[0] === 'gh') return { deny: 'gh: command not found' }
    if (e.argv[0] === 'printenv') return { value: e.argv[1] === 'GITHUB_TOKEN' ? ok('t0ken\n') : fail('') }
    return { value: fail(`unexpected ${e.argv[0]}`) }
  })
  on('http.fetch', (_, e) => {
    asked = e.url
    auth = e.init?.headers?.Authorization
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(API_ISSUES) } }
  })
  await $.session.start(START)
  const out = await $.command.run(cmd(''))
  expect(out.text).toBe('1 open issues.')
  expect(asked.startsWith('https://api.github.com/repos/octo/widgets/issues?')).toBe(true)
  expect(auth).toBe('Bearer t0ken')
})

test('a GitHub error is reported under GitHub', async ($, on) => {
  stubSession(on)
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return { value: git(e.argv, 'ssh://git@github.com/octo/secret') }
    if (e.argv[0] === 'gh') return { deny: 'gh: command not found' }
    return { value: fail('') }
  })
  on('http.fetch', () => ({ value: { status: 404, ok: false, headers: {}, text: '{}' } }))
  await $.session.start(START)
  const out = await $.command.run(cmd(''))
  expect(out.text).toBe('GitHub issues: GitHub answered 404 for octo/secret (a private repository needs `gh auth login` or GH_TOKEN)')
})

test('label toggles include and exclude issues', async ($, on) => {
  on('command.register', () => ({ value: { command: 'issues' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', (_, e) => ({ value: gitlab(e.argv) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run(cmd('refactoring -nice-to-have'))
  expect(ran.text).toBe('1 open issues with refactoring, without nice-to-have.')

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run(cmd('all'))
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Fix the crash/ })).toBeDefined()

    await ui.press({ key: 'label:refactoring' }) // include
    expect(await ui.find({ type: 'Text', text: /Fix the crash/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Rename helpers/ })).toBeDefined()

    await ui.press({ key: 'label:nice-to-have' }) // include
    await ui.press({ key: 'label:nice-to-have' }) // exclude
    expect(await ui.find({ type: 'Text', text: /Rename helpers/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Tidy the loader/ })).toBeDefined()

    await ui.press({ key: 'Clear' })
    expect(await ui.find({ type: 'Text', text: /Fix the crash/ })).toBeDefined()
    await ui.unmount()
  }
})
