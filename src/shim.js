// Installs the lane selector at the top of wp-config.php.

import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { runCapture } from './run.js';
import { unifiedDiff } from './diff.js';

export const MARKER = 'BEGIN wp-lanes shim';

// Constants lane.php defines; wp-config must not define them unguarded afterwards.
export const LANE_CONSTANTS = ['DB_NAME', 'WP_PLUGIN_DIR', 'WP_PLUGIN_URL', 'WPMU_PLUGIN_DIR', 'WPMU_PLUGIN_URL', 'WP_DEBUG_LOG', 'WP_CACHE_KEY_SALT'];

export function isShimInstalled(config) {
	return fs.readFileSync(config.wpConfig, 'utf8').includes(MARKER);
}

function shimCode(config) {
	const rel = path.relative(path.dirname(config.wpConfig), config.lanesDir).replaceAll('\\', '/');
	return `// ${MARKER} (managed by \`wp-lanes install-shim\`; remove through END to uninstall).
// Picks a lane: X-WP-Lane header, then ?wp_lane= (sets the wp_lane cookie, "off" clears it),
// then the wp_lane cookie, then the WP_LANE env var on the CLI. Unknown names get the base site.
( static function () {
	$is_cli = 'cli' === PHP_SAPI;
	$from_query = false;
	$lane = null;
	if ( ! $is_cli && isset( $_SERVER['HTTP_X_WP_LANE'] ) ) {
		$lane = $_SERVER['HTTP_X_WP_LANE'];
	} elseif ( ! $is_cli && isset( $_GET['wp_lane'] ) ) {
		$lane       = $_GET['wp_lane'];
		$from_query = true;
	} elseif ( ! $is_cli && isset( $_COOKIE['wp_lane'] ) ) {
		$lane = $_COOKIE['wp_lane'];
	} elseif ( $is_cli && false !== getenv( 'WP_LANE' ) ) {
		$lane = getenv( 'WP_LANE' );
	}
	if ( ! is_string( $lane ) ) {
		return;
	}
	$valid = 1 === preg_match( '/^[a-z0-9][a-z0-9_-]{0,63}$/D', $lane ) && is_file( __DIR__ . '/${rel}/' . $lane . '/lane.php' );
	if ( $from_query && ( $valid || 'off' === $lane ) && ! headers_sent() ) {
		$secure = ( ! empty( $_SERVER['HTTPS'] ) && 'off' !== $_SERVER['HTTPS'] ) || 'https' === ( $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '' );
		setcookie( 'wp_lane', $valid ? $lane : '', array( 'expires' => $valid ? 0 : 1, 'path' => '/', 'secure' => $secure, 'httponly' => false, 'samesite' => 'Lax' ) );
	}
	if ( $valid ) {
		define( 'WP_LANE', $lane );
		require __DIR__ . '/${rel}/' . $lane . '/lane.php';
	}
} )();
// END wp-lanes shim
`;
}

// Returns the patched source, or throws when a lane constant is defined unguarded in a way we
// cannot rewrite safely.
export function patchSource(source, config) {
	const lines = source.split('\n');
	const firstLine = lines[0].replace(/\r$/, '');
	if (firstLine.trim() !== '<?php') {
		throw new Error(`${config.wpConfig} does not start with a bare "<?php" line; patch it by hand.`);
	}
	for (let i = 0; i < lines.length; i += 1) {
		const match = lines[i].match(/^(\s*)define\(\s*['"]([A-Z_]+)['"]/);
		if (!match || !LANE_CONSTANTS.includes(match[2])) {
			continue;
		}
		const name = match[2];
		const prev = lines.slice(0, i).reverse().find((l) => l.trim() !== '') ?? '';
		const guardedByIf = new RegExp(`if\\s*\\(\\s*!\\s*defined\\(\\s*['"]${name}['"]\\s*\\)\\s*\\)`).test(prev);
		if (guardedByIf) {
			continue;
		}
		if (match[1] !== '') {
			throw new Error(`Line ${i + 1} defines ${name} indented without an "if ( ! defined() )" guard; patch it by hand.`);
		}
		lines[i] = `defined( '${name}' ) || ${lines[i]}`;
	}
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	const shim = shimCode(config).split('\n').join(eol);
	return [lines[0], shim.replace(new RegExp(`${eol}$`), ''), ...lines.slice(1)].join('\n');
}

export function headSite(url) {
	return new Promise((resolve) => {
		const lib = url.startsWith('https:') ? https : http;
		const req = lib.request(url, { method: 'HEAD', rejectUnauthorized: false, timeout: 30000 }, (res) => {
			res.resume();
			resolve({ status: res.statusCode, headers: res.headers });
		});
		req.on('timeout', () => req.destroy(new Error('timeout')));
		req.on('error', (e) => resolve({ status: 0, error: e.message, headers: {} }));
		req.end();
	});
}

// Diff lines that would print a secret from wp-config.
function redact(text) {
	return text.split('\n').map((l) => (/DB_PASSWORD|_KEY'|_SALT'|_KEY"|_SALT"/.test(l) ? `${l.slice(0, 1)}[redacted secret line]` : l)).join('\n');
}

function phpLint(config, file) {
	const [php, ...phpArgs] = config.php;
	return runCapture(php, [...phpArgs, '-l', file]);
}

function replaceWithRetry(from, to) {
	let lastError;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (e) {
			// Windows refuses the rename while php-cgi holds the file open; that lasts milliseconds.
			lastError = e;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
		}
	}
	throw lastError;
}

export async function installShim(config) {
	const target = config.wpConfig;
	const original = fs.readFileSync(target, 'utf8');
	if (original.includes(MARKER)) {
		console.log(`Shim already installed in ${target}; nothing to do.`);
		return 0;
	}

	const before = await headSite(`${config.siteUrl}/`);
	if (before.status !== 200) {
		throw new Error(`${config.siteUrl}/ answers ${before.status || before.error} before patching; fix the site first.`);
	}

	const patched = patchSource(original, config);
	const backup = `${target}.bak-pre-lanes`;
	const temp = `${target}.wp-lanes-tmp`;
	fs.writeFileSync(temp, patched);
	const lint = phpLint(config, temp);
	if (lint.code !== 0) {
		fs.unlinkSync(temp);
		throw new Error(`php -l rejected the patched wp-config:\n${lint.stdout}${lint.stderr}`);
	}
	if (fs.existsSync(backup)) {
		if (fs.readFileSync(backup, 'utf8').includes(MARKER)) {
			fs.unlinkSync(temp);
			throw new Error(`${backup} already contains the shim; refusing to treat it as the original.`);
		}
		console.log(`Keeping existing backup ${backup}.`);
	} else {
		fs.copyFileSync(target, backup);
		console.log(`Backed up ${target} to ${backup}.`);
	}

	replaceWithRetry(temp, target);
	const after = await headSite(`${config.siteUrl}/`);
	if (after.status !== 200 || after.headers['x-wp-lane']) {
		fs.copyFileSync(backup, temp);
		replaceWithRetry(temp, target);
		throw new Error(`After patching, ${config.siteUrl}/ answered ${after.status || after.error}; restored ${target} from ${backup}.`);
	}

	console.log(redact(unifiedDiff(original, patched, target, `${target} (patched)`)));
	console.log(`Shim installed. ${config.siteUrl}/ still answers ${after.status}.`);
	return 0;
}
