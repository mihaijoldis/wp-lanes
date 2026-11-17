import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mirror } from '../src/lane.js';

test('mirror lets an override replace a base plugin dir whose name differs only in case', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lanes-'));
	const base = path.join(root, 'base');
	const renamed = path.join(root, 'worktree', 'foo-bar');
	fs.mkdirSync(path.join(base, 'Foo-Bar'), { recursive: true });
	fs.mkdirSync(path.join(base, 'untouched'), { recursive: true });
	fs.mkdirSync(renamed, { recursive: true });
	fs.writeFileSync(path.join(renamed, 'marker.txt'), 'override');
	const dest = path.join(root, 'lane');

	mirror(base, dest, { 'foo-bar': renamed });

	const entries = fs.readdirSync(dest).sort();
	assert.deepEqual(entries, ['foo-bar', 'untouched']);
	assert.equal(fs.readFileSync(path.join(dest, 'foo-bar', 'marker.txt'), 'utf8'), 'override');
	fs.rmSync(root, { recursive: true });
});
