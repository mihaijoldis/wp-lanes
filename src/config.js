// Per-site configuration in ~/.wp-lanes/sites/<site>.json (machine-specific).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './paths.js';

export const configRoot = path.join(os.homedir(), '.wp-lanes', 'sites');

export function siteConfigPath(name) {
	return path.join(configRoot, `${name}.json`);
}

export function listSites() {
	if (!fs.existsSync(configRoot)) {
		return [];
	}
	return fs.readdirSync(configRoot).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

export function loadSite(requested) {
	const sites = listSites();
	let name = requested;
	if (!name) {
		if (sites.length !== 1) {
			throw new Error(sites.length === 0
				? 'No site configured. Run `wp-lanes init-site <name> --domain <local-site-domain>` first (for example `wp-lanes init-site mysite --domain mysite.local`).'
				: `Several sites configured (${sites.join(', ')}); pass --site <name>.`);
		}
		name = sites[0];
	}
	const file = siteConfigPath(name);
	if (!fs.existsSync(file)) {
		throw new Error(`No config for site "${name}" at ${file}.`);
	}
	const config = JSON.parse(fs.readFileSync(file, 'utf8'));
	return { name, file, ...withDefaults(config) };
}

export function withDefaults(config) {
	const webRoot = expandHome(config.webRoot);
	const wpContent = path.join(webRoot, 'wp-content');
	return {
		...config,
		webRoot,
		...(config.php && { php: config.php.map((p) => expandHome(p)) }),
		...(config.wpCli && { wpCli: expandHome(config.wpCli) }),
		...(config.mysql && {
			mysql: { ...config.mysql, binDir: expandHome(config.mysql.binDir), socket: expandHome(config.mysql.socket), localSitesJson: expandHome(config.mysql.localSitesJson) },
		}),
		pluginsDir: expandHome(config.pluginsDir) ?? path.join(wpContent, 'plugins'),
		muPluginsDir: expandHome(config.muPluginsDir) ?? path.join(wpContent, 'mu-plugins'),
		wpConfig: expandHome(config.wpConfig) ?? path.join(webRoot, 'wp-config.php'),
		lanesDir: expandHome(config.lanesDir) ?? path.join(wpContent, 'lanes'),
		siteUrl: config.siteUrl.replace(/\/+$/, ''),
	};
}

// Local reassigns MySQL ports when its services restart, so prefer the live value from sites.json.
export function mysqlPort(config) {
	const { mysql } = config;
	if (mysql.localSitesJson && mysql.localSiteId) {
		try {
			const sites = JSON.parse(fs.readFileSync(mysql.localSitesJson, 'utf8'));
			const port = sites[mysql.localSiteId]?.services?.mysql?.ports?.MYSQL?.[0];
			if (port) {
				return Number(port);
			}
		} catch {
			// Fall through to the configured port.
		}
	}
	return Number(mysql.port);
}

export function writeSiteConfig(name, config, force) {
	const file = siteConfigPath(name);
	if (fs.existsSync(file) && !force) {
		throw new Error(`${file} already exists; pass --force to overwrite.`);
	}
	fs.mkdirSync(configRoot, { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(config, null, '\t')}\n`);
	return file;
}
