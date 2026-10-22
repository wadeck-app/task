import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as {
	id?: string;
	version?: unknown;
	backendEntryPath?: unknown;
	extensionPoints: { kind: string; slot: string; path?: string; view: { type: string; value: string } }[];
};

describe('manifest.json (source manifest of the app-core-cli layout)', () => {
	it('declares the id the module is registered under: app-core refuses a manifest without it ("Required" at path id)', () => {
		expect(manifest.id).toBe('task');
	});

	it('holds neither version nor backendEntryPath: `app-core-cli package` stamps the first and fixes the second', () => {
		expect(manifest).not.toHaveProperty('version');
		expect(manifest).not.toHaveProperty('backendEntryPath');
	});

	it('references every view as ./src/dsl-views/<file> and each of them exists', () => {
		const paths = manifest.extensionPoints.map(point => point.view.value);
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			expect(path).toMatch(/^\.\/src\/dsl-views\/[\w.-]+\.ya?ml$/);
			expect(existsSync(join(packageDir, path))).toBe(true);
		}
	});

	it('contributes a dashboard widget, the nav pages (tasks, tree, projects, types) and the route-slot pages', () => {
		const summary = manifest.extensionPoints.map(p => `${p.kind}:${p.slot}:${p.path ?? ''}`);
		expect(summary).toEqual([
			'widget:dashboard:',
			'page:nav:/tasks',
			'page:nav:/tree',
			'page:nav:/projects',
			'page:nav:/types',
			'page:route:/tasks/:id',
			'page:route:/tasks/:id/history',
			'page:route:/new',
			'page:route:/delete',
		]);
	});

	it('gives each page its own view and every view file of src/dsl-views is referenced', () => {
		const referenced = manifest.extensionPoints.map(p => p.view.value.replace('./src/dsl-views/', '')).sort();
		expect(new Set(referenced).size).toBe(referenced.length);
		const onDisk = readdirSync(join(packageDir, 'src/dsl-views')).sort();
		expect(referenced).toEqual(onDisk);
	});
});

describe('package layout (module-authoring.md)', () => {
	const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
		name: string;
		private: boolean;
		files: string[];
	};

	it('is the private @wadeck-app/app-module-task package publishing only dist-module', () => {
		expect(pkg.name).toBe('@wadeck-app/app-module-task');
		expect(pkg.private).toBe(true);
		expect(pkg.files).toEqual(['dist-module']);
	});

	it('git-ignores dist-module and .app-core-dev', () => {
		const lines = readFileSync(join(packageDir, '.gitignore'), 'utf8').split(/\r?\n/);
		expect(lines).toContain('dist-module');
		expect(lines).toContain('.app-core-dev');
	});
});

describe('dashboard widget (src/dsl-views/tasks-widget.yaml)', () => {
	const widget = readFileSync(join(packageDir, 'src/dsl-views/tasks-widget.yaml'), 'utf8');

	it('shows the skipped-projects warning only when /summary reports skipped projects (no silent undercount)', () => {
		expect(widget).toContain('$if: $sources.summary.skippedCount');
		// Short text: the badge of the narrow widget does not wrap, a long one is cut.
		expect(widget).toContain('$sources.summary.skippedText');
		expect(widget).toContain('$sources.summary.projectRows');
	});

	it('is the global view: open and total figures, then a table with one row per project linking to its tasks', () => {
		expect(widget).toContain('$sources.summary.open');
		expect(widget).toContain('$sources.summary.total');
		expect(widget).toContain('rows: $sources.summary.projectRows');
		expect(widget).toContain("navigateTo: '{href}'");
		for (const key of ['label', 'openText', 'totalText']) {
			expect(widget).toContain(`key: '${key}'`);
		}
	});

	it('shows the zero-project welcome as an info badge, never a danger badge, and no figures with it', () => {
		const welcome = widget.slice(widget.indexOf('$if: $sources.summary.noProjects')).split('\n').slice(0, 3);
		expect(welcome[1]).toContain('label: $sources.summary.noProjectsText');
		expect(welcome[2]).toContain('variant: info');
		// The figures and the project table both wait for a counted project.
		expect(widget.split('$if: $sources.summary.projectCount')).toHaveLength(3);
	});
});

describe('tasks page: global list without ?project (src/dsl-views/tasks-page.yaml)', () => {
	const page = readFileSync(join(packageDir, 'src/dsl-views/tasks-page.yaml'), 'utf8');

	it('shares the tasks source with the project page, fed by the route tasksQuery (project or global), with inlineErrors and reload', () => {
		const block = page.slice(page.indexOf('    tasks:'), page.indexOf('$type: PageContent'));
		expect(block).toContain('url: GET /api/modules/task/tasks?{query}&inlineErrors=true');
		expect(block).toContain('query: $source.projects.scopeQuery');
		expect(block).toContain('reload: $urlParam.reload');
	});

	it('lists every project task with a Project column, rows linking to the task with its project', () => {
		const table = page.slice(page.indexOf('rows: $sources.tasks.tasks'));
		expect(table).toContain("navigateTo: '{href}'");
		expect(table.indexOf("key: 'projectName'")).toBeGreaterThan(-1);
		expect(table.indexOf("key: 'projectName'")).toBeLessThan(table.indexOf("key: 'titleText'"));
		expect(page).toContain('$if: $sources.tasks.scopeText');
	});

	it('shows the skipped-projects warning and the error of the global list, and the way back to it', () => {
		expect(page).toContain('label: $sources.tasks.warning');
		expect(page).toContain('label: $sources.tasks.errorText');
		expect(page).toContain('$if: $sources.projects.allProjectsHref');
		expect(page).toContain('label: All projects');
		expect(page).toContain('label: $sources.projects.unknownProjectText');
	});

	it('has a single show-closed button (both scopes answer showAllToggle)', () => {
		expect(page.match(/label: \$sources\.tasks\.showAllToggle\.label/g)).toHaveLength(1);
	});

	it('no longer asks for a project choice when several are registered', () => {
		expect(page).not.toContain('pick one');
		expect(page).not.toContain('$if: $sources.projects.needsSelection');
	});
});

describe('task detail page (src/dsl-views/task-page.yaml)', () => {
	const page = readFileSync(join(packageDir, 'src/dsl-views/task-page.yaml'), 'utf8');

	it('shows the route warnings (dangling parent, ...) only when there are some', () => {
		expect(page).toContain('$if: $sources.detail.warningText');
		expect(page).toContain('$sources.detail.warningText');
	});
});

/** The views as text: structure checks that catch what the renderer would only show as a blank page. */
const viewsDir = join(packageDir, 'src/dsl-views');
const viewNames = readdirSync(viewsDir).filter(name => name.endsWith('.yaml'));
const view = (name: string): string => readFileSync(join(viewsDir, name), 'utf8');

describe('views: conventions that keep pages rendering', () => {
	it.each(viewNames)(
		'%s: every FieldSelect sits behind an $if (its options.map crashes the whole page while the source loads)',
		name => {
			const lines = view(name).split('\n');
			lines.forEach((line, index) => {
				if (!/\$type: FieldSelect/.test(line)) return;
				// The select itself, or the Form containing it, must be guarded.
				const formIndex = lines
					.slice(0, index)
					.map(l => /\$type: Form\b/.test(l))
					.lastIndexOf(true);
				const selfGuarded = lines.slice(index, index + 3).some(l => l.includes('$if:'));
				const formGuarded =
					formIndex >= 0 && lines.slice(formIndex, formIndex + 3).some(l => l.includes('$if:'));
				expect(selfGuarded || formGuarded, `${name}:${index + 1}`).toBe(true);
			});
		}
	);

	it.each(viewNames)(
		'%s: uses items:, never children:, for containers (the renderer ignores children: silently)',
		name => {
			expect(view(name)).not.toMatch(/^\s*children:/m);
		}
	);

	it.each(viewNames)('%s: every onSubmit names an action declared in the same view', name => {
		const text = view(name);
		const used = [...text.matchAll(/onSubmit: \$ctx\.(\w+)/g)].map(m => m[1]!);
		for (const action of used) {
			expect(text, `${name}: action ${action}`).toMatch(new RegExp(`^    ${action}:`, 'm'));
		}
	});

	it.each(viewNames)(
		'%s: every source and action URL targets the task module; actions send the project already encoded',
		name => {
			const text = view(name);
			for (const [, , url] of text.matchAll(/^\s+url: (GET|POST|DELETE) (\S+)/gm)) {
				expect(url, name).toMatch(/^\/api\/modules\/task\//);
			}
			for (const [, , url] of text.matchAll(/^ {8}url: (POST|DELETE) (\S+)/gm)) {
				expect(url, name).toContain('?project={projectParam}');
			}
		}
	);
});

/** The sources fed by a query the project route leaves EMPTY for an unknown or unreadable project (the source is then skipped). */
function skippableQuerySources(text: string): string[] {
	return [...sourceBlocks(text)]
		.filter(([, block]) => /query: \$source\.projects\.selectedQuery\b/.test(block))
		.map(([name]) => name);
}

describe('views: no source is skipped for a project that cannot be used (stale data stays on screen otherwise)', () => {
	// The shell keeps the last answer of a source it skips. Reproduced in a real browser on the views of ad95014:
	// the Tasks page of an unknown project, "Tasks" in the menu (global list, 6 rows), browser Back to the unknown
	// project: the 6 rows stayed under the "not registered" badge. A source must ask for `blank=true` instead.
	const OLD_TASKS_PAGE_SOURCE = [
		'$sources:',
		'    tasks:',
		'        url: GET /api/modules/task/tasks?{query}&inlineErrors=true',
		'        params:',
		'            query: $source.projects.selectedQuery',
		'            reload: $urlParam.reload',
		'',
	].join('\n');

	it('the check itself catches the pattern that left stale rows on the old views', () => {
		expect(skippableQuerySources(OLD_TASKS_PAGE_SOURCE)).toEqual(['tasks']);
	});

	it.each(viewNames)(
		'%s: its project-scoped sources are fed by scopeQuery or projectQuery, never by a query that can be empty',
		name => {
			expect(skippableQuerySources(view(name)), name).toEqual([]);
		}
	);

	it('the detail and history pages read every source through projectQuery (project, else blank=true)', () => {
		for (const [name, sources] of [
			['task-page.yaml', ['detail', 'tree', 'links']],
			['task-history-page.yaml', ['detail', 'history']],
		] as const) {
			const blocks = sourceBlocks(view(name));
			for (const source of sources) {
				expect(blocks.get(source), `${name}: ${source}`).toContain('query: $source.projects.projectQuery');
			}
		}
	});
});

// Narrow screens: a DataTable cell without nowrap/width/truncate breaks anywhere (`break-all`), so a short code such as
// a task id was cut into one character per line at 390px. The installed shell rebuilds YAML columns from key and label
// only (nowrap, width, mono... are dropped); a shell with dsl-ui >= 2026.10.20 honours them. Marking the columns that
// hold short codes costs nothing before and fixes the wrapping after the shell is upgraded.
describe('views: columns holding short codes never wrap (nowrap)', () => {
	const SHORT_CODE_KEYS = ['id', 'status', 'created', 'time', 'openCount', 'openText', 'totalText'];

	it.each(viewNames)('%s: every id/status/date/count column is nowrap', name => {
		const columns = [...view(name).matchAll(/\{ key: '(\w+)'[^}\n]*\}/g)];
		for (const [column, key] of columns) {
			if (!SHORT_CODE_KEYS.includes(key!)) continue;
			expect(column, `${name}: ${key}`).toContain('nowrap: true');
		}
	});
});

describe('task detail page: forms and links', () => {
	const page = view('task-page.yaml');

	it('wires status, type, labels, metadata, parent and links to their routes', () => {
		for (const route of [
			'POST /api/modules/task/tasks/{id}/status',
			'POST /api/modules/task/tasks/{id}/type',
			'POST /api/modules/task/tasks/{id}/labels',
			'DELETE /api/modules/task/tasks/{id}/labels/{label}',
			'POST /api/modules/task/tasks/{id}/meta',
			'POST /api/modules/task/tasks/{id}/parent',
			'DELETE /api/modules/task/tasks/{id}/parent',
			'POST /api/modules/task/tasks/{id}/links',
			'DELETE /api/modules/task/tasks/{id}/links',
		]) {
			expect(page, route).toContain(route);
		}
	});

	it('shows what the queue did not receive after a status or link change', () => {
		expect(page).toContain('$ctx.statusResult.undeliveredText');
		expect(page).toContain('$ctx.linkResult.undeliveredText');
	});

	it('links to the history page and lists the links, the hierarchy and the metadata', () => {
		expect(page).toContain('$sources.detail.taskHrefs.history');
		expect(page).toContain('GET /api/modules/task/tasks/{id}/links');
		expect(page).toContain('GET /api/modules/task/tree');
		expect(page).toContain('$sources.detail.metaRows');
	});
});

describe('create page', () => {
	const page = view('new-task-page.yaml');

	it('posts to POST /tasks and shows the outcome, the warnings and the link to the new task', () => {
		expect(page).toContain('url: POST /api/modules/task/tasks?project={projectParam}');
		expect(page).toContain('$ctx.created.message');
		expect(page).toContain('$ctx.created.undeliveredText');
		expect(page).toContain('$ctx.created.href');
	});

	it('asks for the project only when several are registered', () => {
		expect(page).toContain('$if: $sources.projects.needsSelection');
	});

	// The last used project is the initial value of the select (forms.create.projectParam, from the route): a problem
	// with the remembered value is shown, not swallowed.
	it('shows why the last used project cannot be preselected, and when a created task could not be remembered', () => {
		expect(page).toMatch(
			/\$if: \$sources\.projects\.lastProjectProblem\n {6}label: \$sources\.projects\.lastProjectProblem\n {6}variant: warning/
		);
		expect(page).toMatch(
			/\$if: \$ctx\.created\.lastProjectWarning\n {6}label: \$ctx\.created\.lastProjectWarning\n {6}variant: warning/
		);
	});
});

describe('delete page', () => {
	const page = view('delete-page.yaml');

	it('previews first and shows the confirm form only once a preview selected something', () => {
		expect(page).toContain('url: POST /api/modules/task/tasks/delete/plan?project={projectParam}');
		expect(page).toContain('$if: $ctx.plan.canConfirm');
		expect(page).toContain('initialData: $ctx.plan.confirmRequest');
	});

	it('shows the outcome of the delete', () => {
		expect(page).toContain('$ctx.plan.deletedText');
	});
});

describe('list pages', () => {
	it('the tasks page links to the creation and deletion pages and offers the filters as links', () => {
		const page = view('tasks-page.yaml');
		expect(page).toContain('$sources.tasks.hrefs.newTask');
		expect(page).toContain('$sources.tasks.hrefs.deleteTasks');
		expect(page).toContain('$sources.tasks.showAllToggle.href');
		expect(page).toContain('$sources.tasks.clearParentHref');
		expect(page).toContain('parent: $urlParam.parent');
	});

	it('the tree page reads GET /tree with the same filters', () => {
		const page = view('tree-page.yaml');
		expect(page).toContain('url: GET /api/modules/task/tree');
		expect(page).toContain('showAll: $urlParam.showAll');
	});

	it('the projects page lists the projects with their open count and problem', () => {
		const page = view('projects-page.yaml');
		expect(page).toContain('url: GET /api/modules/task/projects');
		expect(page).toContain("key: 'openCount'");
		expect(page).toContain("key: 'error'");
	});

	it('the types page adds and removes types through their routes', () => {
		const page = view('types-page.yaml');
		expect(page).toContain('POST /api/modules/task/types?project={projectParam}');
		expect(page).toContain('DELETE /api/modules/task/types/{name}?project={projectParam}');
	});

	it('the history page reads the history route of the task', () => {
		expect(view('task-history-page.yaml')).toContain('GET /api/modules/task/tasks/{id}/history');
	});
});

describe('tree page: global forest without ?project (src/dsl-views/tree-page.yaml)', () => {
	const page = view('tree-page.yaml');

	it('has one tree source for both scopes, fed by scopeQuery (an unknown project asks for the blank answer, so no stale rows stay)', () => {
		const block = sourceBlocks(page).get('tree')!;
		expect(block).toContain('url: GET /api/modules/task/tree?{query}&inlineErrors=true');
		expect(block).toContain('query: $source.projects.scopeQuery');
		expect(block).toContain('reload: $urlParam.reload');
	});

	it('no longer asks for a project choice, shows the scope, the skipped-projects warning and the way back', () => {
		expect(page).not.toContain('needsSelection');
		expect(page).not.toContain('pick one');
		expect(page).toContain('label: $sources.tree.scopeText');
		expect(page).toContain('label: $sources.tree.warning');
		expect(page).toContain('label: All projects');
		expect(page).toContain('label: $sources.projects.unknownProjectText');
	});

	it('shows the project scope as one table with a row click, and the show-closed button once', () => {
		expect(page).toContain('rows: $sources.tree.rows');
		expect(page.match(/label: \$sources\.tree\.showAllToggle\.label/g)).toHaveLength(1);
		expect(page).toContain('$if: $sources.tree.project');
	});

	// The DataTable has no row styling or grouping in the installed shell: a project header row looks like any task
	// row. The route builds one Section per project (name, link, table) and the view renders that list as is.
	it('renders the global forest as the sections the route built, one per project (ExtensionSlot), not as one flat table', () => {
		expect(page).toMatch(
			/- \$type: ExtensionSlot\n {6}\$if: \$sources\.tree\.groups\n {6}items: \$sources\.tree\.groups\n/
		);
		expect(page).not.toContain('$if: $sources.tree.scopeText\n      rows');
	});
});

describe('types page: all projects side by side without ?project (src/dsl-views/types-page.yaml)', () => {
	const page = view('types-page.yaml');

	it('has one types source for both scopes, fed by scopeQuery', () => {
		const block = sourceBlocks(page).get('types')!;
		expect(block).toContain('url: GET /api/modules/task/types?{query}&inlineErrors=true');
		expect(block).toContain('query: $source.projects.scopeQuery');
	});

	// A button in a row also fires the click of the row (the shell does not stop it): a table that navigates on a row
	// click would leave the page the moment the button is pressed. The global table has the button, so no row click.
	it('lists the types with a Project column in the global scope and a Remove button on each removable row (no row click)', () => {
		const table = page.slice(page.indexOf('$if: $sources.types.scopeText\n      rows'));
		const globalTable = table.slice(0, table.indexOf('- $type: DataTable', 10));
		expect(globalTable).not.toContain('navigateTo');
		expect(globalTable).toContain('onAction: $ctx.onAction');
		expect(globalTable).toContain("key: 'projectName'");
		expect(globalTable).toContain("key: 'typeText'");
		expect(globalTable.indexOf("key: 'projectName'")).toBeLessThan(globalTable.indexOf("key: 'typeText'"));
		expect(globalTable).toContain('type: actions');
		expect(globalTable).toContain('action: pickRemove');
		expect(globalTable).toContain('condition: canRemove');
		expect(page).toContain('label: $sources.types.warning');
	});

	it('removes from the global table without a cascading select: the row button picks the row, a confirm names it and submits it', () => {
		// No URL: the shell only stores the clicked row under the resultKey, and the confirm form takes it as its data.
		expect(page).toMatch(/\n {4}pickRemove:\n {8}resultKey: typeResult\n/);
		expect(page).toContain('$if: $ctx.typeResult.confirmText');
		expect(page).toContain('label: $ctx.typeResult.confirmText');
		expect(page).toMatch(/onSubmit: \$ctx\.removeType\n {6}initialData: \$ctx\.typeResult\n/);
		// removeType publishes under the same key: its answer replaces the picked row, so the confirm goes away.
		expect(page).toMatch(/\n {4}removeType:\n {8}url: DELETE [^\n]*\n {8}resultKey: typeResult\n/);
	});

	it('adds to a project chosen in the form (no default); inside a project the type to remove is still chosen in a select', () => {
		expect(page).toMatch(
			/\$type: FieldSelect\n {12}\$if: \$sources\.types\.projectOptions\n {12}label: Project\n {12}bind: projectParam/
		);
		expect(page).toContain('options: $sources.types.projectOptions');
		expect(page).toContain('placeholder: Choose a project');
		expect(page).toMatch(/\$if: \$sources\.types\.restricted\n {6}onSubmit: \$ctx\.removeType/);
	});

	it('no longer asks for a project choice, and says which project it shows', () => {
		expect(page).not.toContain('needsSelection');
		expect(page).toContain('label: $sources.projects.unknownProjectText');
		expect(page).toContain('label: $sources.types.projectText');
	});
});

describe('new task and delete pages: an explicit project selector', () => {
	it('the new task page lists only readable projects (projectOptions), asks for the blank answer without a project', () => {
		const page = view('new-task-page.yaml');
		expect(sourceBlocks(page).get('tasks')).toContain('query: $source.projects.projectQuery');
		expect(page).toContain('options: $sources.projects.projectOptions');
		expect(page).toContain('label: $sources.projects.selectedText');
	});

	it('the delete page names the project in the preview and at the confirm button, and stays per project', () => {
		const page = view('delete-page.yaml');
		expect(page).toContain('options: $sources.projects.projectOptions');
		expect(page).toContain('placeholder: Choose a project');
		expect(page).toContain('label: $ctx.plan.projectText');
		expect(page).toContain('label: $ctx.plan.confirmLabel');
		expect(page).not.toContain('allProjects=true');
		expect(page).not.toContain('globalHrefs');
		expect(page).toContain('label: $sources.projects.selectedText');
	});
});

describe('views: "All projects" leads back from every per-project page when several projects are registered', () => {
	it.each([
		['tasks-page.yaml', '$sources.projects.allProjectsHref'],
		['tree-page.yaml', '$sources.projects.globalHrefs.tree'],
		['types-page.yaml', '$sources.projects.globalHrefs.types'],
		['new-task-page.yaml', '$sources.projects.allProjectsHref'],
		['delete-page.yaml', '$sources.projects.allProjectsHref'],
		['task-page.yaml', '$sources.projects.allProjectsHref'],
		['task-history-page.yaml', '$sources.projects.allProjectsHref'],
	])('%s links to %s', (name, target) => {
		const text = view(name);
		expect(text, name).toContain(`to: ${target}`);
		expect(text, name).toContain(`$if: ${target}`);
		expect(text, name).toContain('label: All projects');
	});

	it('the tasks page shows the error of its source once', () => {
		expect(view('tasks-page.yaml').match(/label: \$sources\.tasks\.errorText/g)).toHaveLength(1);
	});
});

/** The `$sources:` blocks of a view: name -> its lines. */
function sourceBlocks(text: string): Map<string, string> {
	const blocks = new Map<string, string>();
	const lines = text.split('\n');
	let inSources = false;
	let current: string | undefined;
	for (const line of lines) {
		if (/^\$sources:/.test(line)) {
			inSources = true;
			continue;
		}
		if (inSources && /^\S/.test(line)) break;
		const start = /^ {4}(\w+):\s*$/.exec(line);
		if (inSources && start) {
			current = start[1]!;
			blocks.set(current, '');
		} else if (inSources && current !== undefined) {
			blocks.set(current, `${blocks.get(current)}${line}\n`);
		}
	}
	return blocks;
}

describe('views: feedback and refresh conventions found by driving the pages in a real browser', () => {
	it.each(viewNames)(
		'%s: a source that waits for another one also names a $urlParam, else the shell does not reload it when the URL changes (filters, project choice did nothing until F5)',
		name => {
			for (const [source, block] of sourceBlocks(view(name))) {
				if (!block.includes('$source.')) continue;
				expect(block, `${name}: source ${source}`).toMatch(/: \$urlParam\.\w+/);
			}
		}
	);

	it.each(viewNames)(
		'%s: every action opts in to inline errors, publishes its answer and shows errorText (a failed action is otherwise invisible)',
		name => {
			const text = view(name);
			const actions = text.match(/^\$actions:\n((?: {4}.*\n|\n)+)/m)?.[1];
			if (actions === undefined) return;
			// A comment above the first action is not an action.
			const blocks = actions
				.split(/^ {4}(?=\w+:\s*$)/m)
				.filter(block => block.replace(/^\s*#.*$/gm, '').trim() !== '');
			expect(blocks.length, name).toBeGreaterThan(0);
			for (const block of blocks) {
				const actionName = block.split(':')[0]!;
				// `pick*` is a row button: with no URL the shell only stores the clicked row under its resultKey (no request).
				const isRowPick = actionName.startsWith('pick') && !block.includes('url:');
				if (!isRowPick) {
					expect(block, `${name}: ${actionName}`).toMatch(/url: (POST|DELETE) \S+&inlineErrors=true/);
				}
				const key = /resultKey: (\w+)/.exec(block)?.[1];
				expect(key, `${name}: ${actionName} needs a resultKey`).toBeDefined();
				expect(text, `${name}: ${actionName}`).toContain(`$ctx.${key}.errorText`);
			}
		}
	);

	it('the detail and history pages ask for inline errors on the task they read, and show them', () => {
		for (const name of ['task-page.yaml', 'task-history-page.yaml']) {
			const text = view(name);
			expect(text, name).toMatch(/url: GET \/api\/modules\/task\/tasks\/\{id\}\?\{query\}&inlineErrors=true/);
			expect(text, name).toContain('$sources.detail.errorText');
		}
	});

	it.each(['tasks-page.yaml', 'tree-page.yaml', 'types-page.yaml', 'task-page.yaml', 'task-history-page.yaml'])(
		'%s: tells why the selected project cannot be read instead of staying blank',
		name => {
			expect(view(name)).toContain('$sources.projects.selectedProblem');
		}
	);

	it('the selects that remove an item start on a placeholder: choosing the only option must count as a change', () => {
		for (const [name, label] of [
			['task-page.yaml', 'Label to remove'],
			['types-page.yaml', 'Type to remove'],
		] as const) {
			const lines = view(name).split('\n');
			const at = lines.findIndex(line => line.includes(`label: ${label}`));
			expect(at, `${name}: ${label}`).toBeGreaterThan(-1);
			expect(lines.slice(at, at + 8).join('\n'), `${name}: ${label}`).toContain('placeholder:');
		}
	});

	it('the detail page names the project, and detaches a task whose parent is dangling', () => {
		const page = view('task-page.yaml');
		expect(page).toContain('$sources.detail.projectText');
		expect(page).toContain('$if: $sources.detail.canDetach');
	});

	it('the list pages show the project name apart from their header (a header with actions drops its subtitle)', () => {
		expect(view('tasks-page.yaml')).toContain('$sources.tasks.projectText');
		expect(view('tree-page.yaml')).toContain('$sources.tree.projectText');
	});

	it('the tables use the display texts of the routes: truncated titles and short dates', () => {
		expect(view('tasks-page.yaml')).toContain("key: 'titleText'");
		expect(view('tasks-page.yaml')).toContain("key: 'created'");
		expect(view('task-page.yaml')).toContain("key: 'titleText'");
		expect(view('task-history-page.yaml')).toContain('$sources.history.rows');
		expect(view('task-history-page.yaml')).toContain("key: 'time'");
	});

	it('the delete page clears the preview and the confirm button once the delete ran (both answers share the plan state)', () => {
		const page = view('delete-page.yaml');
		expect(page).toMatch(/deleteTasks:\n {8}url: .*\n {8}resultKey: plan\b/);
		expect(page).toContain('$if: $ctx.plan.previewText');
		expect(page).toContain('$ctx.plan.deletedText');
	});

	it('the create and delete pages link back to the tasks', () => {
		for (const name of ['new-task-page.yaml', 'delete-page.yaml']) {
			expect(view(name), name).toContain('$sources.projects.tasksHref');
		}
	});
});

describe('views: a failing source blanks the whole page', () => {
	it.each(viewNames)(
		'%s: every source but projects asks for inline errors (one failure discards the answers of all the others)',
		name => {
			const text = view(name);
			for (const [source, block] of sourceBlocks(text)) {
				if (source === 'projects') continue;
				expect(block, `${name}: source ${source}`).toContain('inlineErrors=true');
			}
			for (const [, , url] of text.matchAll(/^ {8}url: (GET) (\S+)/gm)) {
				if (url!.endsWith('/projects')) continue;
				expect(url, name).toMatch(/inlineErrors=true$/);
			}
		}
	);

	it.each([
		['tasks-page.yaml', 'tasks'],
		['tree-page.yaml', 'tree'],
		['types-page.yaml', 'types'],
		['new-task-page.yaml', 'tasks'],
		['task-page.yaml', 'detail'],
		['task-history-page.yaml', 'detail'],
		['tasks-widget.yaml', 'summary'],
	])('%s: shows the error of its %s source', (name, source) => {
		expect(view(name)).toContain(`$sources.${source}.errorText`);
	});
});

describe('views: nothing registered yet', () => {
	it.each(viewNames.filter(name => name !== 'tasks-widget.yaml'))(
		'%s: shows the welcome text (the route gives it) instead of a blank page or a dead form',
		name => {
			const text = view(name);
			expect(text, name).toContain('$sources.projects.noProjects');
			expect(text, name).toContain('label: $sources.projects.noProjectsText');
		}
	);

	it('the widget shows its figures only when a project was counted, the error alone otherwise', () => {
		const text = view('tasks-widget.yaml');
		expect(text).toContain('$if: $sources.summary.projectCount');
		expect(text).toContain('$sources.summary.errorText');
		expect(text).toContain('$if: $sources.summary.noProjects');
		expect(text).toContain('label: $sources.summary.noProjectsText');
	});
});
