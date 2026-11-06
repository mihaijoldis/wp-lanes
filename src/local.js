// Builds a site config from Local's own records (sites.json and lightning-services).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, toSlash } from './paths.js';

// Local's per-user data directory, which holds sites.json, lightning-services/ and run/.
export function localDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
	if (platform === 'win32') {
		return toSlash(path.win32.join(env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming'), 'Local'));
	}
	if (platform === 'darwin') {
		return toSlash(path.posix.join(home, 'Library', 'Application Support', 'Local'));
	}
	return toSlash(path.posix.join(env.XDG_CONFIG_HOME ?? path.posix.join(home, '.config'), 'Local'));
}

// Local ships its bundled wp-cli phar inside the app; the per-user installer puts the app elsewhere.
export function wpCliCandidates({ platform = process.platform, env = process.env } = {}) {
	const rel = 'resources/extraResources/bin/wp-cli/wp-cli.phar';
	if (platform === 'win32') {
		return [
			`${env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'}/Local/${rel}`,
			`${env.ProgramFiles ?? 'C:/Program Files'}/Local/${rel}`,
			...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}/Programs/Local/${rel}`] : []),
		].map(toSlash);
	}
	if (platform === 'darwin') {
		return ['/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar'];
	}
	return [`/opt/Local/${rel}`];
}

// Subdirectories of a lightning service's bin/ to try, best match first.
function platformDirs(platform, arch) {
	if (platform === 'win32') {
		return ['win64', 'win32'];
	}
	if (platform === 'darwin') {
		return arch === 'arm64' ? ['darwin-arm64', 'darwin'] : ['darwin'];
	}
	return ['linux'];
}

// A directory can sit at a binary's candidate path (Local's macOS PHP has `bin/darwin-arm64/php/`).
export function isFile(p) {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

// The `socket =` value from a my.cnf, preferring the [client] section; null when there is none.
export function socketFromMyCnf(text) {
	let section = '';
	const found = {};
	for (const raw of String(text ?? '').split(/\r?\n/)) {
		const line = raw.trim();
		const header = /^\[([^\]]+)\]$/.exec(line);
		if (header) {
			section = header[1].trim().toLowerCase();
			continue;
		}
		const match = /^socket\s*=\s*(.+)$/.exec(line);
		if (match && !(section in found)) {
			found[section] = match[1].trim().replace(/^(["'])(.*)\1$/, '$2');
		}
	}
	return found.client ?? found.mysqld ?? Object.values(found)[0] ?? null;
}

export function findSiteByDomain(sites, domain) {
	const wanted = domain.toLowerCase();
	const matches = Object.entries(sites).filter(([, s]) => String(s?.domain ?? '').toLowerCase() === wanted);
	if (matches.length !== 1) {
		const known = Object.values(sites).map((s) => s?.domain).filter(Boolean).sort().join(', ');
		throw new Error(matches.length
			? `Several Local sites use the domain ${domain}; pass the paths by flag instead.`
			: `No Local site with domain ${domain}. Local knows: ${known || '(none)'}.`);
	}
	const [id, site] = matches[0];
	return { id: site.id ?? id, site };
}

// Picks `<name>-<version>` or `<name>-<version>+<n>` whose platform binary exists, newest build first.
function pickServiceBinary(ctx, service, binaryFor) {
	const prefix = `${service.name}-${service.version}`;
	const dirs = ctx.lightningDirs
		.filter((d) => d === prefix || (d.startsWith(`${prefix}+`) && /^\d+$/.test(d.slice(prefix.length + 1))))
		.sort((a, b) => build(b, prefix) - build(a, prefix));
	const candidates = [];
	for (const dir of dirs) {
		for (const plat of platformDirs(ctx.platform, ctx.arch)) {
			candidates.push(...binaryFor(`${ctx.dataDir}/lightning-services/${dir}/bin/${plat}`));
		}
	}
	return candidates.find((p) => ctx.isFile(p)) ?? candidates[0] ?? null;
}

function build(dir, prefix) {
	return dir === prefix ? -1 : Number(dir.slice(prefix.length + 1));
}

// Pure: everything machine-specific comes in through ctx, so tests can feed both platforms' shapes.
// ctx: { platform, arch, home, dataDir, sitesJsonPath, lightningDirs, isFile, readText, wpCliCandidates }.
export function configFromLocal(sites, domain, ctx) {
	const { id, site } = findSiteByDomain(sites, domain);
	const exe = ctx.platform === 'win32' ? '.exe' : '';
	const php = site.services?.php;
	const mysql = site.services?.mysql;
	if (!php?.version || !mysql?.version) {
		throw new Error(`Local's record for ${domain} has no php or mysql service version.`);
	}

	const phpBinary = pickServiceBinary(ctx, { name: php.name ?? 'php', version: php.version }, (dir) => [`${dir}/php${exe}`, `${dir}/bin/php${exe}`]);
	const mysqlClient = pickServiceBinary(ctx, { name: mysql.name ?? 'mysql', version: mysql.version }, (dir) => [`${dir}/bin/mysql${exe}`]);
	if (!phpBinary || !mysqlClient) {
		throw new Error(`No lightning-services directory for ${!phpBinary ? `${php.name ?? 'php'}-${php.version}` : `${mysql.name ?? 'mysql'}-${mysql.version}`} under ${ctx.dataDir}/lightning-services.`);
	}
	const port = mysql.ports?.MYSQL?.[0];
	const wpCli = ctx.wpCliCandidates.find((p) => ctx.isFile(p)) ?? 'wp';
	// Local's macOS root is granted only @localhost, so TCP is refused; Windows' socket line is unused.
	const socket = ctx.platform === 'win32' ? null : socketFromMyCnf(ctx.readText(`${ctx.dataDir}/run/${id}/conf/mysql/my.cnf`));

	return {
		webRoot: toSlash(`${expandHome(site.path, ctx.home)}/app/public`),
		siteUrl: `https://${site.domain}`,
		php: [phpBinary, '-c', `${ctx.dataDir}/run/${id}/conf/php/php.ini`],
		wpCli,
		mysql: {
			binDir: toSlash(path.posix.dirname(mysqlClient)),
			host: '127.0.0.1',
			port: Number(port ?? 3306),
			...(socket && { socket }),
			user: site.mysql?.user ?? 'root',
			password: site.mysql?.password ?? 'root',
			database: site.mysql?.database ?? 'local',
			localSitesJson: ctx.sitesJsonPath,
			localSiteId: id,
		},
	};
}

// Reads this machine's Local install and returns the config for the site serving `domain`.
export function discoverLocalSite(domain, overrides = {}) {
	const platform = process.platform;
	const home = os.homedir();
	const dataDir = overrides.dataDir ?? localDataDir({ platform, home });
	const sitesJsonPath = overrides.sitesJsonPath ?? `${dataDir}/sites.json`;
	if (!fs.existsSync(sitesJsonPath)) {
		throw new Error(`Local's sites.json is not at ${sitesJsonPath}; is Local installed and has it been started once? Pass --local-sites-json to point at it.`);
	}
	const sites = JSON.parse(fs.readFileSync(sitesJsonPath, 'utf8'));
	const servicesDir = `${dataDir}/lightning-services`;
	return configFromLocal(sites, domain, {
		platform,
		arch: process.arch,
		home,
		dataDir,
		sitesJsonPath,
		lightningDirs: fs.existsSync(servicesDir) ? fs.readdirSync(servicesDir) : [],
		isFile,
		readText: (p) => (isFile(p) ? fs.readFileSync(p, 'utf8') : null),
		wpCliCandidates: wpCliCandidates({ platform }),
	});
}
