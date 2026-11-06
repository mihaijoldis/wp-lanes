import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configFromLocal, findSiteByDomain, isFile, localDataDir, socketFromMyCnf, wpCliCandidates } from '../src/local.js';
import { connArgs } from '../src/db.js';
import { expandHome, toSlash } from '../src/paths.js';

const sites = JSON.parse(fs.readFileSync(new URL('./fixtures/local-sites.json', import.meta.url), 'utf8'));

const WIN_DATA = 'C:/Users/u/AppData/Roaming/Local';
const MAC_DATA = '/Users/u/Library/Application Support/Local';

function windowsCtx(existing, lightningDirs = ['php-8.4.10+0', 'php-8.4.16+1', 'mysql-8.0.35+4', 'mysql-8.4.0', 'mariadb-10.4.32+1'], files = {}) {
	const present = new Set(existing);
	return {
		platform: 'win32',
		arch: 'x64',
		home: 'C:\\Users\\u',
		dataDir: WIN_DATA,
		sitesJsonPath: `${WIN_DATA}/sites.json`,
		lightningDirs,
		isFile: (p) => present.has(p),
		readText: (p) => files[p] ?? null,
		wpCliCandidates: wpCliCandidates({ platform: 'win32', env: {} }),
	};
}

function macCtx(existing, lightningDirs, files = {}) {
	const present = new Set(existing);
	return {
		platform: 'darwin',
		arch: 'arm64',
		home: '/Users/u',
		dataDir: MAC_DATA,
		sitesJsonPath: `${MAC_DATA}/sites.json`,
		lightningDirs,
		isFile: (p) => present.has(p),
		readText: (p) => files[p] ?? null,
		wpCliCandidates: wpCliCandidates({ platform: 'darwin' }),
	};
}

test('configFromLocal derives every path of a Windows-shaped Local site', () => {
	const config = configFromLocal(sites, 'mysite.local', windowsCtx([
		`${WIN_DATA}/lightning-services/php-8.4.10+0/bin/win64/php.exe`,
		`${WIN_DATA}/lightning-services/mysql-8.0.35+4/bin/win64/bin/mysql.exe`,
		'C:/Program Files (x86)/Local/resources/extraResources/bin/wp-cli/wp-cli.phar',
	]));

	assert.deepEqual(config, {
		webRoot: 'C:/Users/u/Local Sites/mysite/app/public',
		siteUrl: 'https://mysite.local',
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
	const config = configFromLocal(sites, 'mysite-mac.local', macCtx([
		`${MAC_DATA}/lightning-services/php-8.2.27+1/bin/darwin-arm64/bin/php`,
		`${MAC_DATA}/lightning-services/mariadb-10.6.23+0/bin/darwin-arm64/bin/mysql`,
	], ['php-8.2.27+1', 'mariadb-10.6.23+0', 'mysql-8.0.35+4']));

	assert.deepEqual(config, {
		webRoot: '/Users/u/Local Sites/mysite/app/public',
		siteUrl: 'https://MySite-Mac.local',
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
	const config = configFromLocal(sites, 'mysite-mac.local', macCtx([phar], ['php-8.2.27+1', 'mariadb-10.6.23+0']));
	assert.equal(config.wpCli, phar);
});

test('configFromLocal falls back to the darwin bin dir when darwin-arm64 is absent', () => {
	const config = configFromLocal(sites, 'mysite-mac.local', macCtx([
		`${MAC_DATA}/lightning-services/php-8.2.27+1/bin/darwin/php`,
	], ['php-8.2.27+1', 'mariadb-10.6.23+0']));
	assert.equal(config.php[0], `${MAC_DATA}/lightning-services/php-8.2.27+1/bin/darwin/php`);
});

test('configFromLocal picks the service build whose binary exists over a newer empty one', () => {
	const config = configFromLocal(sites, 'mysite.local', windowsCtx([
		`${WIN_DATA}/lightning-services/php-8.4.10+0/bin/win64/php.exe`,
	], ['php-8.4.10+3', 'php-8.4.10+0', 'php-8.4.100+0', 'mysql-8.0.35']));
	assert.equal(config.php[0], `${WIN_DATA}/lightning-services/php-8.4.10+0/bin/win64/php.exe`);
	assert.equal(config.mysql.binDir, `${WIN_DATA}/lightning-services/mysql-8.0.35/bin/win64/bin`);
});

test('configFromLocal throws when no lightning service matches the site version', () => {
	assert.throws(() => configFromLocal(sites, 'mysite.local', windowsCtx([], ['php-8.3.23+0', 'mysql-8.0.35+4'])), /php-8\.4\.10/);
});

test('findSiteByDomain names the known domains when the domain is unknown', () => {
	assert.throws(() => findSiteByDomain(sites, 'nope.local'), /MySite-Mac\.local, mysite\.local/);
});

test('localDataDir resolves the sites.json directory per platform', () => {
	assert.equal(localDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' }), WIN_DATA);
	assert.equal(localDataDir({ platform: 'darwin', env: {}, home: '/Users/u' }), MAC_DATA);
});

test('expandHome expands a leading tilde only', () => {
	assert.equal(expandHome('~/Local Sites/mysite', '/Users/u'), '/Users/u/Local Sites/mysite');
	assert.equal(expandHome('/srv/~/x', '/Users/u'), '/srv/~/x');
	assert.equal(expandHome(undefined, '/Users/u'), undefined);
});

const MAC_SOCKET = `${MAC_DATA}/run/MacSite02/mysql/mysqld.sock`;
const MAC_MY_CNF = `[mysqld]\nport = 10003\nsocket = ${MAC_SOCKET}\nskip-name-resolve\n`;

test('socketFromMyCnf reads the socket line and prefers the client section', () => {
	assert.equal(socketFromMyCnf(MAC_MY_CNF), MAC_SOCKET);
	assert.equal(socketFromMyCnf('[mysqld]\r\nsocket = /srv/a.sock\r\n[client]\r\nsocket="/srv/b.sock"\r\n'), '/srv/b.sock');
	assert.equal(socketFromMyCnf('[mysqld]\nport = 10003\n# socket = /commented.sock\n'), null);
	assert.equal(socketFromMyCnf(null), null);
});

test('configFromLocal takes the MySQL socket from the site my.cnf on macOS', () => {
	const config = configFromLocal(sites, 'mysite-mac.local', macCtx([], ['php-8.2.27+1', 'mariadb-10.6.23+0'], {
		[`${MAC_DATA}/run/MacSite02/conf/mysql/my.cnf`]: MAC_MY_CNF,
	}));
	assert.equal(config.mysql.socket, MAC_SOCKET);
});

test('configFromLocal leaves the socket unset on Windows even when my.cnf names one', () => {
	const config = configFromLocal(sites, 'mysite.local', windowsCtx([], undefined, {
		[`${WIN_DATA}/run/WinSite01/conf/mysql/my.cnf`]: '[mysqld]\nport = 10005\nsocket = C:\\\\Users\\u\\mysqld.sock\n',
	}));
	assert.equal('socket' in config.mysql, false);
});

test('configFromLocal skips a directory at the php candidate path for the binary inside it', (t) => {
	const dataDir = toSlash(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lanes-local-')));
	t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
	const platDir = `${dataDir}/lightning-services/php-8.2.27+1/bin/darwin-arm64`;
	fs.mkdirSync(`${platDir}/php`, { recursive: true });
	fs.mkdirSync(`${platDir}/bin`, { recursive: true });
	fs.writeFileSync(`${platDir}/bin/php`, '');

	const config = configFromLocal(sites, 'mysite-mac.local', {
		...macCtx([], ['php-8.2.27+1', 'mariadb-10.6.23+0']),
		dataDir,
		isFile,
	});
	assert.equal(config.php[0], `${platDir}/bin/php`);
});

test('connArgs connects over the socket when one is configured', () => {
	const args = connArgs({ mysql: { host: '127.0.0.1', port: 10003, user: 'root', socket: MAC_SOCKET } });
	assert.deepEqual(args, ['--protocol=socket', `--socket=${MAC_SOCKET}`, '-u', 'root']);
});

test('connArgs connects over TCP when no socket is configured', () => {
	const args = connArgs({ mysql: { host: '127.0.0.1', port: 10005, user: 'root' } });
	assert.deepEqual(args, ['-h', '127.0.0.1', '-P', '10005', '-u', 'root']);
});
