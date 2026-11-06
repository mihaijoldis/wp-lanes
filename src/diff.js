// Minimal unified diff (LCS based), enough for wp-config sized files.

export function unifiedDiff(a, b, nameA, nameB, context = 3) {
	const x = a.split('\n');
	const y = b.split('\n');
	const n = x.length;
	const m = y.length;
	const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && x[i] === y[j]) {
			ops.push({ t: ' ', line: x[i], i, j });
			i += 1;
			j += 1;
		} else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
			ops.push({ t: '-', line: x[i], i, j });
			i += 1;
		} else {
			ops.push({ t: '+', line: y[j], i, j });
			j += 1;
		}
	}

	const out = [`--- ${nameA}`, `+++ ${nameB}`];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].t === ' ') {
			k += 1;
			continue;
		}
		const start = Math.max(0, k - context);
		let end = k;
		while (end < ops.length) {
			if (ops[end].t !== ' ') {
				end += 1;
				continue;
			}
			let run = 0;
			while (end + run < ops.length && ops[end + run].t === ' ') {
				run += 1;
			}
			if (end + run >= ops.length || run > context * 2) {
				end = Math.min(ops.length, end + context);
				break;
			}
			end += run;
		}
		const hunk = ops.slice(start, end);
		const aCount = hunk.filter((o) => o.t !== '+').length;
		const bCount = hunk.filter((o) => o.t !== '-').length;
		out.push(`@@ -${hunk[0].i + 1},${aCount} +${hunk[0].j + 1},${bCount} @@`);
		for (const o of hunk) {
			out.push(`${o.t}${o.line}`);
		}
		k = end;
	}
	return out.join('\n');
}
