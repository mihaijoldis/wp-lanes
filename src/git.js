// Works out which plugin directories a worktree overrides.

import fs from 'node:fs';
import path from 'node:path';
import { runCapture } from './run.js';

function git(dir, args) {
	const result = runCapture('git', ['-C', dir, ...args]);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(' ')} in ${dir} failed: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

export function samePath(a, b) {
	const norm = (p) => {
		const resolved = fs.existsSync(p) ? fs.realpathSync.native(p) : path.resolve(p);
		const real = resolved.replaceAll('\\', '/').replace(/\/+$/, '');
		return process.platform === 'win32' ? real.toLowerCase() : real;
	};
	return norm(a) === norm(b);
}

// --git-common-dir is relative (".git") from a main checkout and absolute from a worktree.
function commonDir(dir) {
	try {
		return path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']));
	} catch {
		return null;
	}
}

function isRepoTop(dir) {
	try {
		return samePath(git(dir, ['rev-parse', '--show-toplevel']), dir);
	} catch {
		return false;
	}
}

// Returns { overrides: { pluginDir: absPath }, notes: [] }.
export function detectOverrides(config, worktree) {
	const from = path.resolve(worktree);
	if (!fs.existsSync(from)) {
		throw new Error(`Worktree ${from} does not exist.`);
	}
	const fromCommon = commonDir(from);
	if (!fromCommon) {
		throw new Error(`${from} is not a git checkout; use --override <pluginDir>=<path>.`);
	}

	const baseCommon = isRepoTop(config.pluginsDir) ? commonDir(config.pluginsDir) : null;
	if (baseCommon && samePath(baseCommon, fromCommon)) {
		return monorepoOverrides(config, from);
	}

	for (const entry of fs.readdirSync(config.pluginsDir)) {
		const dir = path.join(config.pluginsDir, entry);
		if (entry.startsWith('.') || !fs.existsSync(path.join(dir, '.git'))) {
			continue;
		}
		const entryCommon = commonDir(dir);
		if (entryCommon && samePath(entryCommon, fromCommon)) {
			return { overrides: { [entry]: git(from, ['rev-parse', '--show-toplevel']) }, notes: [`${from} is a worktree of the ${entry} repo.`] };
		}
	}
	throw new Error(`${from} shares no git repository with ${config.pluginsDir} or any plugin in it; use --override <pluginDir>=<path>.`);
}

// A worktree of the plugins repo itself: override every top-level plugin dir the branch touches.
function monorepoOverrides(config, from) {
	const top = git(from, ['rev-parse', '--show-toplevel']);
	const baseHead = git(config.pluginsDir, ['rev-parse', 'HEAD']);
	const mergeBase = git(top, ['merge-base', 'HEAD', baseHead]);
	// Diff against the working tree so uncommitted edits count too.
	const changed = git(top, ['diff', '--name-only', mergeBase]).split('\n');
	const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '--directory']).split('\n');

	const overrides = {};
	const skipped = new Set();
	for (const file of [...changed, ...untracked]) {
		if (!file) {
			continue;
		}
		const first = file.split('/')[0];
		const abs = path.join(top, first);
		if (first.startsWith('.') || !file.includes('/') || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
			skipped.add(first);
			continue;
		}
		overrides[first] = abs;
	}
	const notes = [`${from} is a worktree of the plugins repo; merge-base with base HEAD ${baseHead.slice(0, 10)} is ${mergeBase.slice(0, 10)}.`];
	if (skipped.size) {
		notes.push(`Not overridden (top-level files or dot-dirs): ${[...skipped].sort().join(', ')}.`);
	}
	if (!Object.keys(overrides).length) {
		throw new Error(`${from} changes no plugin directory relative to base HEAD; use --override <pluginDir>=<path>.`);
	}
	return { overrides, notes };
}
