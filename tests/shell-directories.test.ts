import { describe, expect, it } from 'vitest';
import { shellDirectories } from '../src/providers/shared/shell-directories.js';

const CWD = '/work/agent-watch-docs';
const HOME = '/home/dev';

function dirs(command: string): string[] {
  return shellDirectories(command, CWD, HOME);
}

describe('the directories a shell command names', () => {
  it.each([
    ['cd ../core-AWT-1 && git status', ['/work/core-AWT-1']],
    ['cd agent-watch-core && npm test', ['/work/agent-watch-docs/agent-watch-core']],
    ['pushd /repo/x; make', ['/repo/x']],
    ['git -C /repo/wt commit -qm "x"', ['/repo/wt']],
    ['git -c core.pager=cat -C ../wt log', ['/work/wt']],
    ['git --work-tree=/repo/a --git-dir=/repo/a/.git status', ['/repo/a', '/repo/a/.git']],
    ['git worktree add -b AWT-9-x ../.worktrees/core-AWT-9 origin/main', ['/work/.worktrees/core-AWT-9']],
    ['git worktree add --force ../wt main', ['/work/wt']],
    ['git worktree add --detach --reason "why not" ../wt HEAD', ['/work/wt']],
    ['git worktree add -B AWT-9-x --no-checkout ../wt', ['/work/wt']],
    ['cat "/repo/with space/file.ts"', ['/repo/with space/file.ts']],
    ["ls '/repo/quoted'", ['/repo/quoted']],
    ['ls /repo/bare/src', ['/repo/bare/src']],
    ['ls ~/dev/core', ['/home/dev/dev/core']],
    ['ls $HOME/dev/core ${HOME}/dev/edge', ['/home/dev/dev/core', '/home/dev/dev/edge']],
    ['node ./scripts/run.mjs', ['/work/agent-watch-docs/scripts/run.mjs']],
    ['cat ../other/README.md', ['/work/other/README.md']]
  ])('%s', (command, expected) => {
    expect(dirs(command)).toEqual(expected);
  });

  it('resolves relative paths after a cd against the directory it moved to', () => {
    expect(dirs('cd /repo/wt && git add ./src/a.ts')).toEqual(['/repo/wt', '/repo/wt/src/a.ts']);
  });

  it('reads paths inside a pipe and a redirection', () => {
    expect(dirs('grep -r x /repo/a | tee /repo/b/out.txt > /repo/c/log')).toEqual(['/repo/a', '/repo/b/out.txt', '/repo/c/log']);
  });

  it('ignores a heredoc body: it is file content, not the command', () => {
    const command = ["cat > /repo/a/notes.md <<'EOF'", 'cd /secret/elsewhere', 'see /also/not/this', 'EOF', 'git -C /repo/a add notes.md'].join('\n');

    expect(dirs(command)).toEqual(['/repo/a/notes.md', '/repo/a']);
  });

  it('names nothing for a command without a path', () => {
    expect(dirs('echo hello')).toEqual([]);
    expect(dirs('npm test -- --run')).toEqual([]);
  });

  it('skips what only a shell could expand, and cd -', () => {
    expect(dirs('cd $REPO && cd - && ls /repo/*.ts && cd "$(git rev-parse --show-toplevel)"')).toEqual([]);
  });

  it('skips home-relative paths when home is unknown', () => {
    expect(shellDirectories('ls ~/dev', CWD, undefined)).toEqual([]);
  });

  it('names at most 32 directories', () => {
    const command = Array.from({ length: 40 }, (_, index) => `ls /repo/d${String(index)}`).join('; ');

    expect(dirs(command)).toHaveLength(32);
  });
});
