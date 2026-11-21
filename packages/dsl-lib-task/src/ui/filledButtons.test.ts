import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BUTTON_PRIMARY_CLASS } from './tokens.js';

// A FILLED control (white text on a primary fill) must fill with the SOLID accent (`--color-primary-solid`, the strong one of the
// theme), never with `bg-primary`: that one is the light accent meant for text and soft chips, so a filled button using it reads
// washed out next to every other filled button of the shell (reported on the Save of Configure columns).

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOLID = 'bg-[var(--color-primary-solid)]';

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === 'generated' ? [] : sources(path);
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

/** Every string or template literal that holds `text-white` together with a plain `bg-primary` fill (not -light, -solid, /opacity). */
function filledWithLightAccent(text: string): string[] {
	const literals = text.match(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g) ?? [];
	return literals.filter(literal => /(^|[\s`'"])bg-primary(?![\w-])(?!\/)/.test(literal) && /\btext-white\b/.test(literal));
}

describe('filled buttons use the solid accent', () => {
	it('the shared primary button fills with primary-solid, with its own hover colour, not an opacity fade', () => {
		expect(BUTTON_PRIMARY_CLASS).toContain(SOLID);
		expect(BUTTON_PRIMARY_CLASS).toContain('hover:bg-[var(--color-primary-solid-hover)]');
		expect(BUTTON_PRIMARY_CLASS).not.toMatch(/(^|\s)bg-primary(\s|$)/);
		expect(BUTTON_PRIMARY_CLASS).not.toContain('hover:opacity-90');
	});

	it('no source file draws white text on a bg-primary fill', () => {
		const offenders = sources(SRC).flatMap(file =>
			filledWithLightAccent(readFileSync(file, 'utf8')).map(literal => `${relative(SRC, file)}: ${literal.slice(0, 90)}`)
		);
		expect(offenders).toEqual([]);
	});
});
