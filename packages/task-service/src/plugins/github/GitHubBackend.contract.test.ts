import { runReadOnlyBackendContract } from '@wadeck-app/task-core/contract';
import type { ReadOnlyFixture, SeedTask } from '@wadeck-app/task-core/contract';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { makeGitHubBackend } from './githubBackend.testkit.js';
import { GITHUB_CAPABILITIES } from './GitHubBackend.js';

// The shared read-only contract (design 1.7, R3) against the github backend over the fake server: the same cases a local read-only
// view passes, with the capabilities github declares. Every write the suite tries must be refused with UnsupportedByBackendError.
async function fixture(): Promise<ReadOnlyFixture> {
	const fake = await FakeGitHub.start({ searchLagRequests: 0 });
	const { backend } = makeGitHubBackend(fake, { projectTypes: ['bug'] });
	return {
		backend,
		dispose: () => fake.stop(),
		async seed(tasks: readonly SeedTask[]) {
			const numbers: Record<string, number> = {};
			for (const task of tasks) {
				const number = fake.addIssue({
					title: task.title,
					body: task.description ?? null,
					labels: [
						...(task.labels ?? []),
						...(task.type === undefined ? [] : [`type:${task.type}`]),
						...(task.status === 'next' ? ['status:in-progress'] : []),
					],
				});
				numbers[task.key] = number;
				if (task.status === 'terminal') fake.updateIssue(number, { state: 'closed', stateReason: 'completed' });
				if (task.parent !== undefined) fake.setParent(number, numbers[task.parent]!);
				for (const blocker of task.blockedBy ?? []) fake.addBlockedBy(number, numbers[blocker]!);
				for (const text of task.comments ?? []) fake.addComment(number, text);
			}
			return Object.fromEntries(Object.entries(numbers).map(([key, number]) => [key, String(number)]));
		},
	};
}

runReadOnlyBackendContract('GitHubBackend over the fake server', fixture, GITHUB_CAPABILITIES);
