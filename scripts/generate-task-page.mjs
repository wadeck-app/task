// Assembles packages/app-module-task/src/dsl-views/task-page.yaml from the fragments of src/dsl-views/variants/.
//
//   npm run views --workspace=packages/app-module-task          (write the file)
//   node scripts/generate-task-page.mjs --check                  (exit 1 when the committed file is stale)
//
// Fragments (see variants/_page.yaml for the full explanation):
//   _page.yaml     text before the line `$type: PageContent` is copied verbatim (comments, $sources, $actions); after it:
//                  `$notices` (nodes shown above the variants) and `$experiment` ({id, label, initial, variants: [names]}).
//   _shared.yaml   { name: node }, used as `{ $use: name }` anywhere in a fragment (nested uses allowed, cycles refused).
//   <name>.yaml    { label, hint, view } per variant, in the order of `$experiment.variants`.
//
// To REMOVE the experiment later (bake the winner): replace the task:VariantSwitcher of the generated page by the chosen
// variant's view, then delete variants/, this script, the `views` npm script and taskPageVariants.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VIEWS_DIR = path.resolve(HERE, '../packages/app-module-task/src/dsl-views');

const HOW =
	'See the header of src/dsl-views/variants/_page.yaml: a variant is src/dsl-views/variants/<name>.yaml with the keys label, hint and view, listed under $experiment.variants.';

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
	const { $notices: notices, $experiment: experiment } = rest ?? {};
	if (!Array.isArray(notices)) {
		fail(`${pageFile}: $notices must be a list of nodes.`);
	}
	if (
		!experiment ||
		typeof experiment.id !== 'string' ||
		typeof experiment.label !== 'string' ||
		typeof experiment.initial !== 'string' ||
		!Array.isArray(experiment.variants)
	) {
		fail(`${pageFile}: $experiment needs id, label, initial and variants (a list of names).`);
	}
	const names = experiment.variants;
	const duplicate = names.find((name, index) => names.indexOf(name) !== index);
	if (duplicate !== undefined) {
		fail(`${pageFile}: variant "${duplicate}" is listed twice under $experiment.variants.`);
	}
	if (!names.includes(experiment.initial)) {
		fail(
			`${pageFile}: $experiment.initial "${experiment.initial}" is not one of the variants (${names.join(', ')}).`
		);
	}

	const shared = readYaml(path.join(dir, '_shared.yaml'), '_shared.yaml') ?? {};
	const variants = {};
	for (const name of names) {
		const file = path.join(dir, `${name}.yaml`);
		const fragment = readYaml(file, `variant file "${name}.yaml" (listed under $experiment.variants)`);
		const keys = fragment && typeof fragment === 'object' ? Object.keys(fragment) : [];
		const missing = ['label', 'hint', 'view'].filter(key => !keys.includes(key));
		const unknown = keys.filter(key => !['label', 'hint', 'view'].includes(key));
		if (missing.length > 0 || unknown.length > 0) {
			fail(
				`${file}: a variant has exactly label, hint and view (missing: ${missing.join(', ') || 'none'}; unexpected: ${unknown.join(', ') || 'none'}).`
			);
		}
		const expanded = expand(fragment, shared, `${name}.yaml`);
		// The reference variant is the page as shipped, untouched. Every other variant draws nothing until the task is loaded:
		// with an unknown, unreadable or virtual project the notices above the switcher say why, and the empty frames of a
		// design ("Created: undefined") would only add noise.
		variants[name] =
			name === experiment.initial
				? expanded
				: {
						...expanded,
						view: {
							$type: 'VerticalStack',
							$if: '$sources.detail.task',
							gap: 'gap-0',
							items: [expanded.view],
						},
					};
	}
	const known = new Set([...names.map(name => `${name}.yaml`), '_page.yaml', '_shared.yaml']);
	const orphans = fs.readdirSync(dir).filter(file => file.endsWith('.yaml') && !known.has(file));
	if (orphans.length > 0) {
		fail(
			`${orphans.join(', ')} in ${dir} is not listed under $experiment.variants (list it, or move the file out of the folder).`
		);
	}

	const body = {
		$type: 'PageContent',
		sections: [
			...expand(notices, shared, '$notices'),
			{
				$type: 'task:VariantSwitcher',
				id: experiment.id,
				label: experiment.label,
				initial: experiment.initial,
				variants,
			},
		],
	};
	const banner =
		'# GENERATED - edit src/dsl-views/variants/*.yaml and run: npm run views --workspace=packages/app-module-task\n' +
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
