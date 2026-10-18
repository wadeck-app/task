import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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

	it('contributes a dashboard widget, a nav page at /tasks and a route-slot detail page at /tasks/:id', () => {
		const summary = manifest.extensionPoints.map(p => `${p.kind}:${p.slot}:${p.path ?? ''}`);
		expect(summary).toEqual(['widget:dashboard:', 'page:nav:/tasks', 'page:route:/tasks/:id']);
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
