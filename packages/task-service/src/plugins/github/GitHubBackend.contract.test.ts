import { runBackendContract } from '@wadeck-app/task-core/contract';
import type { BackendFixture } from '@wadeck-app/task-core/contract';

import type { DeclaredFills } from '../kinds.js';
import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import { GITHUB_CAPABILITIES, githubCapabilities } from './GitHubBackend.js';

// The shared backend contract (design 1.7) against the github backend over the fake server: the same cases the local store passes,
// with the capabilities github declares for each set of fills. Where github cannot do what a case does, the case asserts the loud
// refusal (UnsupportedByBackendError) instead -- "unsupported" is tested, never skipped. Three projects:
//  - strict, no fill: meta, deletion and duplicateOf are refused (the hint names the fill);
//  - meta in labels, tombstone deletion, duplicate marker: the emulated ones;
//  - meta in the body block, hard deletion.
function fixtureWith(fills: DeclaredFills, fidelity: 'strict' | 'degrade') {
	return async (): Promise<BackendFixture> => {
		const fake = await FakeGitHub.start({ searchLagRequests: 0 });
		const { backend } = makeGitHubBackend(fake, {
			statuses: WRITE_STATUSES,
			projectTypes: ['bug', 'feature'],
			options: { statusMap: WRITE_STATUS_MAP },
			fills,
			fidelity,
		});
		return { backend, dispose: () => fake.stop() };
	};
}

const OPTIONS = { authoredComments: false };

runBackendContract(
	'GitHubBackend over the fake server, strict',
	fixtureWith({}, 'strict'),
	GITHUB_CAPABILITIES,
	OPTIONS
);

const EMULATED: DeclaredFills = {
	meta: { use: 'labels', fidelity: 'strict' },
	delete: { use: 'tombstone', fidelity: 'degrade' },
	'linkTypes.duplicateOf': { use: 'duplicate-marker', fidelity: 'degrade' },
};
runBackendContract(
	'GitHubBackend over the fake server, meta in labels, tombstone delete, duplicate marker',
	fixtureWith(EMULATED, 'degrade'),
	githubCapabilities(EMULATED),
	OPTIONS
);

const BLOCK_AND_HARD: DeclaredFills = {
	meta: { use: 'body-block', fidelity: 'degrade' },
	delete: { use: 'hard', fidelity: 'strict' },
};
runBackendContract(
	'GitHubBackend over the fake server, meta in the body block, hard delete',
	fixtureWith(BLOCK_AND_HARD, 'degrade'),
	githubCapabilities(BLOCK_AND_HARD),
	OPTIONS
);
