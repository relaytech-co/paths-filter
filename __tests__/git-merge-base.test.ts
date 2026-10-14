import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {getChanges, getChangesFromMergeBase} from '../src/git'

// These run real git against a local "origin", checked out the way actions/checkout leaves a pull
// request: a shallow clone of GitHub's merge commit, detached.

// Each test builds and clones a repository, which takes longer than Jest's default 5s on a slow disk
jest.setTimeout(30000)

let root: string
let origin: string
let clone: string
const startDir = process.cwd()

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    }
  }).trim()
}

// Commits one new file in origin and returns the commit
function commit(file: string): string {
  fs.writeFileSync(path.join(origin, file), file)
  git(origin, 'add', file)
  git(origin, 'commit', '-q', '-m', file)
  return git(origin, 'rev-parse', 'HEAD')
}

function commits(prefix: string, count: number): string[] {
  return Array.from({length: count}, (_, i) => commit(`${prefix}-${i + 1}`))
}

// GitHub's merge commit for a pull request of head into base, kept under refs/pull/1/merge
function mergeCommit(base: string, head: string): string {
  git(origin, 'checkout', '-q', '--detach', base)
  git(origin, 'merge', '-q', '--no-ff', '--no-edit', head)
  const merge = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'update-ref', 'refs/pull/1/merge', merge)
  git(origin, 'checkout', '-q', 'dev')
  return merge
}

// actions/checkout of a pull request: depth 1, the merge commit, detached
function checkoutPullRequest(): string {
  git(root, 'clone', '-q', '--no-checkout', '--depth=1', `file://${origin}`, clone)
  git(clone, 'fetch', '-q', '--depth=1', 'origin', 'refs/pull/1/merge')
  git(clone, 'checkout', '-q', '--detach', 'FETCH_HEAD')
  process.chdir(clone)
  return git(clone, 'rev-parse', 'HEAD')
}

function filenames(files: {filename: string}[]): string[] {
  return files.map(f => f.filename).sort()
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-filter-merge-base-'))
  origin = path.join(root, 'origin')
  clone = path.join(root, 'clone')
  fs.mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'dev')
})

afterEach(() => {
  process.chdir(startDir)
  fs.rmSync(root, {recursive: true, force: true})
})

describe('changes since the merge-base', () => {
  test('a pull request whose base moved on after GitHub merged it counts only its own changes', async () => {
    const dev = commits('dev', 25)
    git(origin, 'checkout', '-q', '-b', 'feature', dev[19])
    commit('feature')
    git(origin, 'checkout', '-q', 'dev')
    mergeCommit(dev[24], 'feature')
    commits('later', 5)
    const head = checkoutPullRequest()

    // Depth 2 is short of the merge-base, so the history has to be deepened to find it
    const files = await getChangesFromMergeBase('dev', head, 2)

    expect(filenames(files)).toEqual(['feature'])
    // Diffing dev's tip against the merge commit is what this replaces: it also lists dev's newer commits
    expect(filenames(await getChanges('dev', head))).toEqual(expect.arrayContaining(['later-1', 'later-5', 'feature']))
  })

  test('a pull request stacked on another counts every pull request in the stack against the trunk', async () => {
    const dev = commits('dev', 10)
    git(origin, 'checkout', '-q', '-b', 'parent', dev[4])
    commit('parent')
    git(origin, 'checkout', '-q', '-b', 'child')
    commit('child')
    git(origin, 'checkout', '-q', 'dev')
    mergeCommit('parent', 'child')
    commits('later', 3)
    const head = checkoutPullRequest()

    const files = await getChangesFromMergeBase('dev', head, 2)

    expect(filenames(files)).toEqual(['child', 'parent'])
  })

  test('a stale local base ref is refetched rather than used', async () => {
    const dev = commits('dev', 10)
    git(origin, 'checkout', '-q', '-b', 'feature', dev[7])
    commit('feature')
    git(origin, 'checkout', '-q', 'dev')
    // A complete clone, as on a runner that keeps .git between jobs, whose origin/dev is from an earlier job
    git(root, 'clone', '-q', `file://${origin}`, clone)
    git(clone, 'checkout', '-q', '--detach', 'origin/feature')
    git(clone, 'update-ref', 'refs/remotes/origin/dev', dev[2])
    process.chdir(clone)
    const head = git(clone, 'rev-parse', 'HEAD')

    const files = await getChangesFromMergeBase('dev', head, 2)

    expect(filenames(files)).toEqual(['feature'])
    expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('false')
  })

  test('a base given as a commit SHA is used as it is', async () => {
    const dev = commits('dev', 10)
    git(origin, 'checkout', '-q', '-b', 'feature', dev[5])
    commit('feature')
    git(origin, 'checkout', '-q', 'dev')
    mergeCommit(dev[9], 'feature')
    const head = checkoutPullRequest()

    const files = await getChangesFromMergeBase(dev[3], head, 2)

    expect(filenames(files)).toEqual(['dev-5', 'dev-6', 'dev-7', 'dev-8', 'dev-9', 'dev-10', 'feature'].sort())
  })

  test('without a merge-base the base is diffed directly', async () => {
    commits('dev', 3)
    git(origin, 'checkout', '-q', '--orphan', 'unrelated')
    git(origin, 'rm', '-q', '-rf', '.')
    commit('unrelated')
    git(origin, 'checkout', '-q', 'dev')
    git(origin, 'update-ref', 'refs/pull/1/merge', 'dev')
    const head = checkoutPullRequest()

    const files = await getChangesFromMergeBase('unrelated', head, 2)

    expect(filenames(files)).toEqual(['dev-1', 'dev-2', 'dev-3', 'unrelated'])
  })
})
