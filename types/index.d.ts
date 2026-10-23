export type Issue = { iid: number; title: string; updatedAt: string; labels: string[] }

/** Where the issues came from: the forge the default remote is hosted on, and the repository there. */
export type IssueSource = { forge: 'gitlab' | 'github'; repo?: string }

/** `source` is absent on a list stored before the mod read GitHub. */
export type IssueList = { issues: Issue[]; error?: string; fetchedAt?: string; source?: IssueSource }

/** Labels an issue must carry one of (none: no constraint) and labels it must not carry. */
export type LabelFilter = { include: string[]; exclude: string[] }

declare module 'claude-code' {
  interface PluginState {
    'git-issues': { list: IssueList; filter: LabelFilter }
  }
}
