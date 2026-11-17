import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectOverrides } from '../src/git.js';

function git(dir, ...args) {
	execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.ignorecase=false', ...args], { cwd: dir, stdio: 'pipe' });
}

test('detectOverrides names a case-only renamed plugin dir once, by its new spelling when files under the old spelling were removed', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lanes-'));
	const base = path.join(root, 'plugins');
	const worktree = path.join(root, 'worktree');
	fs.mkdirSync(path.join(base, 'Foo-Bar'), { recursive: true });
	fs.writeFileSync(path.join(base, 'Foo-Bar', 'foo-bar.php'), '<?php');
	fs.writeFileSync(path.join(base, 'Foo-Bar', 'removed.php'), '<?php // removed');
	git(base, 'init', '-q');
	git(base, 'add', '.');
	git(base, 'commit', '-q', '-m', 'base');
	git(base, 'worktree', 'add', '-q', '--detach', worktree);
	git(worktree, 'mv', 'Foo-Bar', 'tmp-rename');
	git(worktree, 'mv', 'tmp-rename', 'foo-bar');
	git(worktree, 'rm', '-q', '-f', 'foo-bar/removed.php');
	git(worktree, 'commit', '-q', '-m', 'rename');

	const { overrides } = detectOverrides({ pluginsDir: base }, worktree);

	assert.deepEqual(Object.keys(overrides), ['foo-bar']);
	fs.rmSync(root, { recursive: true, force: true });
});
