import { describe, expect, it } from 'vitest';

import { PriorityNames } from './priorityNames.js';

describe('PriorityNames', () => {
	const priorities = ['urgent', 'high', 'medium', 'low'];

	it('matches forge names case-insensitively and writes the task spelling', () => {
		const names = new PriorityNames(priorities);
		expect(names.taskPriority('High')).toBe('high');
		expect(names.taskPriority('URGENT')).toBe('urgent');
		expect(names.remoteName('high')).toBe('high');
	});

	it('a priorityMap entry names the forge side, both ways', () => {
		const names = new PriorityNames(priorities, { urgent: 'P0', high: 'P1' });
		expect(names.remoteName('urgent')).toBe('P0');
		expect(names.remoteName('medium')).toBe('medium');
		expect(names.taskPriority('p1')).toBe('high');
		expect(names.taskPriority('urgent')).toBeUndefined();
	});

	it('a name the project has no priority for is undefined, never guessed', () => {
		expect(new PriorityNames(priorities).taskPriority('Blocker')).toBeUndefined();
	});

	it('without a list of priorities every name is a priority as written; the map still reads back', () => {
		const names = new PriorityNames(undefined, { a: 'Alpha' });
		expect(names.taskPriority('whatever')).toBe('whatever');
		expect(names.taskPriority('alpha')).toBe('a');
		expect(names.remoteName('a')).toBe('Alpha');
		expect(names.remoteName('b')).toBe('b');
	});
});
