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

	it('keeps the id task-cli registers it as (task-cli/src/AppCoreRegistration.ts APP_CORE_MODULE_ID)', () => {
		const registration = readFileSync(join(packageDir, '../task-cli/src/AppCoreRegistration.ts'), 'utf8');
		expect(registration).toContain(`APP_CORE_MODULE_ID = '${String(manifest.id)}'`);
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
		expect(widget).toContain('$sources.summary.warning');
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
		expect(page).toContain('$ctx.deleted.summary');
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
