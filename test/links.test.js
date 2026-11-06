import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDirLink, isLink, removeLink, safeRemoveTree, findLinks } from '../src/links.js';

function makeTarget(root) {
	const target = path.join(root, 'target');
	fs.mkdirSync(path.join(target, 'nested'), { recursive: true });
	fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
	fs.writeFileSync(path.join(target, 'nested', 'deep.txt'), 'deep');
	return target;
}

function assertTargetIntact(target) {
	assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
	assert.equal(fs.readFileSync(path.join(target, 'nested', 'deep.txt'), 'utf8'), 'deep');
}

test('removeLink removes the link and leaves the target contents', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lanes-'));
	const target = makeTarget(root);
	const link = path.join(root, 'link');
	createDirLink(target, link);
	assert.ok(isLink(link));
	assert.ok(fs.existsSync(path.join(link, 'keep.txt')));

	removeLink(link);

	assert.equal(fs.existsSync(link), false);
	assertTargetIntact(target);
	fs.rmSync(root, { recursive: true });
});

test('safeRemoveTree deletes a lane tree without following links into the target', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lanes-'));
	const target = makeTarget(root);
	const lane = path.join(root, 'lane');
	fs.mkdirSync(path.join(lane, 'plugins'), { recursive: true });
	fs.writeFileSync(path.join(lane, 'lane.php'), '<?php');
	createDirLink(target, path.join(lane, 'plugins', 'some-plugin'));
	assert.deepEqual(findLinks(lane), [path.join(lane, 'plugins', 'some-plugin')]);

	safeRemoveTree(lane);

	assert.equal(fs.existsSync(lane), false);
	assertTargetIntact(target);
	fs.rmSync(root, { recursive: true });
});

test('removeLink removes a link whose target no longer exists', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lanes-'));
	const target = makeTarget(root);
	const link = path.join(root, 'link');
	createDirLink(target, link);
	fs.rmSync(target, { recursive: true });
	assert.ok(isLink(link));

	removeLink(link);

	assert.equal(isLink(link), false);
	fs.rmSync(root, { recursive: true });
});

test('removeLink refuses a real directory', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lanes-'));
	const target = makeTarget(root);
	assert.throws(() => removeLink(target), /not a link/);
	assertTargetIntact(target);
	fs.rmSync(root, { recursive: true });
});
