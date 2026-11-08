import { describe, expect, it, vi } from 'vitest';

import { describeUnhandledRejection, installUnhandledRejectionHandler } from './unhandledRejection.js';
import type { RejectionProcess } from './unhandledRejection.js';

function fakeProcess(): {
	proc: RejectionProcess;
	fire: (reason: unknown) => void;
	stderr: string[];
	exit: ReturnType<typeof vi.fn>;
} {
	let listener: ((reason: unknown) => void) | undefined;
	const stderr: string[] = [];
	const exit = vi.fn();
	const proc: RejectionProcess = {
		on: (_event, fn) => {
			listener = fn;
		},
		exit,
		stderr: { write: text => stderr.push(text) },
	};
	return { proc, fire: reason => listener?.(reason), stderr, exit };
}

describe('installUnhandledRejectionHandler', () => {
	it('stops the command with exit 1 and a message that says what failed and what to do', () => {
		const fake = fakeProcess();
		installUnhandledRejectionHandler(fake.proc);

		fake.fire(new Error('EPERM: operation not permitted'));

		expect(fake.exit).toHaveBeenCalledWith(1);
		const text = fake.stderr.join('');
		expect(text).toContain('Error: unexpected failure');
		expect(text).toContain('EPERM: operation not permitted');
		expect(text).toContain('task cli logs');
	});

	it('accepts a rejection that is not an Error', () => {
		expect(describeUnhandledRejection('plain text')).toContain('plain text');
		expect(describeUnhandledRejection(undefined)).toContain('undefined');
	});

	it('registers exactly one listener for unhandledRejection on the process it is given', () => {
		const on = vi.fn();
		installUnhandledRejectionHandler({ on, exit: vi.fn(), stderr: { write: vi.fn() } });

		expect(on).toHaveBeenCalledTimes(1);
		expect(on.mock.calls[0]![0]).toBe('unhandledRejection');
	});
});
