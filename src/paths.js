// Path helpers shared by config loading and Local discovery.

import os from 'node:os';

// Shells expand ~ only when unquoted, and Local's macOS sites.json stores "~/Local Sites/...".
export function expandHome(p, home = os.homedir()) {
	if (typeof p !== 'string') {
		return p;
	}
	if (p === '~') {
		return home;
	}
	return /^~[/\\]/.test(p) ? `${home}${p.slice(1)}` : p;
}

// Forward slashes work for every path Node, PHP and the mysql client take, on Windows too.
export function toSlash(p) {
	return p.replaceAll('\\', '/');
}
