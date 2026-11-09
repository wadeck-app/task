// END-TO-END smoke of the gitlab strategy through the BUNDLED CLI (dist-bundle/task.cjs) against the FAKE GitLab server of the tests.
// NOT part of `npm test` or CI. It is the only end-to-end run possible: NO real GitLab instance and NO token were available when the
// strategy was written, so nothing here proves the strategy works against a real GitLab; it proves that the shipped bundle, the
// config, the registry and the strategy agree with the fake server, which is modelled on docs.gitlab.com.
//
//   npm run build
//   BUNDLE_VERSION=0.0.0-local npm run bundle
//   node scripts/gitlab-fake-smoke.mjs
//
// Everything runs in a temp world (XDG_CONFIG_HOME, HOME, USERPROFILE point into it, QUEUE_SDK_OFF=1: events are never pushed). The
// real queue, the real registry, the real app-core and the global task install are never touched. The fake token is only in the
// environment of the processes started here and is checked to appear in no output. The world is removed at the end.
//
// For each tier (free, premium): strategy show/check, labels sync, new, set-status, add-label, comment, link (premium works, free is
// refused), set-parent (refused on both), show/list/history read back, delete (refused without a fill, then a tombstone with one),
// then `task migrate` local -> gitlab and gitlab -> local.
//
// Exit codes: 0 all assertions passed, 1 an assertion failed, 2 the environment is wrong (a clear message).
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'packages/task-cli/dist-bundle/task.cjs');
const fakeModule = path.join(root, 'packages/task-service/dist/plugins/gitlab/fakeGitLab.testkit.js');

function die(message) {
	console.error(`gitlab-fake-smoke: ${message}`);
	process.exit(2);
}

if (!fs.existsSync(bundle))
	die(`${bundle} does not exist. Run: npm run build && BUNDLE_VERSION=0.0.0-local npm run bundle`);
if (!fs.existsSync(fakeModule)) die(`${fakeModule} does not exist. Run: npm run build`);

const { FakeGitLab } = await import(pathToFileURL(fakeModule).href);
const sdk = await import('@wadeck-app/project-sdk');

const world = fs.mkdtempSync(path.join(os.tmpdir(), 'task-gitlab-smoke-'));
const env = {
	...process.env,
	XDG_CONFIG_HOME: path.join(world, 'xdg'),
	HOME: world,
	USERPROFILE: world,
	QUEUE_SDK_OFF: '1',
};
delete env.TASK_PROJECT;
const registryDir = sdk.defaultRegistryDir({ XDG_CONFIG_HOME: env.XDG_CONFIG_HOME });

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
	if (condition) {
		passed++;
		console.log(`  ok    ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name}${detail === '' ? '' : `\n          ${detail.replaceAll('\n', '\n          ')}`}`);
	}
}

const STATUSES = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
`;

async function register(name) {
	const folder = path.join(world, 'work', name);
	fs.mkdirSync(folder, { recursive: true });
	const added = await sdk.addProject(registryDir, { name, path: folder });
	const configFolder = sdk.projectToolDir(registryDir, added.id, 'task', 'config');
	fs.mkdirSync(configFolder, { recursive: true });
	const configFile = path.join(configFolder, 'config.yml');
	fs.writeFileSync(configFile, STATUSES);
	return { name, folder, configFile, dataDir: sdk.projectToolDir(registryDir, added.id, 'task', 'data') };
}

function gitlabConfig(fake, tier, fills = '') {
	const sep = tier === 'free' ? ':' : '::';
	return `${STATUSES}strategy:
${fills === '' ? '' : '    fidelity: degrade\n'}    type: gitlab
    options:
        project: ${fake.project}
        tier: ${tier}
        baseUrl: ${fake.baseUrl}
        tokenEnv: TASK_SMOKE_GITLAB_TOKEN
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 5
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status${sep}in-progress' }
            done: { state: closed }
            cancelled: { state: closed, label: 'status${sep}cancelled' }
${fills}`;
}

/** Runs the bundled CLI (asynchronously: the fake server lives in this process and must keep answering). */
function task(project, args, token) {
	return new Promise(resolve => {
		const child = spawn('node', [bundle, ...(project === undefined ? [] : ['-p', project.name]), ...args], {
			env: { ...env, TASK_SMOKE_GITLAB_TOKEN: token },
			cwd: project?.folder ?? world,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		let err = '';
		child.stdout.on('data', chunk => (out += chunk));
		child.stderr.on('data', chunk => (err += chunk));
		const timer = setTimeout(() => child.kill(), 60_000);
		child.on('close', code => {
			clearTimeout(timer);
			resolve({ code, out, err });
		});
	});
}

async function tier(name) {
	console.log(`\n=== tier ${name} ===`);
	const fake = await FakeGitLab.start({ project: 'acme/shop', tier: name });
	const token = fake.token;
	const gl = await register(`gl-${name}`);
	const src = await register(`src-${name}`);
	const back = await register(`back-${name}`);
	fs.writeFileSync(gl.configFile, gitlabConfig(fake, name));
	const run = (project, ...args) => task(project, args, token);
	const labelSep = name === 'free' ? ':' : '::';
	const leaked = results => results.some(r => r.out.includes(token) || r.err.includes(token));
	const all = [];
	const t = async (...args) => {
		const r = await run(gl, ...args);
		all.push(r);
		return r;
	};
	try {
		console.log('strategy');
		const show = await t('strategy', 'show');
		check(
			'strategy show names the plugin and the declared tier',
			show.code === 0 && /gitlab/.test(show.out) && new RegExp(`Tier:\\s+${name} \\(declared\\)`).test(show.out),
			show.out + show.err
		);
		const checked = await t('strategy', 'check');
		check(
			'strategy check exits 0 (warnings only)',
			checked.code === 0 && /Result: ok/.test(checked.out),
			checked.out + checked.err
		);
		check(
			'strategy check says it is not verified against a real GitLab',
			/not been verified against a real GitLab instance/.test(checked.out),
			checked.out
		);
		check(
			'strategy check shows the tier line',
			new RegExp(`\\n\\s+tier\\s+ok\\s+.*${name}`).test(checked.out),
			checked.out
		);

		console.log('labels sync');
		const dry = await t('labels', 'sync', '--dry-run');
		check(
			'labels sync --dry-run lists and creates nothing',
			dry.code === 0 && fake.writes().length === 0 && /would create/.test(dry.out),
			dry.out + dry.err
		);
		const sync = await t('labels', 'sync');
		check(
			'labels sync creates the status labels with a colour',
			sync.code === 0 &&
				fake
					.projectLabels()
					.some(l => l.name === `status${labelSep}in-progress` && /^#[0-9A-Fa-f]{6}$/.test(l.color)),
			sync.out + sync.err
		);

		console.log('writes');
		const first = JSON.parse((await t('new', 'First gitlab task', '--json')).out).id;
		const second = JSON.parse((await t('new', 'Second gitlab task', '--json')).out).id;
		check(
			'new creates issues numbered by iid',
			first === '1' && second === '2' && fake.issue(1)?.title === 'First gitlab task',
			`${first} ${second}`
		);
		check(
			'set-status moves the issue and its status label',
			(await t('set-status', first, 'in-progress')).code === 0 &&
				fake.labelsOf(1).includes(`status${labelSep}in-progress`)
		);
		check(
			'add-label reaches GitLab',
			(await t('add-label', first, 'urgent')).code === 0 && fake.labelsOf(1).includes('urgent')
		);
		check(
			'comment is a note of the token user',
			(await t('comment', first, 'hello from the smoke')).code === 0 &&
				fake.notes(1).some(n => n.body === 'hello from the smoke')
		);
		const link = await t('link', second, 'blockedBy', first);
		if (name === 'free') {
			check(
				'link blockedBy is refused on free with the tier in the hint',
				link.code === 1 && /Premium/.test(link.out + link.err) && fake.links(2).length === 0,
				link.out + link.err
			);
		} else {
			check(
				'link blockedBy works on premium (is_blocked_by)',
				link.code === 0 &&
					JSON.stringify(fake.links(2)) === JSON.stringify([{ iid: 1, type: 'is_blocked_by' }]),
				link.out + link.err
			);
		}
		const parent = await t('set-parent', second, first);
		check(
			'set-parent is refused (hierarchy), nothing written for it',
			parent.code === 1 && /hierarchy/.test(parent.out + parent.err),
			parent.out + parent.err
		);

		console.log('reads back');
		const shown = JSON.parse((await t('show', first, '--json')).out);
		check(
			'show: status, label and comment come back',
			shown.status === 'in-progress' &&
				shown.labels?.includes('urgent') &&
				shown.comments?.[0]?.text === 'hello from the smoke',
			JSON.stringify(shown)
		);
		const listed = JSON.parse((await t('list', '--json')).out);
		check('list shows both open tasks', listed.length === 2, JSON.stringify(listed));
		const history = await t('history', first, '--all');
		check(
			'history --all shows the status change',
			history.code === 0 && /in-progress/.test(history.out),
			history.out + history.err
		);
		check('no task file in the data folder of the project', !fs.existsSync(path.join(gl.dataDir, 'tasks')));

		console.log('delete');
		const refused = await t('delete', second);
		check(
			'delete without a fill is refused with the fills to write',
			refused.code === 1 && /tombstone/.test(refused.out + refused.err) && fake.issue(2)?.state === 'opened',
			refused.out + refused.err
		);
		fs.writeFileSync(gl.configFile, gitlabConfig(fake, name, '        fills:\n            delete: tombstone\n'));
		const removed = await t('delete', second);
		check(
			'delete with the tombstone fill closes and labels the issue',
			removed.code === 0 && fake.issue(2)?.state === 'closed' && fake.labelsOf(2).includes('task:deleted'),
			removed.out + removed.err
		);
		const after = JSON.parse((await t('list', '--all', '--json')).out);
		check('the tombstone is hidden from list', after.length === 1, JSON.stringify(after));
		fs.writeFileSync(gl.configFile, gitlabConfig(fake, name));

		console.log('migrate');
		const a = JSON.parse((await run(src, 'new', 'Migrated one', '--json')).out).id;
		await run(src, 'new', 'Migrated two', '--json');
		await run(src, 'set-status', a, 'done');
		await run(src, 'comment', a, 'a note', '--author', 'ann');
		const into = await run(undefined, 'migrate', '--from', src.name, '--to', gl.name, '--allow-loss', 'all');
		all.push(into);
		check('migrate local -> gitlab exits 0', into.code === 0, into.out + into.err);
		check(
			'the issues exist on GitLab',
			['Migrated one', 'Migrated two'].every(title =>
				[...Array(10).keys()].some(i => fake.issue(i + 1)?.title === title)
			),
			into.out
		);
		const again = await run(undefined, 'migrate', '--from', src.name, '--to', gl.name, '--allow-loss', 'all');
		all.push(again);
		check(
			'a second migrate creates nothing',
			again.code === 0 && /created 0/.test(again.out),
			again.out + again.err
		);
		const out = await run(undefined, 'migrate', '--from', gl.name, '--to', back.name, '--allow-loss', 'all');
		all.push(out);
		check('migrate gitlab -> local exits 0', out.code === 0, out.out + out.err);
		const titles = JSON.parse((await run(back, 'list', '--all', '--json')).out).map(x => x.title);
		check(
			'the tasks are back in a local project',
			titles.includes('Migrated one') && titles.includes('First gitlab task'),
			JSON.stringify(titles)
		);

		console.log('errors');
		const wrong = await task(gl, ['list'], 'a-wrong-token-value');
		check(
			'a wrong token is a clear 401 error and is never printed',
			wrong.code === 1 &&
				/GitLab refused the token/.test(wrong.out + wrong.err) &&
				!(wrong.out + wrong.err).includes('a-wrong-token-value'),
			wrong.out + wrong.err
		);
		check('the fake token appears in no output', !leaked(all));
	} finally {
		await fake.stop();
	}
}

try {
	await tier('free');
	await tier('premium');
} finally {
	fs.rmSync(world, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
