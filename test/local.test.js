import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configFromLocal, findSiteByDomain, localDataDir, wpCliCandidates } from '../src/local.js';
import { expandHome } from '../src/paths.js';

const sites = JSON.parse(fs.readFileSync(new URL('./fixtures/local-sites.json', import.meta.url), 'utf8'));

const WIN_DATA = 'C:/Users/u/AppData/Roaming/Local';
const MAC_DATA = '/Users/mihai/Library/Application Support/Local';

function windowsCtx(existing, lightningDirs = ['php-8.4.10+0', 'php-8.4.16+1', 'mysql-8.0.35+4', 'mysql-8.4.0', 'mariadb-10.4.32+1']) {
	const present = new Set(existing);
	return {
		platform: 'win32',
		arch: 'x64',
		home: 'C:\\Users\\u',
		dataDir: WIN_DATA,
		sitesJsonPath: `${WIN_DATA}/sites.json`,
		lightningDirs,
		exists: (p) => present.has(p),
		wpCliCandidates: wpCliCandidates({ platform: 'win32', env: {} }),
	};
}

function macCtx(existing, lightningDirs) {
	const present = new Set(existing);
	return {
		platform: 'darwin',
		arch: 'arm64',
		home: '/Users/mihai',
		dataDir: MAC_DATA,
		sitesJsonPath: `${MAC_DATA}/sites.json`,
		lightningDirs,
		exists: (p) => present.has(p),
		wpCliCandidates: wpCliCandidates({ platform: 'darwin' }),
	};
}

test('configFromLocal derives every path of a Windows-shaped Local site', () => {
	const config = configFromLocal(sites, 'edd.local', windowsCtx([
		`${WIN_DATA}/lightning-services/php-8.4.10+0/bin/win64/php.exe`,
		`${WIN_DATA}/lightning-services/mysql-8.0.35+4/bin/win64/bin/mysql.exe`,
		'C:/Program Files (x86)/Local/resources/extraResources/bin/wp-cli/wp-cli.phar',
	]));

	assert.deepEqual(config, {
		webRoot: 'D:/Local/Sites/edd/app/public',
		siteUrl: 'https://edd.local',
		php: [`${WIN_DATA}/lightning-services/php-8.4.10+0/bin/win64/php.exe`, '-c', `${WIN_DATA}/run/WinSite01/conf/php/php.ini`],
		wpCli: 'C:/Program Files (x86)/Local/resources/extraResources/bin/wp-cli/wp-cli.phar',
		mysql: {
			binDir: `${WIN_DATA}/lightning-services/mysql-8.0.35+4/bin/win64/bin`,
			host: '127.0.0.1',
			port: 10005,
			user: 'root',
			password: 'fixture-pass',
			database: 'local',
			localSitesJson: `${WIN_DATA}/sites.json`,
			localSiteId: 'WinSite01',
		},
	});
});

test('configFromLocal derives every path of a Mac-shaped Local site with a home-relative path', () => {
	const config = configFromLocal(sites, 'edd-mac.local', macCtx([
		`${MAC_DATA}/lightning-services/php-8.2.27+1/bin/darwin-arm64/bin/php`,
		`${MAC_DATA}/lightning-services/mariadb-10.6.23+0/bin/darwin-arm64/bin/mysql`,
	], ['php-8.2.27+1', 'mariadb-10.6.23+0', 'mysql-8.0.35+4']));

	assert.deepEqual(config, {
		webRoot: '/Users/mihai/Local Sites/edd/app/public',
		siteUrl: 'https://Edd-Mac.local',
		php: [`${MAC_DATA}/lightning-services/php-8.2.27+1/bin/darwin-arm64/bin/php`, '-c', `${MAC_DATA}/run/MacSite02/conf/php/php.ini`],
		wpCli: 'wp',
		mysql: {
			binDir: `${MAC_DATA}/lightning-services/mariadb-10.6.23+0/bin/darwin-arm64/bin`,
			host: '127.0.0.1',
			port: 10015,
			user: 'root',
			password: 'fixture-pass',
			database: 'local',
			localSitesJson: `${MAC_DATA}/sites.json`,
			localSiteId: 'MacSite02',
		},
	});
});

test('configFromLocal uses the Mac Local wp-cli phar when it exists', () => {
	const phar = '/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar';
	const config = configFromLocal(sites, 'edd-mac.local', macCtx([phar], ['php-8.2.27+1', 'mariadb-10.6.23+0']));
	assert.equal(config.wpCli, phar);
});

test('configFromLocal falls back to the darwin bin dir when darwin-arm64 is absent', () => {
	const config = configFromLocal(sites, 'edd-mac.local', macCtx([
		`${MAC_DATA}/lightning-services/php-8.2.27+1/bin/darwin/php`,
	], ['php-8.2.27+1', 'mariadb-10.6.23+0']));
	assert.equal(config.php[0], `${MAC_DATA}/lightning-services/php-8.2.27+1/bin/darwin/php`);
});

test('configFromLocal picks the service build whose binary exists over a newer empty one', () => {
	const config = configFromLocal(sites, 'edd.local', windowsCtx([
		`${WIN_DATA}/lightning-services/php-8.4.10+0/bin/win64/php.exe`,
	], ['php-8.4.10+3', 'php-8.4.10+0', 'php-8.4.100+0', 'mysql-8.0.35']));
	assert.equal(config.php[0], `${WIN_DATA}/lightning-services/php-8.4.10+0/bin/win64/php.exe`);
	assert.equal(config.mysql.binDir, `${WIN_DATA}/lightning-services/mysql-8.0.35/bin/win64/bin`);
});

test('configFromLocal throws when no lightning service matches the site version', () => {
	assert.throws(() => configFromLocal(sites, 'edd.local', windowsCtx([], ['php-8.3.23+0', 'mysql-8.0.35+4'])), /php-8\.4\.10/);
});

test('findSiteByDomain names the known domains when the domain is unknown', () => {
	assert.throws(() => findSiteByDomain(sites, 'nope.local'), /Edd-Mac\.local, edd\.local/);
});

test('localDataDir resolves the sites.json directory per platform', () => {
	assert.equal(localDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' }), WIN_DATA);
	assert.equal(localDataDir({ platform: 'darwin', env: {}, home: '/Users/mihai' }), MAC_DATA);
});

test('expandHome expands a leading tilde only', () => {
	assert.equal(expandHome('~/Local Sites/edd', '/Users/mihai'), '/Users/mihai/Local Sites/edd');
	assert.equal(expandHome('/srv/~/x', '/Users/mihai'), '/srv/~/x');
	assert.equal(expandHome(undefined, '/Users/mihai'), undefined);
});
