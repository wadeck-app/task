// Assembles packages/app-module-task/src/dsl-views/task-page.yaml from the fragments of src/dsl-views/variants/.
//
//   npm run views --workspace=packages/app-module-task          (write the file)
//   node scripts/generate-task-page.mjs --check                  (exit 1 when the committed file is stale)
//
// Fragments (see variants/_page.yaml for the full explanation):
//   _page.yaml     text before the line `$type: PageContent` is copied verbatim (comments, $sources, $actions); after it:
//                  `$notices` (nodes shown above the view), `$view` (the ONE base view) and `$page` (props of the PageContent).
//   _*.yaml        { name: node }, used as `{ $use: name }` anywhere (nested uses allowed, cycles refused, a name defined twice
//                  refused). `_shared.yaml` holds the facts and their editors, `_sections.yaml` the blocks of the main column.
//
// The page has no experiment any more (the A/B rows were baked on 2026-11-14).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VIEWS_DIR = path.resolve(HERE, '../packages/app-module-task/src/dsl-views');

const HOW =
	'See the header of src/dsl-views/variants/_page.yaml: the page is _page.yaml (sources, actions, notices, $view) plus fragment files named _<something>.yaml.';

function fail(message) {
	throw new Error(`generate-task-page: ${message}\n${HOW}`);
}

function readYaml(file, what) {
	if (!fs.existsSync(file)) {
		fail(`${what} is missing: ${file}`);
	}
	try {
		return yaml.load(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		fail(`${what} is not valid YAML (${file}): ${error.message}`);
	}
}

// Replaces every { $use: name } by the shared node, recursively. `chain` holds the names being expanded (cycle check).
function expand(value, shared, where, chain = []) {
	if (Array.isArray(value)) {
		return value.map(item => expand(item, shared, where, chain));
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if ('$use' in value) {
		const name = value.$use;
		const extra = Object.keys(value).filter(key => key !== '$use');
		if (extra.length > 0) {
			fail(
				`${where}: { $use: ${name} } must have no other key (found ${extra.join(', ')}); put the difference in a new shared fragment.`
			);
		}
		if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(shared, name)) {
			fail(`${where}: unknown $use "${String(name)}". Shared fragments: ${Object.keys(shared).join(', ')}.`);
		}
		if (chain.includes(name)) {
			fail(`${where}: $use cycle ${[...chain, name].join(' -> ')}.`);
		}
		return expand(structuredClone(shared[name]), shared, where, [...chain, name]);
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, shared, where, chain)]));
}

/** The content of task-page.yaml for the fragments in `viewsDir`, nothing written. */
export function generateTaskPage(viewsDir = DEFAULT_VIEWS_DIR) {
	const dir = path.join(viewsDir, 'variants');
	const pageFile = path.join(dir, '_page.yaml');
	if (!fs.existsSync(pageFile)) {
		fail(`_page.yaml is missing: ${pageFile}`);
	}
	const pageText = fs.readFileSync(pageFile, 'utf8').replace(/\r\n/g, '\n');
	const marker = pageText.search(/^\$type: PageContent\s*$/m);
	if (marker < 0) {
		fail(`${pageFile} has no line "$type: PageContent": it separates the verbatim head from the generated part.`);
	}
	const head = pageText.slice(0, marker);
	const rest = yaml.load(pageText.slice(marker));
	const { $notices: notices, $view: view, $page: pageProps } = rest ?? {};
	if (!Array.isArray(notices)) {
		fail(`${pageFile}: $notices must be a list of nodes.`);
	}
	if (view === null || typeof view !== 'object' || Array.isArray(view)) {
		fail(`${pageFile}: $view must be ONE node (the base view of the page).`);
	}

	const files = fs.readdirSync(dir).filter(file => file.endsWith('.yaml'));
	const orphans = files.filter(file => !file.startsWith('_'));
	if (orphans.length > 0) {
		fail(
			`${orphans.join(', ')} in ${dir} is not a fragment file: fragment files are named _<something>.yaml (an old design file must be deleted, the page has no per-design file any more).`
		);
	}
	const shared = {};
	for (const file of files.filter(name => name !== '_page.yaml').sort()) {
		const fragments = readYaml(path.join(dir, file), file) ?? {};
		for (const [name, node] of Object.entries(fragments)) {
			if (Object.prototype.hasOwnProperty.call(shared, name)) {
				fail(`fragment "${name}" is defined twice (second time in ${file}).`);
			}
			shared[name] = node;
		}
	}

	const expandedView = expand(view, shared, '$view');
	const expandedNotices = expand(notices, shared, '$notices');
	// The page draws nothing until the task is loaded: with an unknown, unreadable or virtual project the notices above say why,
	// and the empty frames ("Created: undefined") would only add noise.
	const guarded = { $type: 'VerticalStack', $if: '$sources.detail.task', gap: 'gap-0', items: [expandedView] };

	// `$page`: extra props of the PageContent (maxWidth: full, so the view decides its own width).
	const body = {
		$type: 'PageContent',
		...(pageProps === undefined ? {} : expand(pageProps, shared, '$page')),
		sections: [...expandedNotices, guarded],
	};
	const banner =
		'# GENERATED - edit src/dsl-views/variants/_*.yaml and run: npm run views --workspace=packages/app-module-task\n' +
		'# (scripts/generate-task-page.mjs). The comments below come from variants/_page.yaml.\n';
	return banner + head + yaml.dump(body, { indent: 2, lineWidth: -1, noRefs: true });
}

export function taskPageFile(viewsDir = DEFAULT_VIEWS_DIR) {
	return path.join(viewsDir, 'task-page.yaml');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const generated = generateTaskPage();
	const file = taskPageFile();
	if (process.argv.includes('--check')) {
		const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
		if (current !== generated) {
			process.stderr.write(`${file} is stale: run "npm run views --workspace=packages/app-module-task".\n`);
			process.exit(1);
		}
		process.stdout.write('task-page.yaml is up to date\n');
	} else {
		fs.writeFileSync(file, generated, 'utf8');
		process.stdout.write(`generated ${path.relative(process.cwd(), file)}\n`);
	}
}
