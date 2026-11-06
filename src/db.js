// Lane database cloning with the site's own mysql/mysqldump binaries.

import path from 'node:path';
import { mysqlPort } from './config.js';
import { runCapture, runPipe } from './run.js';

const exe = process.platform === 'win32' ? '.exe' : '';

export function bin(config, name) {
	const dir = config.mysql.binDir;
	return dir ? path.join(dir, `${name}${exe}`) : name;
}

function connArgs(config) {
	const { host, user } = config.mysql;
	return ['-h', host, '-P', String(mysqlPort(config)), '-u', user];
}

// The password travels in the environment so it never shows up in a process list or a warning.
function env(config) {
	return { ...process.env, MYSQL_PWD: String(config.mysql.password ?? '') };
}

export function laneDbName(config, lane) {
	return `${config.mysql.database}_lane_${lane.replaceAll('-', '_')}`;
}

export function query(config, sql, database) {
	const args = [...connArgs(config), '-N', '-B', '-e', sql];
	if (database) {
		args.push(database);
	}
	const result = runCapture(bin(config, 'mysql'), args, { env: env(config) });
	if (result.code !== 0) {
		throw new Error(`mysql failed (${result.code}): ${result.stderr.trim()}`);
	}
	return result.stdout;
}

export function dbExists(config, name) {
	const out = query(config, `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}'`);
	return out.trim() === name;
}

export function dropDb(config, name) {
	assertLaneDb(config, name);
	query(config, `DROP DATABASE IF EXISTS \`${name}\``);
}

export async function cloneDb(config, name) {
	assertLaneDb(config, name);
	const base = config.mysql.database;
	if (dbExists(config, name)) {
		throw new Error(`Database ${name} already exists; run \`wp-lanes db-reset\` or \`down\` first.`);
	}
	const [charset, collation] = query(config, `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${base}'`).trim().split('\t');
	query(config, `CREATE DATABASE \`${name}\` CHARACTER SET ${charset} COLLATE ${collation}`);
	const result = await runPipe(
		{ cmd: bin(config, 'mysqldump'), args: [...connArgs(config), '--single-transaction', '--quick', '--routines', '--triggers', '--no-tablespaces', '--default-character-set=utf8mb4', base] },
		{ cmd: bin(config, 'mysql'), args: [...connArgs(config), '--default-character-set=utf8mb4', name] },
		{ env: env(config) },
	);
	if (result.fromCode !== 0 || result.toCode !== 0) {
		dropDb(config, name);
		throw new Error(`Clone of ${base} into ${name} failed.\nmysqldump (${result.fromCode}): ${result.fromErr.trim()}\nmysql (${result.toCode}): ${result.toErr.trim()}`);
	}
	return query(config, `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${name}'`).trim();
}

// Never let a lane command touch the base database or anything not named like a lane DB.
function assertLaneDb(config, name) {
	const prefix = `${config.mysql.database}_lane_`;
	if (!name.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(name) || name.length > 64) {
		throw new Error(`Refusing to touch database "${name}": not a lane database of ${config.mysql.database}.`);
	}
}
