// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComponentRegistryEntry } from '@wadeck-app/dsl-renderer';
import { OUT_DIR_VAR } from './out-dir.js';

/*
 * What app-core does with a module's dsl-lib: set the shared packages on a global, import the bundle, register its
 * entries. This does the same with the real packages, because a bundle can pass every unit test of its sources and
 * still break once built: a second copy of React, a config module duplicated between the components and the entry
 * that configures them.
 */
let outDir: string;
let entries: ComponentRegistryEntry[];
let bundleSource: string;

beforeAll(async () => {
	const built = process.env[OUT_DIR_VAR];
	if (built === undefined) {
		throw new Error(
			`${OUT_DIR_VAR} is not set: the bundle is packaged by global-setup.ts, check that vitest.config.ts still lists it.`
		);
	}
	outDir = built;
	bundleSource = fs.readFileSync(path.join(outDir, 'dsl-lib', 'entries.mjs'), 'utf8');

	(globalThis as Record<string, unknown>).__APP_CORE_SHARED__ = {
		react: await import('react'),
		'react/jsx-runtime': await import('react/jsx-runtime'),
		'react-dom': await import('react-dom'),
		'react-dom/client': await import('react-dom/client'),
		'react-router-dom': await import('react-router-dom'),
		'@wadeck-app/dsl-ui': await import('@wadeck-app/dsl-ui'),
		'@wadeck-app/dsl-renderer': await import('@wadeck-app/dsl-renderer'),
	};
	// A data: URL, not the file's: vitest's module runner cannot import an ES module that sits outside the project,
	// while a data: URL goes to Node's own import, as app-core's does.
	const dataUrl = `data:text/javascript;base64,${Buffer.from(bundleSource).toString('base64')}`;
	const loaded = (await import(/* @vite-ignore */ dataUrl)) as { default: ComponentRegistryEntry[] };
	entries = loaded.default;
}, 120_000);

afterAll(() => {
	(globalThis as Record<string, unknown>).__APP_CORE_SHARED__ = undefined;
});

describe('the packaged dsl-lib', () => {
	it('is packaged with the entry and the stylesheet the manifest points at', () => {
		expect(fs.existsSync(path.join(outDir, 'dsl-lib', 'entries.mjs'))).toBe(true);
		expect(fs.statSync(path.join(outDir, 'dsl-lib', 'style.css')).size).toBeGreaterThan(1000);
	});

	it("carries dsl-ui's utilities in Tailwind's order, so it cannot override the shell's with a shorthand alone", () => {
		const css = fs.readFileSync(path.join(outDir, 'dsl-lib', 'style.css'), 'utf8');
		const shorthand = css.indexOf('.px-2 {');
		const longhand = css.indexOf('.pl-7 {');
		expect(shorthand, '.px-2 is missing').toBeGreaterThan(-1);
		expect(longhand, '.pl-7 (used by dsl-ui SearchBar) is missing: the sheet does not scan dsl-ui').toBeGreaterThan(
			-1
		);
		expect(longhand, '.pl-7 must come after .px-2 or it loses to it').toBeGreaterThan(shorthand);
	});

	it('exports the library types and no dsl-ui entry', () => {
		const names = entries.map(e => e.name);
		expect(names).toContain('SplitLayout');
		expect(names).toContain('VariantSwitcher');
		expect(names).not.toContain('Badge');
	});

	it('carries the utilities the components rely on, including the label palette and the responsive ones', () => {
		const css = fs.readFileSync(path.join(outDir, 'dsl-lib', 'style.css'), 'utf8');
		for (const selector of [
			'.bg-task-chip-1-bg',
			'.text-task-chip-6',
			'.lg\\:sticky',
			'.lg\\:flex-row',
			'.z-\\[9999\\]',
		]) {
			expect(css, `${selector} is missing from the stylesheet`).toContain(selector);
		}
		expect(css).toContain('--color-task-chip-1');
	});

	it('loads and renders on a shell whose dsl-renderer lacks the coercion helpers (app-core-cli 094 ships dsl-renderer 175)', async () => {
		const shared = (globalThis as unknown as Record<string, Record<string, unknown>>).__APP_CORE_SHARED__!;
		const full = shared['@wadeck-app/dsl-renderer'] as Record<string, unknown>;
		const missing = ['coerceProp', 'resolveExpressionsDeep', 'coerceDate', 'coerceStringList'];
		const older = Object.fromEntries(Object.entries(full).filter(([name]) => !missing.includes(name)));
		(globalThis as Record<string, unknown>).__APP_CORE_SHARED__ = { ...shared, '@wadeck-app/dsl-renderer': older };
		try {
			// A different source text, so the module is evaluated again against the older namespace.
			const url = `data:text/javascript;base64,${Buffer.from(`${bundleSource}\n// older shell`).toString('base64')}`;
			const loaded = (await import(/* @vite-ignore */ url)) as { default: ComponentRegistryEntry[] };
			const badge = loaded.default.find(e => e.name === 'StatusBadge')!;

			render(
				<React.Fragment>
					{badge.render({ node: { $type: 'StatusBadge', label: 'done' }, registry: {}, ctx: {} } as never)}
				</React.Fragment>
			);

			expect(screen.getByTestId('status-badge')).toHaveTextContent('done');
		} finally {
			(globalThis as Record<string, unknown>).__APP_CORE_SHARED__ = shared;
		}
	});

	it('wires the page action handler from the context into the controls, as the shell provides it', async () => {
		const select = entries.find(e => e.name === 'ActionSelect')!;
		const onAction = vi.fn().mockResolvedValue(undefined);
		const node = {
			$type: 'ActionSelect',
			options: [
				{ value: 'todo', label: 'To do' },
				{ value: 'done', label: 'Done' },
			],
			value: 'todo',
			action: 'setStatusTo',
			valueParam: 'status',
			params: { id: 't1', projectParam: 'p1' },
		};

		render(<React.Fragment>{select.render({ node, registry: {}, ctx: { onAction } } as never)}</React.Fragment>);
		await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'done');

		expect(onAction).toHaveBeenCalledWith('setStatusTo', { id: 't1', projectParam: 'p1', status: 'done' });
	});

	it('carries no copy of React or of dsl-ui: those come from the shell, two copies break hooks and contexts', () => {
		expect(bundleSource).not.toMatch(/__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED|ReactCurrentDispatcher/);
		expect(bundleSource).not.toMatch(/@radix-ui/);
		expect(bundleSource).toContain('__APP_CORE_SHARED__');
	});

	it('renders a component from the bundle', () => {
		const split = entries.find(e => e.name === 'SplitLayout')!;
		render(
			<React.Fragment>
				{split.render({ node: { $type: 'SplitLayout', main: [], side: [] }, registry: {}, ctx: {} } as never)}
			</React.Fragment>
		);

		expect(screen.getByTestId('split-layout')).toBeInTheDocument();
	});
});

describe('the packaged views', () => {
	it('name only types the packaged dsl-lib exports, so no page asks the shell for a component that is not there', () => {
		const exported = new Set(entries.map(e => e.name));
		const viewsDir = path.join(outDir, 'dsl-frontend');
		const views = fs.readdirSync(viewsDir);
		expect(views.length).toBeGreaterThan(5);
		for (const view of views) {
			const text = fs.readFileSync(path.join(viewsDir, view), 'utf8');
			for (const match of text.matchAll(/"\$type":"task:(\w+)"/g)) {
				expect(
					exported.has(match[1]!),
					`${view} uses task:${match[1]}, which the dsl-lib does not export`
				).toBe(true);
			}
		}
	});
});
