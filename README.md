# git-issues

A Claude Code mod that keeps a pane beside the chat listing the open issues of the
current project: number, title and when each was last updated, newest first. Labels
show as toggles above the list; pressing one cycles it through include, exclude and
ignore, and `r` refreshes. Pressing an issue shows its description in the lower half of
the pane, cut to fit with an ellipsis; `m` (Show more) shows it whole, `x` (Close) or
pressing the issue again closes it. The list refreshes by itself every five minutes.

The forge is picked from the repository's default remote (the current branch's
upstream remote, else `origin`, else the first remote):

- **GitHub** (`github.com`): `gh issue list` when `gh` is installed and signed in;
  otherwise the GitHub REST API, using `GH_TOKEN` or `GITHUB_TOKEN` when set. A public
  repository needs no token; a private one needs `gh` or a token. Pull requests are
  left out.
- **Anything else**: `glab issue list`, so `glab` must be installed and signed in for
  GitLab projects, self-hosted ones included.

## Install

```
/plugin install git-issues --marketplace davideandres95/git-issues
```

Answer `y` to add the marketplace, then pick a scope.

## Use

- `/issues` opens the pane and refreshes it, keeping the current label filter.
- `/issues bug -wontfix` shows issues labelled `bug` and not `wontfix`.
- `/issues all` clears the filter.

## Limits

- GitHub Enterprise hosts are not recognised as GitHub; they go to `glab`.
- Without `gh`, GitHub issues come from one page of 100 items, pull requests
  included, so a repository with many open pull requests may show fewer issues.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT, see [LICENSE](LICENSE).
