import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchSource, MARKER } from '../src/shim.js';
import { withDefaults } from '../src/config.js';

const config = withDefaults({ webRoot: '/srv/site', siteUrl: 'https://site.test/' });

test('patchSource guards a top-level DB_NAME define and inserts the shim after the opening tag', () => {
	const out = patchSource("<?php\ndefine( 'DB_NAME', 'local' );\ndefine( 'DB_USER', 'root' );\n", config);
	const lines = out.split('\n');
	assert.equal(lines[0], '<?php');
	assert.ok(lines[1].includes(MARKER));
	assert.ok(out.includes("defined( 'DB_NAME' ) || define( 'DB_NAME', 'local' );"));
	assert.ok(out.includes("\ndefine( 'DB_USER', 'root' );"));
	assert.ok(out.includes("__DIR__ . '/wp-content/lanes/'"));
});

test('patchSource leaves a define already wrapped in an if-not-defined block alone', () => {
	const source = "<?php\nif ( ! defined( 'WP_DEBUG_LOG' ) ) {\n\tdefine( 'WP_DEBUG_LOG', true );\n}\n";
	const out = patchSource(source, config);
	assert.ok(out.endsWith("if ( ! defined( 'WP_DEBUG_LOG' ) ) {\n\tdefine( 'WP_DEBUG_LOG', true );\n}\n"));
});

test('patchSource refuses an indented lane constant define without a guard', () => {
	assert.throws(() => patchSource("<?php\nif ( true ) {\n\tdefine( 'WP_PLUGIN_DIR', '/x' );\n}\n", config), /patch it by hand/);
});
