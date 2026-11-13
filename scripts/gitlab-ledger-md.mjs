// Prints the hypothesis ledger of the GitLab mock (packages/task-service/src/plugins/gitlab/fakeGitLabLedger.testkit.ts) as a markdown
// table, to paste in the storage plan. Reads the COMPILED ledger, so run `npm run build` first.
//
//   node scripts/gitlab-ledger-md.mjs                  every line, then the count per status
//   node scripts/gitlab-ledger-md.mjs --status ASSUMED only the lines with that status (LIVE-VERIFIED, DOCUMENTED-NOT-LIVE, UNVERIFIABLE, ASSUMED)
//
// GL_LEDGER_KIT=<path to fakeGitLabLedger.testkit.js> reads another build.
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const STATUSES = ['LIVE-VERIFIED', 'DOCUMENTED-NOT-LIVE', 'UNVERIFIABLE', 'ASSUMED'];
const root = path.resolve(import.meta.dirname, '..');
const kitPath =
	process.env.GL_LEDGER_KIT ??
	path.join(root, 'packages/task-service/dist/plugins/gitlab/fakeGitLabLedger.testkit.js');

const args = process.argv.slice(2);
const statusAt = args.indexOf('--status');
const wanted = statusAt >= 0 ? args[statusAt + 1] : undefined;
if (args.some(arg => arg.startsWith('--') && arg !== '--status') || (statusAt >= 0 && !STATUSES.includes(wanted))) {
	console.error(`usage: node scripts/gitlab-ledger-md.mjs [--status ${STATUSES.join('|')}]`);
	process.exit(2);
}

let ledger;
try {
	({ MOCK_LEDGER: ledger } = await import(pathToFileURL(kitPath).href));
} catch (error) {
	console.error(
		`cannot load the compiled ledger ${kitPath}: ${error.message}\nBuild it first: npm run build (at the root of the repository).`
	);
	process.exit(1);
}
if (!Array.isArray(ledger)) {
	console.error(`${kitPath} does not export MOCK_LEDGER as an array`);
	process.exit(1);
}

const cell = text => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const detail = entry => {
	const steps = entry.evidence.length === 0 ? '' : `steps: ${entry.evidence.join('; ')}`;
	switch (entry.status) {
		case 'LIVE-VERIFIED':
			return `${entry.date}; ${steps}`;
		case 'ASSUMED':
			return `probe: ${entry.probe}${steps === '' ? '' : `; ${steps}`}`;
		case 'DOCUMENTED-NOT-LIVE':
			return `${entry.docs}; ${entry.reason}${steps === '' ? '' : `; ${steps}`}`;
		default:
			return `${entry.reason}${steps === '' ? '' : `; ${steps}`}`;
	}
};

const rows = ledger.filter(entry => wanted === undefined || entry.status === wanted);
console.log('| id | area | behaviour | status | evidence / reason |');
console.log('| -- | ---- | --------- | ------ | ----------------- |');
for (const entry of rows)
	console.log(
		`| ${entry.id} | ${cell(entry.area)} | ${cell(entry.behaviour)} | ${entry.status} | ${cell(detail(entry))} |`
	);
console.log('');
console.log(
	`${rows.length} lines${wanted === undefined ? `: ${STATUSES.map(status => `${ledger.filter(entry => entry.status === status).length} ${status}`).join(', ')}` : ` with status ${wanted}`}`
);
