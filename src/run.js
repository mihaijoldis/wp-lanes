// Process helpers. Arguments are always passed as arrays (no shell), so paths with spaces are safe.

import { spawn, spawnSync } from 'node:child_process';

export function runCapture(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
		...options,
	});
	if (result.error) {
		return { code: 127, stdout: '', stderr: String(result.error.message) };
	}
	return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function runInherit(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...options });
	if (result.error) {
		console.error(result.error.message);
		return 127;
	}
	return result.status ?? 1;
}

// Pipes the stdout of one process into the stdin of another and waits for both.
export function runPipe(from, to, options = {}) {
	return new Promise((resolve) => {
		const producer = spawn(from.cmd, from.args, { windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
		const consumer = spawn(to.cmd, to.args, { windowsHide: true, ...options, stdio: ['pipe', 'ignore', 'pipe'] });
		let producerErr = '';
		let consumerErr = '';
		let pending = 2;
		const codes = {};
		const done = () => {
			pending -= 1;
			if (pending === 0) {
				resolve({ fromCode: codes.from, toCode: codes.to, fromErr: producerErr, toErr: consumerErr });
			}
		};
		producer.stderr.on('data', (d) => { producerErr += d; });
		consumer.stderr.on('data', (d) => { consumerErr += d; });
		producer.stdout.pipe(consumer.stdin);
		consumer.stdin.on('error', () => {});
		producer.on('error', (e) => { producerErr += e.message; });
		consumer.on('error', (e) => { consumerErr += e.message; });
		producer.on('close', (code) => { codes.from = code; done(); });
		consumer.on('close', (code) => { codes.to = code; done(); });
	});
}
