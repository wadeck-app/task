import { BackendRejectedError } from '@wadeck-app/task-core';
import { describe, expect, it } from 'vitest';

import { allowEntryText, peerProblem, projectProblem, serveCommand } from './machineCommand.js';

// Everything that reaches the command line of the peer is a name checked here: the peer's shell receives the line unescaped.
const INJECTIONS = [
	'a;b',
	'a&&b',
	'a|b',
	'$(x)',
	'`x`',
	'a b',
	'a"b',
	"a'b",
	'a>b',
	'a<b',
	'a\nb',
	'a\\b',
	'a%PATH%',
	'-p',
	'--shell',
	'.hidden',
	String.fromCharCode(233),
	'',
	'a'.repeat(65),
];

describe('the names that end up in the command line of the peer', () => {
	it.each(INJECTIONS)('%j is refused as a project', value => {
		expect(projectProblem(value)).toBeTypeOf('string');
		expect(() => serveCommand(value)).toThrow(BackendRejectedError);
	});

	it.each(INJECTIONS)('%j is refused as a machine reference', value => {
		expect(peerProblem(value)).toBeTypeOf('string');
	});

	it('plain names, ids and dotted names pass', () => {
		for (const value of ['shop', 'shop-2', 'a.b_c', '64b45cd9', 'Thinkcentre', 'a'.repeat(64)]) {
			expect(projectProblem(value)).toBeUndefined();
			expect(peerProblem(value)).toBeUndefined();
		}
	});

	it('anything that is not a text is refused', () => {
		expect(peerProblem(undefined)).toBeTypeOf('string');
		expect(projectProblem(12)).toBeTypeOf('string');
	});
});

describe('the command and the allow entry', () => {
	it('is one printable-ASCII line with the project and --stdio', () => {
		expect(serveCommand('shop')).toBe('task serve -p shop --stdio');
	});

	it('the allow entry is the exact command the admin must allow, with the shell when one is set', () => {
		expect(allowEntryText('thinkcentre', 'shop', undefined)).toBe(
			'machine admin allow thinkcentre --stdin json --stdin-max 64k --stdin-chars <families> -- "task serve -p shop --stdio"'
		);
		expect(allowEntryText('thinkcentre', 'shop', 'sh')).toBe(
			'machine admin allow thinkcentre --shell sh --stdin json --stdin-max 64k --stdin-chars <families> -- "task serve -p shop --stdio"'
		);
	});

	it('names the fix when the project is not safe', () => {
		const error = (() => {
			try {
				return serveCommand('a;b');
			} catch (e) {
				return e as BackendRejectedError;
			}
		})() as BackendRejectedError;

		expect(error.hint).toContain('transport.options.project');
	});
});
