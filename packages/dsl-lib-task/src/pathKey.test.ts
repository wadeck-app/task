import { describe, expect, it } from 'vitest';
import { labelKeyOf } from './components/LabelChips.js';
import { pathKeyOf } from './pathKey.js';

describe('pathKeyOf', () => {
	it('is the base64url of the UTF-8 bytes, no padding', () => {
		expect(pathKeyOf('a/b')).toBe(Buffer.from('a/b', 'utf8').toString('base64url'));
		expect(pathKeyOf('100%')).toBe(Buffer.from('100%', 'utf8').toString('base64url'));
		const accented = `caf${String.fromCharCode(233)} ${String.fromCharCode(0x2603)}`;
		expect(pathKeyOf(accented)).toBe(Buffer.from(accented, 'utf8').toString('base64url'));
		expect(pathKeyOf('')).toBe('');
	});

	it('is the key labels use, so one helper serves labels and metadata', () => {
		expect(labelKeyOf('a/b?')).toBe(pathKeyOf('a/b?'));
	});
});
