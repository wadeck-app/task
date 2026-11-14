import { BackendDataError } from '@wadeck-app/task-core';

import {
	createPriorityContext,
	isPriorityLabel,
	labelOfPriority,
	priorityLabelsOf,
	priorityOfLabel,
	readPriority,
} from './gitlabPriority.js';

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const settings = (extra: { priorityPrefix?: string; priorityMap?: Record<string, string> } = {}) => ({
	priorityPrefix: 'priority:',
	priorityMap: {},
	...extra,
});
const url = (iid: number): string => `https://gitlab.example/acme/shop/-/issues/${iid}`;

describe('labels of priorities', () => {
	it('the label is the prefix and the priority, or the whole mapped name', () => {
		const pc = createPriorityContext(settings({ priorityMap: { urgent: 'P0' } }), PRIORITIES);

		expect(labelOfPriority('high', pc)).toBe('priority:high');
		expect(labelOfPriority('urgent', pc)).toBe('P0');
	});

	it('is reserved by the prefix or by a mapped name, compared EXACTLY (GitLab labels are case sensitive)', () => {
		const pc = createPriorityContext(settings({ priorityMap: { urgent: 'P0' } }), PRIORITIES);

		expect(isPriorityLabel('priority:anything', pc)).toBe(true);
		expect(isPriorityLabel('P0', pc)).toBe(true);
		expect(isPriorityLabel('p0', pc)).toBe(false);
		expect(isPriorityLabel('Priority:high', pc)).toBe(false);
		expect(isPriorityLabel('priorities', pc)).toBe(false);
	});

	it('reads the priority back; an unknown tail is no priority; a hand-built context without priorities accepts any tail', () => {
		const pc = createPriorityContext(settings({ priorityMap: { urgent: 'P0' } }), PRIORITIES);

		expect(priorityOfLabel('priority:high', pc)).toBe('high');
		expect(priorityOfLabel('P0', pc)).toBe('urgent');
		expect(priorityOfLabel('priority:critical', pc)).toBeUndefined();
		// a mapped priority is written under its mapped name: its prefixed spelling is not read as it
		expect(priorityOfLabel('priority:urgent', pc)).toBeUndefined();
		expect(priorityOfLabel('priority:critical', createPriorityContext(settings(), undefined))).toBe('critical');
	});

	it('the scoped prefix works the same', () => {
		const pc = createPriorityContext(settings({ priorityPrefix: 'priority::' }), PRIORITIES);

		expect(labelOfPriority('low', pc)).toBe('priority::low');
		expect(priorityLabelsOf(['x', 'priority::low', 'priority:low'], pc)).toEqual(['priority::low']);
	});
});

describe('readPriority', () => {
	const pc = createPriorityContext(settings(), PRIORITIES);

	it('is undefined without a priority label', () => {
		expect(readPriority({ iid: 4 }, ['bug'], pc, url, () => undefined)).toBeUndefined();
	});

	it('two priority labels are a BackendDataError naming the issue and the fix', () => {
		let error: unknown;
		try {
			readPriority({ iid: 4 }, ['priority:high', 'priority:low'], pc, url, () => undefined);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(BackendDataError);
		expect((error as BackendDataError).message).toContain(
			'issue #4 carries two priority labels (priority:high, priority:low)'
		);
		expect((error as BackendDataError).hint).toContain(url(4));
	});

	it('a label of an unknown priority is reported as ignored with the valid priorities and where to fix it', () => {
		const ignored: string[] = [];

		expect(readPriority({ iid: 4 }, ['priority:critical'], pc, url, text => ignored.push(text))).toBeUndefined();

		expect(ignored).toHaveLength(1);
		expect(ignored[0]).toContain(
			'"priority:critical", which is not a priority of this project (urgent, high, medium, low)'
		);
		expect(ignored[0]).toContain('strategy.options.priorityMap');
	});
});
