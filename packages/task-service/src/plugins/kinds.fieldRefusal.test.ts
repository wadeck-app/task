import { UnsupportedByBackendError } from '@wadeck-app/task-core';

import { refuseTaskField } from './kinds.js';
import type { TaskFieldOperation } from './kinds.js';

describe('refuseTaskField', () => {
	it.each([
		['setPriority', 'priority'],
		['clearPriority', 'priority'],
		['setAssignee', 'assignee'],
		['clearAssignee', 'assignee'],
		['claim', 'claim'],
		['release', 'claim'],
	] as const satisfies ReadonlyArray<readonly [TaskFieldOperation, string]>)(
		'%s is refused for capability %s, naming the strategy and the local alternative',
		async (operation, capability) => {
			const failure = await refuseTaskField('github', operation).then(
				() => undefined,
				(error: unknown) => error
			);

			expect(failure).toBeInstanceOf(UnsupportedByBackendError);
			const error = failure as UnsupportedByBackendError;
			expect(error.capability).toBe(capability);
			expect(error.backendKind).toBe('github');
			expect(error.hint).toMatch(/not available on the github storage strategy yet/);
			expect(error.hint).toMatch(/local strategy/);
		}
	);
});
