import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// GET /health: the update test of app-core-cli (module-authoring.md, "Update test of app-core-cli"). The staged server loads the module on
// a copy of the registry; the answer must be `{ ok, checks: [{ name, ok, detail? }] }`, read only and fast.
let h: Harness;
afterEach(() => h.world.cleanup());

interface Check {
	name: string;
	ok: boolean;
	detail?: string;
}
const checksOf = (body: Record<string, unknown>): Check[] => body['checks'] as Check[];
const check = (body: Record<string, unknown>, name: string): Check => {
	const found = checksOf(body).find(entry => entry.name === name);
	expect(found, `no check named ${name}`).toBeDefined();
	return found!;
};

describe('GET /health', () => {
	it('is healthy with no registry: the first-use state is not a failure', async () => {
		h = setup();

		const answer = await h.call('GET /health');

		expect(answer.status).toBe(200);
		expect(answer.body['ok']).toBe(true);
		expect(check(answer.body, 'registry')).toMatchObject({ ok: true });
		expect(check(answer.body, 'registry').detail).toContain('no project');
	});

	it('is healthy with readable projects and says how many', async () => {
		h = setup();
		await h.world.createProject('alpha');
		await h.world.createProject('beta');

		const answer = await h.call('GET /health');

		expect(answer.body['ok']).toBe(true);
		expect(check(answer.body, 'registry')).toMatchObject({ ok: true });
		expect(check(answer.body, 'registry').detail).toContain('2 project');
	});

	it('stays healthy when ONE project has a broken config (the user data is not the module), and names it in the detail', async () => {
		h = setup();
		await h.world.createProject('alpha');
		const broken = await h.world.createProject('broken');
		h.world.breakConfig(broken);

		const answer = await h.call('GET /health');

		expect(answer.body['ok']).toBe(true);
		const projects = check(answer.body, 'projects');
		expect(projects.ok).toBe(true);
		expect(projects.detail).toContain('1 unreadable');
	});

	it('is NOT healthy when the registry cannot be read: every page of the module would fail, with the file and the problem', async () => {
		h = setup();
		await h.world.createProject('alpha');
		fs.writeFileSync(path.join(h.world.registryDir, 'registry.json'), '{ nope');

		const answer = await h.call('GET /health');

		expect(answer.status).toBe(200);
		expect(answer.body['ok']).toBe(false);
		const registry = check(answer.body, 'registry');
		expect(registry.ok).toBe(false);
		expect(registry.detail).toContain('registry.json');
	});

	it('has no side effect: no file is created in the registry or the data folder, no event is delivered', async () => {
		h = setup();
		const alpha = await h.world.createProject('alpha');
		const before = JSON.stringify(fs.readdirSync(h.world.registryDir).sort());

		await h.call('GET /health');
		await h.call('GET /health');

		expect(JSON.stringify(fs.readdirSync(h.world.registryDir).sort())).toBe(before);
		expect(alpha).toBeDefined();
	});
});
