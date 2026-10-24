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
			'page:route:/tasks/new',
			'page:route:/tasks/delete',
			'page:route:/tasks/p/:project',
			'page:route:/tasks/p/:project/:id',
			'page:route:/tasks/p/:project/:id/history',
			'page:route:/tasks/p/:project/new',
			'page:route:/tasks/p/:project/delete',
			'page:route:/tree/p/:project',
			'page:route:/types/p/:project',
		]);
	});

	it('shares a view only between a global page and its per-project twin, and references every view file of src/dsl-views', () => {
		const byView = new Map<string, string[]>();
		for (const p of manifest.extensionPoints) {
			const name = p.view.value.replace('./src/dsl-views/', '');
			byView.set(name, [...(byView.get(name) ?? []), p.path ?? '']);
		}
		const shared = [...byView].filter(([, paths]) => paths.length > 1);
		expect(Object.fromEntries(shared)).toEqual({
			'tasks-page.yaml': ['/tasks', '/tasks/p/:project'],
			'tree-page.yaml': ['/tree', '/tree/p/:project'],
			'types-page.yaml': ['/types', '/types/p/:project'],
			'new-task-page.yaml': ['/tasks/new', '/tasks/p/:project/new'],
			'delete-page.yaml': ['/tasks/delete', '/tasks/p/:project/delete'],
		});
		expect([...byView.keys()].sort()).toEqual(readdirSync(join(packageDir, 'src/dsl-views')).sort());
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

	it('shows the skipped-projects warning and the error of the global list', () => {
		expect(page).toContain('label: $sources.tasks.warning');
		expect(page).toContain('label: $sources.tasks.errorText');
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
			// The registry actions of the Projects page (add, edit, remove) act on no project: they carry none.
			for (const [, , url] of text.matchAll(/^ {8}url: (POST|DELETE) (\S+)/gm)) {
				if (url!.startsWith('/api/modules/task/projects')) continue;
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
		expect(page).toContain("key: 'openText'");
		expect(page).toContain("key: 'problemText'");
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

	it('no longer asks for a project choice, shows the scope and the skipped-projects warning', () => {
		expect(page).not.toContain('needsSelection');
		expect(page).not.toContain('pick one');
		expect(page).toContain('label: $sources.tree.scopeText');
		expect(page).toContain('label: $sources.tree.warning');
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
		expect(page).toContain('label: $sources.projects.selectedText');
	});
});

describe('views: the project of a page comes from its address (the breadcrumb keeps path parameters, drops the query)', () => {
	// Verified in a real browser (app-core-cli 2026.10.22-075): a crumb links to the current address up to its page, with
	// path parameters substituted and the query dropped. `?project=` was lost by every crumb.
	// The Projects page manages the registry: it has no project.
	it.each(viewNames.filter(name => name !== 'projects-page.yaml'))(
		'%s: reads the project from $route.project, never from $urlParam.project',
		name => {
			const text = view(name);
			expect(text, name).not.toContain('$urlParam.project');
			for (const [source, block] of sourceBlocks(text)) {
				if (block.includes('/api/modules/task/projects')) {
					expect(block, `${name}: ${source}`).toContain('project: $route.project');
				}
			}
		}
	);

	// A bookmarked address of a project that was removed since must say so: the crumbs still read, the page may not be blank.
	it.each(['task-page.yaml', 'task-history-page.yaml', 'new-task-page.yaml', 'delete-page.yaml'])(
		'%s: says when the project of the address is not registered (a stale address is not a blank page)',
		name => {
			const text = view(name);
			expect(text, name).toMatch(
				/\$if: \$sources\.projects\.unknownProjectText\n\s+label: \$sources\.projects\.unknownProjectText\n\s+variant: danger/
			);
		}
	);

	it('every per-project page address starts with its section and the project segment', () => {
		const withProject = manifest.extensionPoints.filter(p => p.path?.includes(':project'));
		expect(withProject.length).toBeGreaterThan(0);
		for (const point of withProject) {
			expect(point.path, point.path).toMatch(/^\/(tasks|tree|types)\/p\/:project(\/|$)/);
			expect(point.path?.match(/:project/g), point.path).toHaveLength(1);
		}
		// The pages that need a project, other than the ones that choose it in a form, are all below a project segment.
		const withoutProject = manifest.extensionPoints.filter(p => p.kind === 'page' && !p.path?.includes(':project'));
		expect(withoutProject.map(p => p.path)).toEqual([
			'/tasks',
			'/tree',
			'/projects',
			'/types',
			'/tasks/new',
			'/tasks/delete',
		]);
	});
});

/**
 * The trail the shell builds for an address (navHelpers.ts breadcrumbFor/routeChain of app-core's frontend-shell, read
 * and confirmed in a browser): the module crumb, the menu page the address is below, then every page whose address is
 * the start of the current one, each linking to the current address up to it. A page ending with a parameter shows its
 * value; at one depth the page with the fewest parameters wins.
 */
function trailOf(pathname: string): Array<{ label: string; href?: string }> {
	const base = '/modules/task';
	const segmentsOf = (p: string): string[] => p.split('/').filter(Boolean);
	const url = segmentsOf(pathname.slice(base.length));
	const pages = manifest.extensionPoints.filter(p => p.kind === 'page') as unknown as Array<{
		slot: string;
		path: string;
		label: string;
	}>;
	const trail: Array<{ label: string; href?: string }> = [{ label: 'Task', href: `${base}${pages[0]!.path}` }];
	const menu = pages.find(p => p.slot === 'nav' && url[0] === p.path.slice(1) && url.length >= 1);
	if (menu !== undefined) trail.push({ label: menu.label, href: `${base}${menu.path}` });
	const best = new Map<number, { label: string; href: string; params: number }>();
	for (const page of pages) {
		const parts = segmentsOf(page.path);
		if (parts.length > url.length) continue;
		const matches = parts.every((part, i) => part.startsWith(':') || part === url[i]);
		if (!matches) continue;
		const last = parts[parts.length - 1]!;
		const label = last.startsWith(':') ? `${page.label} ${decodeURIComponent(url[parts.length - 1]!)}` : page.label;
		const params = parts.filter(part => part.startsWith(':')).length;
		const known = best.get(parts.length);
		if (known === undefined || params < known.params) {
			best.set(parts.length, { label, href: `${base}/${url.slice(0, parts.length).join('/')}`, params });
		}
	}
	for (const [, crumb] of [...best].sort((a, b) => a[0] - b[0])) {
		if (!trail.slice(1).some(c => c.href === crumb.href)) trail.push({ label: crumb.label, href: crumb.href });
	}
	delete trail[trail.length - 1]!.href;
	return trail;
}

describe('breadcrumb: every crumb of a per-project page keeps the project', () => {
	const slug = 'alpha~1a2b3c';
	const project = `/modules/task/tasks/p/${slug}`;

	it.each([
		[
			'/modules/task/tasks/p/alpha~1a2b3c/abc/history',
			['Task', 'Tasks', 'Project alpha~1a2b3c', 'Task abc', 'Task history'],
		],
		['/modules/task/tasks/p/alpha~1a2b3c/abc', ['Task', 'Tasks', 'Project alpha~1a2b3c', 'Task abc']],
		['/modules/task/tasks/p/alpha~1a2b3c/new', ['Task', 'Tasks', 'Project alpha~1a2b3c', 'New task']],
		['/modules/task/tasks/p/alpha~1a2b3c/delete', ['Task', 'Tasks', 'Project alpha~1a2b3c', 'Delete tasks']],
		['/modules/task/tasks/p/alpha~1a2b3c', ['Task', 'Tasks', 'Project alpha~1a2b3c']],
		['/modules/task/tree/p/alpha~1a2b3c', ['Task', 'Tree', 'Project alpha~1a2b3c']],
		['/modules/task/types/p/alpha~1a2b3c', ['Task', 'Types', 'Project alpha~1a2b3c']],
		['/modules/task/tasks/new', ['Task', 'Tasks', 'New task']],
		['/modules/task/tasks/delete', ['Task', 'Tasks', 'Delete tasks']],
	])('%s reads %j', (pathname, labels) => {
		expect(trailOf(pathname).map(c => c.label)).toEqual(labels);
	});

	it('links the crumbs below the project to addresses that hold the project segment', () => {
		const trail = trailOf(`${project}/abc/history`);
		expect(trail.map(c => c.href)).toEqual([
			'/modules/task/tasks',
			'/modules/task/tasks',
			project,
			`${project}/abc`,
			undefined,
		]);
	});

	it('the only crumbs without the project lead to global pages that need none (the module and the section)', () => {
		for (const pathname of [
			`${project}/abc/history`,
			`${project}/new`,
			`${project}/delete`,
			`/modules/task/tree/p/${slug}`,
			`/modules/task/types/p/${slug}`,
		]) {
			const without = trailOf(pathname)
				.slice(0, -1)
				.filter(c => !c.href?.includes(slug));
			expect(
				without.map(c => c.label),
				pathname
			).toEqual([
				'Task',
				pathname.includes('/tree/') ? 'Tree' : pathname.includes('/types/') ? 'Types' : 'Tasks',
			]);
		}
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
					expect(block, `${name}: ${actionName}`).toMatch(/url: (POST|DELETE) \S+[?&]inlineErrors=true/);
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
				// The projects source itself (it only lists the registry; the Projects page adds page=projects).
				if (/\/projects(\?page=projects)?$/.test(url!)) continue;
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

describe('projects page: add, edit and remove projects (src/dsl-views/projects-page.yaml)', () => {
	const page = view('projects-page.yaml');
	const actionBlock = (name: string): string => {
		const start = page.indexOf(`\n    ${name}:`);
		expect(start, `action ${name}`).toBeGreaterThan(-1);
		const rest = page.slice(start + 1);
		const next = rest.slice(1).search(/\n {4}\w+:|\n\S/);
		return next < 0 ? rest : rest.slice(0, next + 1);
	};
	const sectionBlock = (marker: string): string => {
		const start = page.indexOf(marker);
		expect(start, marker).toBeGreaterThan(-1);
		const rest = page.slice(start);
		const next = rest.slice(1).search(/\n {4}- \$type:/);
		return next < 0 ? rest : rest.slice(0, next + 1);
	};

	it('submits the three registry actions to their routes with inline errors, each under its own result key, and reloads the lists', () => {
		const expected = [
			['addProject', 'POST /api/modules/task/projects?inlineErrors=true', 'addResult'],
			['relocateProject', 'POST /api/modules/task/projects/relocate?inlineErrors=true', 'editResult'],
			['removeProject', 'POST /api/modules/task/projects/remove?inlineErrors=true', 'removeResult'],
		] as const;
		for (const [action, url, key] of expected) {
			const block = actionBlock(action);
			expect(block, action).toContain(`url: ${url}`);
			expect(block, action).toContain(`resultKey: ${key}`);
			expect(block, action).toMatch(/reloadSources: (true|\[projects\])/);
		}
	});

	it('picks a row with URL-less row actions (the installed shell stores the clicked row under the result key)', () => {
		for (const [action, key] of [
			['pickEdit', 'editResult'],
			['pickRemove', 'removeResult'],
		] as const) {
			const block = actionBlock(action);
			expect(block, action).toContain(`resultKey: ${key}`);
			expect(block, action).not.toContain('url:');
		}
	});

	it('the table has Edit and Remove buttons and NO row click (a button inside a row also fires the row click)', () => {
		const table = sectionBlock('- $type: DataTable');
		expect(table).not.toContain('navigateTo');
		expect(table).toContain('onAction: $ctx.onAction');
		expect(table).toContain('rows: $sources.projects.manageRows');
		expect(table).toMatch(/label: 'Edit'[^}]*action: pickEdit/);
		expect(table).toMatch(/label: 'Remove'[^}]*action: pickRemove/);
	});

	it('shows Edit and Remove prominently (primary / filled danger) on a project that cannot be read', () => {
		const table = sectionBlock('- $type: DataTable');
		expect(table).toMatch(/label: 'Edit'[^}]*variant: default[^}]*condition: needsRepair/);
		expect(table).toMatch(/label: 'Remove'[^}]*variant: danger[^}]*condition: needsRepair/);
		expect(table).toMatch(/label: 'Remove'[^}]*variant: danger-outline[^}]*condition: '!needsRepair'/);
	});

	it('links the readable projects to their tasks through a slot of route-built links', () => {
		expect(page).toMatch(
			/\$type: ExtensionSlot\n\s+\$if: \$sources\.projects\.hasOpenLinks\n\s+items: \$sources\.projects\.openLinks/
		);
	});

	it('the add form is NOT gated by forms/noProjects: the zero-project page offers it directly', () => {
		const form =
			sectionBlock('onSubmit: $ctx.addProject').length > 0
				? page.slice(page.lastIndexOf('- $type: Form', page.indexOf('onSubmit: $ctx.addProject')))
				: '';
		const head = form.split('fields:')[0]!;
		expect(head).not.toContain('$sources.projects.forms');
		expect(head).not.toContain('noProjects');
		expect(head).toContain('initialData: $sources.addDefaults.projectForm');
		expect(form).toContain('bind: path');
		expect(form).toContain('bind: mode');
		expect(form).toContain('options: $sources.addDefaults.modeOptions');
		expect(form).toContain('bind: createDirectory');
	});

	it('the edit form is given the picked row, asks for the new directory, and stays visible after a refusal', () => {
		const form = page.slice(page.lastIndexOf('- $type: Form', page.indexOf('onSubmit: $ctx.relocateProject')));
		expect(form).toContain('$if: $ctx.editResult.editPrompt');
		expect(form).toContain('initialData: $ctx.editResult');
		expect(form).toContain('bind: to');
		expect(page).toContain('label: $ctx.editResult.editPrompt');
	});

	it('the remove step says what it does, then confirms with a danger button given the picked row', () => {
		expect(page).toContain('label: $ctx.removeResult.confirmText');
		const form = page.slice(page.lastIndexOf('- $type: Form', page.indexOf('onSubmit: $ctx.removeProject')));
		expect(form).toContain('$if: $ctx.removeResult.confirmText');
		expect(form).toContain('initialData: $ctx.removeResult');
		expect(form).toContain('label: $ctx.removeResult.confirmLabel');
		expect(form).toContain('variant: danger');
		expect(page).toContain('stay on disk');
	});

	it('shows the failure of each action in a danger badge and the success message in a success badge', () => {
		for (const key of ['addResult', 'editResult', 'removeResult']) {
			const danger = `\\$if: \\$ctx\\.${key}\\.errorText\\n\\s+label: \\$ctx\\.${key}\\.errorText\\n\\s+variant: danger`;
			const success = `\\$if: \\$ctx\\.${key}\\.messageText\\n\\s+label: \\$ctx\\.${key}\\.messageText\\n\\s+variant: success`;
			expect(page, key).toMatch(new RegExp(danger));
			expect(page, key).toMatch(new RegExp(success));
		}
		expect(page).toContain('label: $sources.projects.attentionText');
	});
});

describe('projects page: a refused add keeps the typed values', () => {
	const page = view('projects-page.yaml');

	it('feeds the add form from its own source and reloads only the table source after an add (a reloaded initialData resets the form)', () => {
		const blocks = sourceBlocks(page);
		expect([...blocks.keys()]).toEqual(['projects', 'addDefaults']);
		expect(blocks.get('addDefaults')).toContain('url: GET /api/modules/task/projects');
		expect(page).toContain('initialData: $sources.addDefaults.projectForm');
		expect(page).toContain('options: $sources.addDefaults.modeOptions');
		expect(page).toMatch(/addProject:\n {8}url: [^\n]+\n {8}resultKey: addResult\n {8}reloadSources: \[projects\]/);
	});
});

/** The links of a view (BackLink and ButtonLink nodes): the `to:` and `label:` found right under each `$type`. */
function linkNodes(text: string): Array<{ type: string; to: string; label: string; line: number }> {
	const lines = text.split('\n');
	const found: Array<{ type: string; to: string; label: string; line: number }> = [];
	lines.forEach((line, index) => {
		const type = /\$type: (BackLink|ButtonLink)\b/.exec(line)?.[1];
		if (type === undefined) return;
		let to = '';
		let label = '';
		for (const next of lines.slice(index + 1, index + 8)) {
			if (/\$type:/.test(next)) break;
			to = /^\s*to: (.+)$/.exec(next)?.[1] ?? to;
			label = /^\s*label: (.+)$/.exec(next)?.[1] ?? label;
		}
		found.push({ type, to, label, line: index + 1 });
	});
	return found;
}

describe('views: no link whose purpose is going back (the breadcrumb carries the navigation context)', () => {
	// The trail of every page keeps the project (path segment), so a link to a parent or to the global scope is a second
	// way to do what a crumb does. A link stays only when it goes somewhere the trail cannot represent AND is a feature.
	const KEPT: Record<string, Array<{ label: string; to: string }>> = {
		'delete-page.yaml': [],
		'new-task-page.yaml': [{ label: 'Open the new task', to: '$ctx.created.href' }],
		'task-history-page.yaml': [],
		// History and Children are features of the task (forward), not a way back.
		'task-page.yaml': [
			{ label: 'History', to: '$sources.detail.taskHrefs.history' },
			{ label: 'Children', to: '$sources.detail.taskHrefs.childrenList' },
		],
		'tasks-page.yaml': [
			{ label: 'New task', to: '$sources.tasks.hrefs.newTask' },
			{ label: '$sources.tasks.showAllToggle.label', to: '$sources.tasks.showAllToggle.href' },
			{ label: 'Delete tasks', to: '$sources.tasks.hrefs.deleteTasks' },
			{ label: 'Clear the filter', to: '$sources.tasks.clearParentHref' },
		],
		'tree-page.yaml': [{ label: '$sources.tree.showAllToggle.label', to: '$sources.tree.showAllToggle.href' }],
		'types-page.yaml': [],
		'projects-page.yaml': [],
		'tasks-widget.yaml': [],
	};

	it('the allowlist names every view', () => {
		expect(Object.keys(KEPT).sort()).toEqual([...viewNames].sort());
	});

	it.each(viewNames)('%s: every link is a feature of the page, none leads back', name => {
		const links = linkNodes(view(name)).map(({ label, to }) => ({ label, to }));
		expect(links).toEqual(KEPT[name]);
	});

	it.each(viewNames)('%s: no BackLink, no "Back to ...", no "All projects"/"All tasks"', name => {
		const text = view(name);
		expect(text, name).not.toMatch(/\$type: BackLink\b/);
		for (const link of linkNodes(text)) {
			expect(link.label, `${name}:${link.line}`).not.toMatch(/^(Back\b|All (projects|tasks)\b)/i);
		}
		for (const gone of ['allProjectsHref', 'globalHrefs', 'tasksHref', 'taskHrefs.detail', 'detail.hrefs.tasks']) {
			expect(text, `${name}: ${gone}`).not.toContain(gone);
		}
	});
});

describe('projects page: its welcome text does not send the user to itself', () => {
	it('both sources ask GET /projects with page=projects (the route then points at the form below)', () => {
		const blocks = sourceBlocks(view('projects-page.yaml'));
		for (const source of ['projects', 'addDefaults']) {
			expect(blocks.get(source), source).toMatch(
				/url: GET \/api\/modules\/task\/projects\?(\S*&)?page=projects(&\S*)?$/m
			);
		}
	});

	it('no other page asks page=projects (they keep the pointer to the Projects menu)', () => {
		for (const name of viewNames.filter(n => n !== 'projects-page.yaml')) {
			expect(view(name), name).not.toContain('page=projects');
		}
	});
});

describe('manifest: the labels the breadcrumb shows (app-core-cli >= 2026.10.19-063 names each crumb after the page label)', () => {
	it('gives every page a label (a page without one is named after its address)', () => {
		for (const point of manifest.extensionPoints.filter(p => p.kind === 'page')) {
			expect((point as { label?: string }).label, point.path).toMatch(/\S/);
		}
	});

	it('reads as one trail: Task > Tasks > Project <slug> > Task <id> > Task history, Task > Tasks > New task', () => {
		const labels = Object.fromEntries(
			manifest.extensionPoints.filter(p => p.kind === 'page').map(p => [p.path, (p as { label?: string }).label])
		);
		expect(labels).toMatchObject({
			'/tasks': 'Tasks',
			'/tasks/p/:project': 'Project',
			'/tasks/p/:project/:id': 'Task',
			'/tasks/p/:project/:id/history': 'Task history',
			'/tasks/p/:project/new': 'New task',
			'/tasks/p/:project/delete': 'Delete tasks',
			'/tasks/new': 'New task',
			'/tasks/delete': 'Delete tasks',
			'/tree/p/:project': 'Project',
			'/types/p/:project': 'Project',
		});
	});
});

// A mutating route that produces queue events answers `undeliveredText`: the page that fires it must show it where the
// user is looking (the answer is kept under the action's resultKey). A route that emits nothing is listed here, so a NEW
// mutating action fails this test until it either shows the text or is declared event-free on purpose.
describe('views: every mutating action that produces queue events shows what the queue did not receive', () => {
	const EVENT_FREE_URLS = [
		// The delete preview deletes nothing.
		'/api/modules/task/tasks/delete/plan',
		// Project types and the project registry are not task changes.
		'/api/modules/task/types',
		'/api/modules/task/projects',
	];

	function actionsOf(text: string): Array<{ name: string; url: string; key: string }> {
		const section = /^\$actions:\n((?: {4}.*\n|\n)+)/m.exec(text)?.[1];
		if (section === undefined) return [];
		return section
			.split(/^ {4}(?=\w+:\s*$)/m)
			.filter(block => block.replace(/^\s*#.*$/gm, '').trim() !== '')
			.map(block => ({
				name: block.split(':')[0]!,
				url: /url: (?:POST|DELETE) (\S+)/.exec(block)?.[1] ?? '',
				key: /resultKey: (\w+)/.exec(block)?.[1] ?? '',
			}))
			.filter(action => action.url !== '');
	}

	const mutating = viewNames.flatMap(name =>
		actionsOf(view(name))
			.filter(action => !EVENT_FREE_URLS.some(free => action.url.startsWith(free)))
			.map(action => ({ page: name, ...action }))
	);

	it('finds the mutating actions of the task, create and delete pages', () => {
		expect(mutating.map(action => `${action.page}:${action.name}`).sort()).toEqual([
			'delete-page.yaml:deleteTasks',
			'new-task-page.yaml:createTask',
			'task-page.yaml:addLabel',
			'task-page.yaml:addLink',
			'task-page.yaml:removeLabel',
			'task-page.yaml:removeLink',
			'task-page.yaml:removeParent',
			'task-page.yaml:setMeta',
			'task-page.yaml:setParent',
			'task-page.yaml:setStatus',
			'task-page.yaml:setType',
		]);
	});

	it.each(mutating.map(action => [`${action.page}:${action.name}`, action] as const))(
		'%s: a warning badge is bound to its answer',
		(_label, action) => {
			const text = view(action.page);
			const bound = `$ctx.${action.key}.undeliveredText`.replace(/[$.]/g, String.raw`\$&`);
			expect(text, `${action.page}: ${action.name}`).toMatch(
				new RegExp(String.raw`- \$type: Badge\n\s+\$if: ${bound}\n\s+label: ${bound}\n\s+variant: warning`)
			);
		}
	);
});

describe('shared project registry (stage 1): the views say which projects are not in it', () => {
	it('the Projects page has a Registry column and a warning badge bound to registryNotice', () => {
		const page = readFileSync(join(packageDir, 'src/dsl-views/projects-page.yaml'), 'utf8');
		expect(page).toContain("{ key: 'registryText', label: 'Registry' }");
		expect(page).toMatch(
			/\$if: \$sources\.projects\.registryNotice\n\s+label: \$sources\.projects\.registryNotice\n\s+variant: warning/
		);
	});

	it('the dashboard widget shows the same notice in a warning badge', () => {
		const widget = readFileSync(join(packageDir, 'src/dsl-views/tasks-widget.yaml'), 'utf8');
		expect(widget).toMatch(
			/\$if: \$sources\.summary\.registryNotice\n\s+label: \$sources\.summary\.registryNotice\n\s+variant: warning/
		);
	});
});
