// Directory links and link-safe removal.
//
// Windows: junctions (no admin rights needed). Elsewhere: symlinks. Node creates the right kind
// from the same call, so creation needs no platform branch.

import fs from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

export function createDirLink(target, linkPath) {
	fs.symlinkSync(path.resolve(target), linkPath, isWindows ? 'junction' : 'dir');
}

export function isLink(p) {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

// Removes the link itself, never what it points at.
export function removeLink(p) {
	if (!isLink(p)) {
		throw new Error(`Refusing to remove ${p}: not a link.`);
	}
	if (isWindows) {
		// A junction is a directory reparse point: rmdir removes the reparse point only.
		try {
			fs.rmdirSync(p);
		} catch {
			fs.unlinkSync(p);
		}
	} else {
		fs.unlinkSync(p);
	}
	if (fs.existsSync(p) || isLink(p)) {
		throw new Error(`Link ${p} still exists after removal.`);
	}
}

// Deletes a directory tree without ever following a link: links are removed as links,
// real directories are descended into, files are unlinked.
export function safeRemoveTree(dir) {
	const st = lstatOrNull(dir);
	if (!st) {
		return;
	}
	if (st.isSymbolicLink()) {
		removeLink(dir);
		return;
	}
	if (!st.isDirectory()) {
		fs.unlinkSync(dir);
		return;
	}
	for (const name of fs.readdirSync(dir)) {
		safeRemoveTree(path.join(dir, name));
	}
	fs.rmdirSync(dir);
}

// Lists entries of a directory that are still links (used to refuse a delete).
export function findLinks(dir) {
	const found = [];
	const walk = (d) => {
		for (const name of fs.readdirSync(d)) {
			const p = path.join(d, name);
			const st = fs.lstatSync(p);
			if (st.isSymbolicLink()) {
				found.push(p);
			} else if (st.isDirectory()) {
				walk(p);
			}
		}
	};
	if (lstatOrNull(dir)?.isDirectory()) {
		walk(dir);
	}
	return found;
}

function lstatOrNull(p) {
	try {
		return fs.lstatSync(p);
	} catch {
		return null;
	}
}
