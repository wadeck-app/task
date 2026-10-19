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
		expect(widget).toContain('$sources.summary.rows');
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
			const blocks = actions.split(/^ {4}(?=\w+:\s*$)/m).filter(block => block.trim() !== '');
			expect(blocks.length, name).toBeGreaterThan(0);
			for (const block of blocks) {
				const actionName = block.split(':')[0];
				expect(block, `${name}: ${actionName}`).toMatch(/url: (POST|DELETE) \S+&inlineErrors=true/);
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

	it('tree and types pages offer the projects to pick from when several are registered', () => {
		for (const name of ['tree-page.yaml', 'types-page.yaml']) {
			const text = view(name);
			expect(text, name).toContain('$if: $sources.projects.needsSelection');
			expect(text, name).toContain('rows: $sources.projects.projects');
		}
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
	});
});
