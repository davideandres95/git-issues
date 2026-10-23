import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Issue, IssueList, IssuePreview, IssueSource, LabelFilter } from '../types'

const PANE = 'git-issues'
const REFRESH_MS = 5 * 60 * 1000
const NO_FILTER: LabelFilter = { include: [], exclude: [] }
const list = atom({ plugin: 'git-issues', key: 'list' } as const, { issues: [] } as IssueList)
const filter = atom({ plugin: 'git-issues', key: 'filter' } as const, NO_FILTER)
const NO_PREVIEW: IssuePreview = { isExpanded: false }
const preview = atom({ plugin: 'git-issues', key: 'preview' } as const, NO_PREVIEW)

type Fetched = { issues: Issue[] } | { error: string }

function run($: EngineInterface, argv: string[]) {
  return $.process
    .run(argv, { timeoutMs: 30_000 })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop() ?? ''
}

// The default remote: the current branch's upstream remote, else `origin`, else the first one.
async function defaultRemoteUrl($: EngineInterface): Promise<string | undefined> {
  const upstream = await run($, ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const remotes = await run($, ['git', 'remote'])
  const names = remotes.exitCode === 0 ? remotes.stdout.split('\n').map(s => s.trim()).filter(Boolean) : []
  const tracked = upstream.exitCode === 0 ? names.find(n => upstream.stdout.trim().startsWith(`${n}/`)) : undefined
  const name = tracked ?? (names.includes('origin') ? 'origin' : names[0])
  if (!name) return undefined
  const url = await run($, ['git', 'remote', 'get-url', name])
  return url.exitCode === 0 ? url.stdout.trim() : undefined
}

// `git@host:owner/repo.git`, `ssh://git@host:22/owner/repo.git` and `https://host/owner/repo`.
function parseRemote(url: string): { host: string; path: string } | undefined {
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url)
  const full = /^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url)
  const m = full ?? scp
  return m?.[1] && m[2] ? { host: m[1].toLowerCase(), path: m[2] } : undefined
}

function isGitHub(host: string): boolean {
  return host === 'github.com' || host === 'ssh.github.com' || host === 'www.github.com'
}

async function fromGitLab($: EngineInterface): Promise<Fetched> {
  const ran = await run($, ['glab', 'issue', 'list', '--opened', '-O', 'json', '-P', '100', '--order', 'updated_at'])
  if (ran.exitCode !== 0) return { error: lastLine(ran.stderr) || `glab exited ${ran.exitCode}` }
  try {
    const raw = JSON.parse(ran.stdout) as {
      iid: number
      title: string
      updated_at: string
      labels?: string[]
      description?: string | null
    }[]
    return {
      issues: raw.map(i => ({
        iid: i.iid,
        title: i.title,
        updatedAt: i.updated_at,
        labels: i.labels ?? [],
        description: i.description ?? '',
      })),
    }
  } catch {
    return { error: 'could not parse glab output' }
  }
}

// `gh` when it is installed and signed in; otherwise the REST API, with GH_TOKEN or GITHUB_TOKEN
// when set (a public repository needs neither). The REST list carries pull requests too.
async function fromGitHub($: EngineInterface, repo: string): Promise<Fetched> {
  const gh = await run($, [
    'gh', 'issue', 'list', '-R', repo, '--state', 'open', '--limit', '100',
    '--json', 'number,title,updatedAt,labels,body',
  ])
  if (gh.exitCode === 0) {
    try {
      const raw = JSON.parse(gh.stdout) as {
        number: number
        title: string
        updatedAt: string
        labels?: { name: string }[]
        body?: string | null
      }[]
      return {
        issues: raw.map(i => ({
          iid: i.number,
          title: i.title,
          updatedAt: i.updatedAt,
          labels: (i.labels ?? []).map(l => l.name),
          description: i.body ?? '',
        })),
      }
    } catch {
      return { error: 'could not parse gh output' }
    }
  }

  let token = ''
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const env = await run($, ['printenv', name])
    if (env.exitCode === 0 && env.stdout.trim()) {
      token = env.stdout.trim()
      break
    }
  }
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'claude-code-git-issues',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=100&sort=updated&direction=desc`
  const res = await $.http.fetch(url, { headers }).catch((err: unknown) => ({ ok: false, status: 0, text: String(err) }))
  if (!res.ok) {
    const hint = token ? '' : ' (a private repository needs `gh auth login` or GH_TOKEN)'
    return { error: res.status ? `GitHub answered ${res.status} for ${repo}${hint}` : lastLine(res.text) }
  }
  try {
    const raw = JSON.parse(res.text) as {
      number: number
      title: string
      updated_at: string
      labels?: ({ name: string } | string)[]
      body?: string | null
      pull_request?: unknown
    }[]
    return {
      issues: raw
        .filter(i => i.pull_request === undefined)
        .map(i => ({
          iid: i.number,
          title: i.title,
          updatedAt: i.updated_at,
          labels: (i.labels ?? []).map(l => (typeof l === 'string' ? l : l.name)),
          description: i.body ?? '',
        })),
    }
  } catch {
    return { error: 'could not parse the GitHub answer' }
  }
}

async function refresh($: EngineInterface) {
  const url = await defaultRemoteUrl($)
  const remote = url ? parseRemote(url) : undefined
  const source: IssueSource =
    remote && isGitHub(remote.host) ? { forge: 'github', repo: remote.path } : { forge: 'gitlab', repo: remote?.path }
  const got = source.forge === 'github' && source.repo ? await fromGitHub($, source.repo) : await fromGitLab($)
  const fetchedAt = new Date().toISOString()
  if ('error' in got) {
    await update($, list, old => ({ ...old, error: got.error, fetchedAt, source }))
    return
  }
  // Most recently updated first, whichever forge answered.
  const issues = [...got.issues].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  await update($, list, () => ({ issues, fetchedAt, source }))
}

function forgeName(source?: IssueSource): string {
  return source?.forge === 'github' ? 'GitHub' : 'GitLab'
}

function labelsOf(issues: Issue[]): string[] {
  return [...new Set(issues.flatMap(i => i.labels))].sort((a, b) => a.localeCompare(b))
}

// Shown: carries at least one included label (when any is ticked) and no excluded label.
function matches(issue: Issue, { include, exclude }: LabelFilter): boolean {
  if (include.length > 0 && !include.some(l => issue.labels.includes(l))) return false
  return !exclude.some(l => issue.labels.includes(l))
}

// One press moves a label along: ignored -> included -> excluded -> ignored.
function cycle({ include, exclude }: LabelFilter, name: string): LabelFilter {
  if (include.includes(name)) {
    return { include: include.filter(l => l !== name), exclude: [...exclude, name] }
  }
  if (exclude.includes(name)) return { include, exclude: exclude.filter(l => l !== name) }
  return { include: [...include, name], exclude }
}

function describe({ include, exclude }: LabelFilter): string {
  const parts = [
    include.length > 0 && `with ${include.join(' or ')}`,
    exclude.length > 0 && `without ${exclude.join(', ')}`,
  ].filter(Boolean)
  return parts.length > 0 ? ` ${parts.join(', ')}` : ''
}

// Rows `text` takes at `columns` cells, a line at least one.
function rowsOf(line: string, columns: number): number {
  return Math.max(1, Math.ceil(line.length / columns))
}

// The text cut to `rows` rows of `columns` cells, ending in an ellipsis where it was cut.
function clip(text: string, rows: number, columns: number): { text: string; isCut: boolean } {
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n')
  const kept: string[] = []
  let left = rows
  for (const line of lines) {
    const need = rowsOf(line, columns)
    if (need <= left) {
      kept.push(line)
      left -= need
      continue
    }
    if (left > 0) {
      kept.push(`${line.slice(0, left * columns - 1).trimEnd()}…`)
    } else {
      // No row left: the ellipsis goes on the last kept line, in a cell of its own when one is free.
      const last = kept.pop() ?? ''
      kept.push(`${last.length % columns === 0 && last.length > 0 ? last.slice(0, -1) : last}…`)
    }
    return { text: kept.join('\n'), isCut: true }
  }
  return { text: kept.join('\n'), isCut: false }
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'issues',
      description: 'Show the open issues of this project (GitLab, or GitHub when the default remote is there) in a pane',
      argumentHint: '[label … -label … | all]',
    })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    void $.ui.open({ id: PANE, title: 'Open issues' })

    return next(e)
  })

  // `/issues` keeps the current filter, `/issues refactoring -nice-to-have` replaces it,
  // `/issues all` clears it.
  on('command.run', { command: 'issues' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Open issues' })
    await refresh($)
    const { issues, error, source } = await read($, list)
    if (error) return { text: `${forgeName(source)} issues: ${error}` }

    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (words.length === 1 && words[0]?.toLowerCase() === 'all') {
      await update($, filter, () => NO_FILTER)
    } else if (words.length > 0) {
      const known = labelsOf(issues)
      const next: LabelFilter = { include: [], exclude: [] }
      for (const word of words) {
        const isExcluded = word.startsWith('-')
        const name = isExcluded ? word.slice(1) : word
        const found = known.find(l => l.toLowerCase() === name.toLowerCase())
        if (!found) return { text: `No open issue has the label "${name}".` }
        ;(isExcluded ? next.exclude : next.include).push(found)
      }
      await update($, filter, () => next)
    }
    const active = await read($, filter)
    const shown = issues.filter(i => matches(i, active))

    return { text: `${shown.length} open issues${describe(active)}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { issues: all, error, fetchedAt, source } = await read($, list)
    const labels = labelsOf(all)
    const stored = await read($, filter)
    // Labels no open issue carries any more drop out of the filter.
    const active: LabelFilter = {
      include: stored.include.filter(l => labels.includes(l)),
      exclude: stored.exclude.filter(l => labels.includes(l)),
    }
    const isFiltered = active.include.length + active.exclude.length > 0
    const issues = all.filter(i => matches(i, active))
    const { iid: openIid, isExpanded } = await read($, preview)
    // The open issue stays shown while the filter hides it from the list; one that closed drops out.
    const open = all.find(i => i.iid === openIid)

    // Rows left for the list (and the preview) under the status row, the label toggles and an error.
    // Word wrap can take a row more than counted here; the pane then scrolls.
    const columns = Math.max(20, e.props.bodyColumns)
    const labelRows = labels.length > 0 ? rowsOf(labels.map(l => `[ ] ${l}  `).join(''), columns) : 0
    const room = Math.max(4, e.props.scroll.bodyRows - 1 - labelRows - (error ? 1 : 0))
    // With a preview open the list keeps the upper half, the preview the lower one.
    const listRows = open ? Math.max(2, Math.floor(room / 2)) : room
    const previewRows = room - listRows
    const fits = issues.length <= listRows
    const shownCount = fits ? issues.length : Math.max(1, listRows - 1)
    // Scrolled so the open issue stays in view.
    const at = open ? issues.indexOf(open) : -1
    const start = at >= shownCount ? at - shownCount + 1 : 0
    const shown = issues.slice(start, start + shownCount)

    const toggle = (iid: number) =>
      void update($, preview, p => (p.iid === iid ? NO_PREVIEW : { iid, isExpanded: false }))
    const close = () => void update($, preview, () => NO_PREVIEW)

    // The preview's rows: a rule, the title, the labels, the description and its Show more.
    const descriptionRows = Math.max(2, previewRows - 3 - (open && open.labels.length > 0 ? 1 : 0))
    const description = open?.description?.trim() ?? ''
    const clipped = isExpanded
      ? { text: description, isCut: false }
      : clip(description, descriptionRows, Math.max(10, columns - 2))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>
            {issues.length} open{isFiltered ? ` of ${all.length}` : ''}
            {source ? ` · ${forgeName(source)}${source.repo ? ` ${source.repo}` : ''}` : ''}
            {fetchedAt ? ` · fetched ${ago(fetchedAt)}` : ' · loading…'}{' '}
          </Text>
          <Button hotkey="r" onPress={() => void refresh($)}>
            Refresh
          </Button>
          {isFiltered && (
            <Button hotkey="c" onPress={() => void update($, filter, () => NO_FILTER)}>
              Clear
            </Button>
          )}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {labels.map(name => {
            const isIncluded = active.include.includes(name)
            const isExcluded = active.exclude.includes(name)
            return (
              <Button
                key={`label:${name}`}
                plain
                onPress={() => void update($, filter, f => cycle(f, name))}
              >
                {isIncluded ? (
                  <Text color="green">[✓]</Text>
                ) : isExcluded ? (
                  <Text color="red">[✗]</Text>
                ) : (
                  <Text dimColor>[ ]</Text>
                )}{' '}
                {name}
              </Button>
            )
          })}
        </Box>
        {error && <Text color="red">{error}</Text>}
        {shown.map(issue => (
          <Button key={`issue:${issue.iid}`} plain onPress={() => toggle(issue.iid)}>
            <Text wrap="truncate-end" inverse={issue.iid === openIid}>
              <Text bold>#{issue.iid}</Text> {issue.title} <Text dimColor>{ago(issue.updatedAt)}</Text>
            </Text>
          </Button>
        ))}
        {!fits && <Text dimColor>… {issues.length - shown.length} more</Text>}
        {all.length > 0 && issues.length === 0 && <Text dimColor>No open issue matches the filter.</Text>}
        {open && (
          <Box flexDirection="column">
            <Text dimColor>{'─'.repeat(columns)}</Text>
            <Box flexDirection="row" columnGap={1}>
              <Box flexGrow={1}>
                <Text bold wrap="truncate-end">
                  #{open.iid} {open.title}
                </Text>
              </Box>
              <Button key="close-preview" hotkey="x" onPress={close}>
                Close
              </Button>
            </Box>
            {open.labels.length > 0 && (
              <Text dimColor wrap="truncate-end">
                {open.labels.join(' · ')}
              </Text>
            )}
            {description ? <Text>{clipped.text}</Text> : <Text dimColor>No description.</Text>}
            {(clipped.isCut || isExpanded) && (
              <Button
                key="expand-preview"
                plain
                hotkey="m"
                onPress={() => void update($, preview, p => ({ ...p, isExpanded: !p.isExpanded }))}
              >
                {isExpanded ? 'Show less' : 'Show more'}
              </Button>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
