// Compares two result files of scripts/live-gitlab-smoke.mjs (--json <file>), typically one of a --mock run and one of a live run.
//
//   node scripts/live-gitlab-smoke-diff.mjs <a.json> <b.json>
//
// Prints the assertions whose NAME or ok flag differ between the two files (an assertion present in one file only, or ok in one and
// failed in the other), then the timings and request counts side by side (informational: they are never compared).
// Exit codes: 0 same names and same ok flags, 1 they differ, 2 usage or unreadable file.
import * as fs from 'node:fs';

const [fileA, fileB, ...extra] = process.argv.slice(2);
if (fileA === undefined || fileB === undefined || extra.length > 0) {
	console.error('Usage: node scripts/live-gitlab-smoke-diff.mjs <a.json> <b.json>');
	process.exit(2);
}

function load(file) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		console.error(
			`live-gitlab-smoke-diff: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`
		);
		process.exit(2);
	}
	if (!Array.isArray(parsed.assertions)) {
		console.error(
			`live-gitlab-smoke-diff: ${file} is not a result file of live-gitlab-smoke.mjs (no "assertions" list).`
		);
		process.exit(2);
	}
	return parsed;
}

const a = load(fileA);
const b = load(fileB);
const labelA = `${a.target ?? 'a'} (${fileA})`;
const labelB = `${b.target ?? 'b'} (${fileB})`;

const index = result => new Map(result.assertions.map(assertion => [assertion.name, assertion]));
const byA = index(a);
const byB = index(b);

let differences = 0;
const report = (kind, name, detail) => {
	differences += 1;
	console.log(
		`${kind}  ${name}${detail === undefined ? '' : `\n        ${String(detail).replaceAll('\n', '\n        ')}`}`
	);
};

for (const [name, assertion] of byA) {
	const other = byB.get(name);
	if (other === undefined) {
		report('ONLY IN A', name, `${labelA}: ${assertion.ok ? 'ok' : `FAILED ${assertion.detail ?? ''}`}`);
	} else if (assertion.ok !== other.ok) {
		report(
			'OK DIFFERS',
			name,
			`${labelA}: ${assertion.ok ? 'ok' : `FAILED ${assertion.detail ?? ''}`}\n${labelB}: ${other.ok ? 'ok' : `FAILED ${other.detail ?? ''}`}`
		);
	}
}
for (const [name, assertion] of byB) {
	if (!byA.has(name))
		report('ONLY IN B', name, `${labelB}: ${assertion.ok ? 'ok' : `FAILED ${assertion.detail ?? ''}`}`);
}

const count = result =>
	`${result.assertions.filter(assertion => assertion.ok).length} of ${result.assertions.length} assertions ok`;
console.log(`\nA ${labelA}: ${count(a)}\nB ${labelB}: ${count(b)}`);
console.log(
	`\n${differences === 0 ? 'Same assertion names and same ok flags.' : `${differences} difference(s) in assertion names or ok flags.`}`
);

// ---- informational: never compared
const requests = result => result.requests ?? {};
console.log('\nrequests (informational)');
for (const key of ['total', 'direct', 'writes', 'rateLimitRemaining', 'rateLimit']) {
	console.log(
		`  ${key.padEnd(20)} A ${String(requests(a)[key] ?? '-').padStart(8)}   B ${String(requests(b)[key] ?? '-').padStart(8)}`
	);
}
const tA = a.timings ?? [];
const tB = b.timings ?? [];
console.log('\ntimings in ms and requests per step (informational, A | B, in run order)');
for (let position = 0; position < Math.max(tA.length, tB.length); position++) {
	const left = tA[position];
	const right = tB[position];
	const cell = step =>
		step === undefined
			? ''.padEnd(14)
			: `${String(step.ms).padStart(7)} ${String(step.requests).padStart(4)}r`.padEnd(14);
	console.log(
		`  ${cell(left)} | ${cell(right)}  ${left?.name ?? right?.name ?? ''}${left !== undefined && right !== undefined && left.name !== right.name ? `  (B: ${right.name})` : ''}`
	);
}
process.exit(differences === 0 ? 0 : 1);
