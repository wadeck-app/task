import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	assertIsolatedEnv,
	createIsolatedCliEnv,
	type IsolatedCliEnv,
	SCOPED_REGISTRY_VAR,
	spawnIsolated,
	UNREACHABLE_REGISTRY,
} from './isolatedCliEnv.js';

const created: IsolatedCliEnv[] = [];
function create(...args: Parameters<typeof createIsolatedCliEnv>): IsolatedCliEnv {
	const iso = createIsolatedCliEnv(...args);
	created.push(iso);
	return iso;
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const iso of created.splice(0)) iso.cleanup();
});

describe('createIsolatedCliEnv', () => {
	it('puts config dir, home, npm prefix, cache and npm config files in a throwaway tree, never the real ones', () => {
		const iso = create();
		for (const key of [
			'TASK_CONFIG_DIR',
			'XDG_CONFIG_HOME',
			'HOME',
			'USERPROFILE',
			'APPDATA',
			'LOCALAPPDATA',
			'NPM_CONFIG_PREFIX',
			'NPM_CONFIG_CACHE',
			'NPM_CONFIG_USERCONFIG',
			'NPM_CONFIG_GLOBALCONFIG',
		]) {
			const value = iso.env[key];
			expect(value, `${key} must be set`).toBeDefined();
			expect(
				path.resolve(value!).startsWith(path.resolve(iso.root)),
				`${key}=${value} must live in ${iso.root}`
			).toBe(true);
		}
		// The updater honours TASK_CONFIG_DIR, ConfigDir.get('task') honours XDG_CONFIG_HOME: they must agree.
		expect(iso.env['TASK_CONFIG_DIR']).toBe(path.join(iso.env['XDG_CONFIG_HOME']!, 'task'));
		expect(iso.env['TASK_CONFIG_DIR']).toBe(iso.configDir);
		expect(iso.env['NPM_CONFIG_PREFIX']).toBe(iso.npmPrefix);
	});

	it('points npm at an unreachable registry, scope included, in env and in both npm config files', () => {
		const iso = create();
		expect(iso.env['NPM_CONFIG_REGISTRY']).toBe(UNREACHABLE_REGISTRY);
		// A project-level .npmrc outranks the config files: only this env variable pins the scope.
		expect(iso.env['npm_config_@wadeck-app:registry']).toBe(UNREACHABLE_REGISTRY);
		for (const key of ['NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG']) {
			const content = fs.readFileSync(iso.env[key]!, 'utf8');
			expect(content).toContain(`registry=${UNREACHABLE_REGISTRY}`);
			expect(content).toContain(`@wadeck-app:registry=${UNREACHABLE_REGISTRY}`);
		}
	});

	it('drops every case variant of the parent steering variables, keeps the rest', () => {
		vi.stubEnv('npm_config_prefix', 'C:\\real\\global\\prefix');
		vi.stubEnv('npm_config_userconfig', 'C:\\real\\.npmrc');
		vi.stubEnv('npm_config_@wadeck-app:registry', 'https://npm.pkg.github.com/');
		vi.stubEnv('UPDATER_FORCE', '1');
		vi.stubEnv('LAUNCHER_DEBUG', '1');
		vi.stubEnv('CLI_SELF_CHECK_QUIET', '1');
		vi.stubEnv('SOMETHING_ELSE', 'kept');
		const iso = create();
		const keys = Object.keys(iso.env);
		expect(keys.filter(k => /^npm_config_prefix$/i.test(k))).toEqual(['NPM_CONFIG_PREFIX']);
		expect(keys.filter(k => /^npm_config_userconfig$/i.test(k))).toEqual(['NPM_CONFIG_USERCONFIG']);
		expect(iso.env['NPM_CONFIG_PREFIX']).toBe(iso.npmPrefix);
		expect(iso.env[SCOPED_REGISTRY_VAR]).toBe(UNREACHABLE_REGISTRY);
		expect(iso.env['UPDATER_FORCE']).toBeUndefined();
		expect(iso.env['LAUNCHER_DEBUG']).toBeUndefined();
		expect(iso.env['CLI_SELF_CHECK_QUIET']).toBeUndefined();
		expect(iso.env['SOMETHING_ELSE']).toBe('kept');
	});

	it('applies `extra` last and removes the whole tree on cleanup', () => {
		const iso = create({ extra: { UPDATER_FORCE: '1' } });
		expect(iso.env['UPDATER_FORCE']).toBe('1');
		iso.cleanup();
		expect(fs.existsSync(iso.root)).toBe(false);
	});
});

describe('assertIsolatedEnv', () => {
	it('accepts an environment built by createIsolatedCliEnv, also with a loopback mock registry', () => {
		expect(() => assertIsolatedEnv(create().env)).not.toThrow();
		expect(() => assertIsolatedEnv(create({ registry: 'http://127.0.0.1:4873/' }).env)).not.toThrow();
	});

	it.each([
		'TASK_CONFIG_DIR',
		'XDG_CONFIG_HOME',
		'HOME',
		'USERPROFILE',
		'NPM_CONFIG_PREFIX',
		'NPM_CONFIG_REGISTRY',
		'NPM_CONFIG_USERCONFIG',
		'NPM_CONFIG_GLOBALCONFIG',
		SCOPED_REGISTRY_VAR,
	])('fails when %s is missing: the child could then reach the real machine', key => {
		const env = { ...create().env };
		delete env[key];
		expect(() => assertIsolatedEnv(env)).toThrow(key);
	});

	it.each([
		'TASK_CONFIG_DIR',
		'XDG_CONFIG_HOME',
		'HOME',
		'USERPROFILE',
		'NPM_CONFIG_PREFIX',
		'NPM_CONFIG_USERCONFIG',
	])('fails when %s points outside the temp dir', key => {
		const env = { ...create().env, [key]: path.join(path.parse(os.tmpdir()).root, 'real-thing') };
		expect(() => assertIsolatedEnv(env)).toThrow(key);
	});

	it.each(['NPM_CONFIG_REGISTRY', SCOPED_REGISTRY_VAR])('fails when %s is a real registry', key => {
		const env = { ...create().env, [key]: 'https://npm.pkg.github.com/' };
		expect(() => assertIsolatedEnv(env)).toThrow(key);
	});

	it('fails when a lowercase npm_config_prefix variant would win over the isolated one', () => {
		const env = { ...create().env, npm_config_prefix: 'C:\\real\\prefix' };
		expect(() => assertIsolatedEnv(env)).toThrow('npm_config_prefix');
	});
});

describe('spawnIsolated', () => {
	it('runs the child inside the isolated tree: env and cwd', () => {
		const iso = create();
		const script = path.join(iso.root, 'probe.cjs');
		fs.writeFileSync(
			script,
			'process.stdout.write(JSON.stringify({ cwd: process.cwd(), prefix: process.env.NPM_CONFIG_PREFIX, cfg: process.env.TASK_CONFIG_DIR }))'
		);
		const result = spawnIsolated(script, [], iso);
		const seen = JSON.parse(result.stdout) as { cwd: string; prefix: string; cfg: string };
		expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(iso.root));
		expect(seen.prefix).toBe(iso.npmPrefix);
		expect(seen.cfg).toBe(iso.configDir);
	});

	it('throws before spawning anything when the env lacks the isolation', () => {
		const iso = create();
		const script = path.join(iso.root, 'marker.cjs');
		const marker = path.join(iso.root, 'ran');
		fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
		delete iso.env['NPM_CONFIG_PREFIX'];
		expect(() => spawnIsolated(script, [], iso)).toThrow('NPM_CONFIG_PREFIX');
		expect(fs.existsSync(marker)).toBe(false);
	});
});
