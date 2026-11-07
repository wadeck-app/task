import { literal } from './dslNodes.js';

describe('literal', () => {
	it('leaves a text that cannot be read as an expression alone', () => {
		expect(literal('alpha')).toBe('alpha');
		expect(literal('')).toBe('');
		expect(literal('cost in $')).toBe('cost in $');
	});

	it('puts a zero-width space in front of a text starting with "$", which the renderer would evaluate otherwise', () => {
		const shown = literal('$sources.projects');
		expect(shown.startsWith('$')).toBe(false);
		expect(shown.replace(String.fromCodePoint(0x200b), '')).toBe('$sources.projects');
	});
});
