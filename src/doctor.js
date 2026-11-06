// Health check: every resolved path, PHP, MySQL, the shim and the lanes, then the next command to run.

import fs from 'node:fs';
import path from 'node:path';
import { mysqlPort, listSites, configRoot } from './config.js';
import { localDataDir } from './local.js';
import { bin, dbExists, query } from './db.js';
import { isShimInstalled, headSite } from './shim.js';
import { allManifests } from './lane.js';
import { runCapture } from './run.js';

// Finds a bare command on PATH the way spawn would (PATHEXT on Windows).
function onPath(cmd) {
	const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE').split(';')] : [''];
	for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
		for (const ext of exts) {
			const candidate = path.join(dir, cmd + ext);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

function siteFlag(config) {
	return listSites().length > 1 ? ` --site ${config.name}` : '';
}

export async function doctor(config) {
	const problems = [];
	let pending = null;
	const report = (status, label, detail = '') => {
		console.log(`${status.padEnd(4)} ${label}${detail ? `: ${detail}` : ''}`);
	};
	const check = (ok, label, detail, fix) => {
		report(ok ? 'OK' : 'FAIL', label, detail);
		if (!ok) {
			problems.push(fix);
		}
		return ok;
	};
	const domain = new URL(config.siteUrl).host;
	const reinit = `re-run \`wp-lanes init-site ${config.name} --domain ${domain} --force\` (or edit ${config.file})`;
	const pathLine = (label, p, required = true) => {
		const exists = Boolean(p) && fs.existsSync(p);
		if (required) {
			check(exists, label, `${p} (${exists ? 'exists' : 'missing'})`, `${label} is missing: ${reinit}.`);
		} else {
			report(exists ? 'OK' : 'INFO', label, `${p} (${exists ? 'exists' : 'missing, created when needed'})`);
		}
		return exists;
	};

	console.log(`Site config: ${config.file}`);
	pathLine('web root', config.webRoot);
	const hasWpConfig = pathLine('wp-config.php', config.wpConfig);
	pathLine('plugins dir', config.pluginsDir);
	pathLine('mu-plugins dir', config.muPluginsDir, false);
	pathLine('lanes dir', config.lanesDir, false);

	const [php, ...phpArgs] = config.php;
	const phpExists = pathLine('php binary', php);
	const iniIndex = phpArgs.indexOf('-c');
	if (iniIndex !== -1) {
		pathLine('php.ini', phpArgs[iniIndex + 1]);
	}
	if (config.wpCli.endsWith('.phar')) {
		pathLine('wp-cli phar', config.wpCli);
	} else {
		const found = onPath(config.wpCli);
		if (check(Boolean(found), 'wp-cli on PATH', found ?? `${config.wpCli} (missing)`, `Install WP-CLI, or point wpCli at Local's wp-cli.phar: ${reinit}.`)) {
			// Local's DB_HOST is reachable only with Local's php.ini, which a bare `wp` does not load.
			report('INFO', 'wp-cli uses its own PHP', `if \`wp-lanes wp\` cannot reach the database, set wpCli to Local's wp-cli.phar in ${config.file}`);
		}
	}
	if (config.mysql.binDir) {
		pathLine('mysql bin dir', config.mysql.binDir);
		pathLine('mysql client', bin(config, 'mysql'));
		pathLine('mysqldump', bin(config, 'mysqldump'));
	} else {
		for (const name of ['mysql', 'mysqldump']) {
			const found = onPath(name);
			check(Boolean(found), `${name} on PATH`, found ?? 'missing', `${name} is not on PATH; set mysql.binDir: ${reinit}.`);
		}
	}
	if (config.mysql.localSitesJson && pathLine('Local sites.json', config.mysql.localSitesJson)) {
		let site = null;
		try {
			site = JSON.parse(fs.readFileSync(config.mysql.localSitesJson, 'utf8'))[config.mysql.localSiteId];
		} catch {
			// Reported below as an unknown id.
		}
		check(Boolean(site), 'Local site id', `${config.mysql.localSiteId}${site ? ` (${site.domain})` : ' not in sites.json'}`, `Local has no site ${config.mysql.localSiteId} on this machine: ${reinit}.`);
	}

	if (hasWpConfig) {
		const installed = isShimInstalled(config);
		report(installed ? 'OK' : 'TODO', 'wp-config shim installed', config.wpConfig);
		if (!installed) {
			pending = `wp-lanes install-shim${siteFlag(config)}`;
		}
	}

	if (phpExists) {
		const phpRun = runCapture(php, [...phpArgs, '-r', 'echo PHP_VERSION;']);
		// Startup warnings (e.g. a missing extension) print before the version; keep the version only.
		check(phpRun.code === 0, 'php runs', phpRun.code === 0 ? phpRun.stdout.trim().split('\n').pop() : phpRun.stderr.trim(), `php does not run: ${reinit}.`);
	}

	const port = mysqlPort(config);
	try {
		query(config, 'SELECT 1');
		report('OK', 'mysql reachable', `${config.mysql.host}:${port}`);
		check(dbExists(config, config.mysql.database), 'base database exists', config.mysql.database, `Database ${config.mysql.database} is missing: ${reinit}.`);
	} catch (e) {
		check(false, 'mysql reachable', `${config.mysql.host}:${port}: ${e.message}`, `MySQL did not answer: start the site in Local, then run \`wp-lanes doctor${siteFlag(config)}\` again.`);
	}

	const rel = path.relative(config.webRoot, config.lanesDir);
	check(!rel.startsWith('..') && !path.isAbsolute(rel), 'lanes dir under web root', config.lanesDir, `lanesDir must sit under the web root so nginx serves lane assets: ${reinit}.`);

	const home = await headSite(`${config.siteUrl}/`);
	check(home.status === 200 && !home.headers['x-wp-lane'], 'base site answers 200 without a lane header', String(home.status || home.error), `${config.siteUrl}/ must answer 200: start the site in Local and check that ${domain} resolves.`);

	const manifests = allManifests(config);
	for (const m of manifests) {
		const missing = Object.entries(m.overrides).filter(([, t]) => !fs.existsSync(t)).map(([p]) => p);
		check(!missing.length, `lane ${m.name} overrides present`, missing.length ? `missing worktree for ${missing.join(', ')}` : '', `Lane ${m.name} points at a deleted worktree: wp-lanes down ${m.name}${siteFlag(config)}.`);
		if (m.db) {
			let exists = false;
			try {
				exists = dbExists(config, m.db);
			} catch {
				// Reported above.
			}
			check(exists, `lane ${m.name} database`, m.db, `Lane ${m.name} lost its database: wp-lanes db-reset ${m.name}${siteFlag(config)}.`);
		}
	}

	console.log('');
	if (problems.length) {
		console.log('Next: fix these, then run `wp-lanes doctor` again.');
		[...new Set(problems)].forEach((p) => console.log(`  - ${p}`));
	} else if (pending) {
		console.log(`Next: ${pending}`);
	} else if (!manifests.length) {
		console.log(`Next: wp-lanes up <lane> --from <worktree>${siteFlag(config)}`);
	} else {
		console.log('Ready.');
	}
	return problems.length ? 1 : 0;
}

// doctor on a machine with no site config yet: point at init-site with this machine's Local domains.
export function doctorWithoutSite() {
	console.log(`FAIL site config: none in ${configRoot}`);
	const file = `${localDataDir()}/sites.json`;
	let domains = [];
	try {
		domains = Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).map((s) => s?.domain).filter(Boolean).sort();
		console.log(`OK   Local sites.json: ${file} (${domains.join(', ') || 'no sites'})`);
	} catch {
		console.log(`FAIL Local sites.json: ${file} (missing; install Local and start a site once)`);
	}
	console.log('');
	if (domains.length === 1) {
		console.log(`Next: wp-lanes init-site ${domains[0].split('.')[0]} --domain ${domains[0]}`);
	} else {
		console.log('Next: run the line for the site you want lanes on:');
		(domains.length ? domains : ['<site-domain>']).forEach((d) => console.log(`  wp-lanes init-site ${d.split('.')[0]} --domain ${d}`));
	}
	return 1;
}
