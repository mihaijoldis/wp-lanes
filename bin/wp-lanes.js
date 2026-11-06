#!/usr/bin/env node
// wp-lanes: several branches live-tested on one WordPress site at once.

import fs from 'node:fs';
import path from 'node:path';
import { loadSite, writeSiteConfig, listSites, siteConfigPath } from '../src/config.js';
import { discoverLocalSite } from '../src/local.js';
import { expandHome, toSlash } from '../src/paths.js';
import { unifiedDiff } from '../src/diff.js';
import { installShim } from '../src/shim.js';
import { up, down, list, dbReset, wp } from '../src/lane.js';
import { doctor, doctorWithoutSite } from '../src/doctor.js';

const USAGE = `Usage: wp-lanes <command> [--site <name>] ...

  init-site <name> --domain <local-site-domain> [--force]
            Reads Local's sites.json; any flag below overrides what it finds.
  init-site <name> --web-root <dir> --site-url <url> --php <php> [--php-arg <arg>]...
            --wp-cli <phar|wp> --mysql-bin <dir> [--mysql-host 127.0.0.1] [--mysql-port 3306]
            [--mysql-user root] [--mysql-password root] [--mysql-database local]
            [--local-sites-json <file> --local-site-id <id>] [--plugins-dir <dir>]
            [--mu-plugins-dir <dir>] [--wp-config <file>] [--force]
  install-shim
  up <lane> [--from <worktree>]... [--override <pluginDir>=<path>]... [--no-db]
  down <lane>
  list
  wp <lane> -- <wp-cli args>
  db-reset <lane>
  doctor`;

const REPEATABLE = new Set(['from', 'override', 'php-arg']);
const BOOLEAN = new Set(['no-db', 'force', 'help']);

function parseArgs(argv) {
	const positionals = [];
	const flags = {};
	let rest = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--') {
			rest = argv.slice(i + 1);
			break;
		}
		if (!arg.startsWith('--')) {
			positionals.push(arg);
			continue;
		}
		const eq = arg.indexOf('=');
		const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		let value = true;
		if (!BOOLEAN.has(key)) {
			value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
			if (value === undefined) {
				throw new Error(`--${key} needs a value.`);
			}
		}
		if (REPEATABLE.has(key)) {
			(flags[key] ??= []).push(value);
		} else {
			flags[key] = value;
		}
	}
	return { positionals, flags, rest };
}

function required(value, key) {
	if (value === undefined || value === '') {
		throw new Error(`--${key} is required (or pass --domain <local-site-domain> to read it from Local).`);
	}
	return value;
}

// Builds the site config from Local's records when --domain is given; any explicit flag wins.
function buildSiteConfig(flags) {
	const sitesJson = flags['local-sites-json'] && expandHome(flags['local-sites-json']);
	const found = flags.domain
		? discoverLocalSite(flags.domain, sitesJson ? { sitesJsonPath: toSlash(sitesJson), dataDir: toSlash(path.dirname(sitesJson)) } : {})
		: {};
	const flagPath = (key, fallback) => (flags[key] === undefined ? fallback : toSlash(expandHome(flags[key])));
	const mysqlIn = found.mysql ?? {};
	const localSitesJson = flagPath('local-sites-json', mysqlIn.localSitesJson);
	const localSiteId = flags['local-site-id'] ?? mysqlIn.localSiteId;
	return {
		webRoot: required(flagPath('web-root', found.webRoot), 'web-root'),
		siteUrl: required(flags['site-url'] ?? found.siteUrl, 'site-url'),
		...(flags['plugins-dir'] && { pluginsDir: flagPath('plugins-dir') }),
		...(flags['mu-plugins-dir'] && { muPluginsDir: flagPath('mu-plugins-dir') }),
		...(flags['wp-config'] && { wpConfig: flagPath('wp-config') }),
		php: [
			required(flagPath('php', found.php?.[0]), 'php'),
			...(flags['php-arg']?.map((a) => expandHome(a)) ?? found.php?.slice(1) ?? []),
		],
		wpCli: flagPath('wp-cli', found.wpCli ?? 'wp'),
		mysql: {
			binDir: flagPath('mysql-bin', mysqlIn.binDir ?? ''),
			host: flags['mysql-host'] ?? mysqlIn.host ?? '127.0.0.1',
			port: Number(flags['mysql-port'] ?? mysqlIn.port ?? 3306),
			user: flags['mysql-user'] ?? mysqlIn.user ?? 'root',
			password: flags['mysql-password'] ?? mysqlIn.password ?? 'root',
			database: flags['mysql-database'] ?? mysqlIn.database ?? 'local',
			...(localSitesJson && { localSitesJson }),
			...(localSiteId && { localSiteId }),
		},
	};
}

function redactedJson(config) {
	return `${JSON.stringify({ ...config, mysql: { ...config.mysql, password: '<redacted>' } }, null, '	')}
`;
}

function initSite(name, flags) {
	if (!name) {
		throw new Error('init-site needs a site name.');
	}
	const config = buildSiteConfig(flags);
	const file = siteConfigPath(name);
	if (fs.existsSync(file) && !flags.force) {
		const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (JSON.stringify(existing) === JSON.stringify(config)) {
			console.log(`${file} already matches; nothing to do.`);
			return 0;
		}
		console.log(unifiedDiff(redactedJson(existing), redactedJson(config), `${file} (current)`, `${file} (init-site)`));
		throw new Error(`${file} exists and differs (diff above, password redacted); pass --force to overwrite.`);
	}
	writeSiteConfig(name, config, true);
	console.log(`Wrote ${file}`);
	console.log(redactedJson(config).trimEnd());
	console.log(`Next: wp-lanes doctor${listSites().length > 1 ? ` --site ${name}` : ''}`);
	return 0;
}

function laneArg(positionals, command) {
	if (!positionals[1]) {
		throw new Error(`${command} needs a lane name.`);
	}
	return positionals[1];
}

async function main(argv) {
	const { positionals, flags, rest } = parseArgs(argv);
	const command = positionals[0];
	if (!command || flags.help) {
		console.log(USAGE);
		return command ? 0 : 1;
	}
	if (command === 'init-site') {
		return initSite(positionals[1], flags);
	}
	if (command === 'sites') {
		console.log(listSites().join('\n'));
		return 0;
	}
	if (command === 'doctor' && !flags.site && !listSites().length) {
		return doctorWithoutSite();
	}
	const config = loadSite(flags.site);
	switch (command) {
		case 'install-shim':
			return installShim(config);
		case 'up':
			return up(config, laneArg(positionals, command), {
				froms: flags.from ?? [],
				overrideFlags: flags.override ?? [],
				noDb: Boolean(flags['no-db']),
			});
		case 'down':
			return down(config, laneArg(positionals, command));
		case 'list':
			return list(config);
		case 'wp':
			return wp(config, laneArg(positionals, command), rest);
		case 'db-reset':
			return dbReset(config, laneArg(positionals, command));
		case 'doctor':
			return doctor(config);
		default:
			throw new Error(`Unknown command "${command}".\n${USAGE}`);
	}
}

try {
	globalThis.process.exitCode = await main(globalThis.process.argv.slice(2));
} catch (e) {
	console.error(`wp-lanes: ${e.message}`);
	globalThis.process.exitCode = 1;
}
