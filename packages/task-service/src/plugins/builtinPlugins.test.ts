import { isPlugin } from '../plugin-host/index.js';
import { createBuiltinRegistry } from './builtinPlugins.js';

describe('the built-in plugins', () => {
	it('registers strategies github and local and transport plain-http, each by ref and alias', () => {
		const registry = createBuiltinRegistry();

		expect(registry.list('strategy').map(entry => [entry.ref, entry.aliases])).toEqual([
			['plugins.github.default', ['github']],
			['plugins.local.default', ['local']],
		]);
		expect(registry.list('transport').map(entry => [entry.ref, entry.aliases])).toEqual([
			['plugins.plain-http.default', ['plain-http']],
		]);
		expect(registry.lookup('local', 'strategy')).toBe(registry.lookup('plugins.local.default', 'strategy'));
	});

	it('every registration is well formed and documents itself with a snippet', () => {
		const registry = createBuiltinRegistry();

		for (const entry of [...registry.list('strategy'), ...registry.list('transport')]) {
			expect(isPlugin(entry.plugin), entry.ref).toBe(true);
			expect(entry.plugin.describe().snippet, entry.ref).not.toBe('');
		}
	});

	it('every call builds an independent registry', () => {
		const first = createBuiltinRegistry();
		const second = createBuiltinRegistry();

		expect(first).not.toBe(second);
		expect(first.lookup('local', 'strategy')).toBe(second.lookup('local', 'strategy'));
	});

	it('a strategy asked as a transport is a pointed error', () => {
		expect(() => createBuiltinRegistry().lookup('local', 'transport')).toThrow(
			'"local" is a strategy plugin, not a transport one'
		);
	});
});
