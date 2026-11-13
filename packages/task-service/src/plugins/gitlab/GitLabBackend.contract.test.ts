import { runBackendContract } from '@wadeck-app/task-core/contract';
import type { BackendFixture } from '@wadeck-app/task-core/contract';

import type { DeclaredFills } from '../kinds.js';
import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import { gitlabCapabilities } from './GitLabBackend.js';

// The shared backend contract (design 1.7) against the gitlab backend over the fake server: the same cases the local store passes,
// with the capabilities gitlab declares for each set of fills (Free tier only). Where GitLab cannot do what a case does (hierarchy,
// blocking links, undeclared fills), the case asserts the loud refusal (UnsupportedByBackendError) instead -- "unsupported"
// is tested, never skipped. The fake is modelled on docs.gitlab.com: this proves agreement with the documentation as read, not with
// a real GitLab.
function fixtureWith(fills: DeclaredFills) {
	return async (): Promise<BackendFixture> => {
		const fake = await FakeGitLab.start();
		const { backend } = makeGitLabBackend(fake, {
			statuses: WRITE_STATUSES,
			projectTypes: ['bug', 'feature'],
			options: { statusMap: writeStatusMap() },
			fills,
		});
		return { backend, dispose: () => fake.stop() };
	};
}

// Two levels: an issue (or incident) and its native tasks, as the traits declare (gitlabTraits.test.ts).
const OPTIONS = { authoredComments: false, hierarchyDepth: 2 };

const NONE: DeclaredFills = {};
const FREE_FILLS: DeclaredFills = {
	meta: { use: 'labels', fidelity: 'strict' },
	delete: { use: 'tombstone', fidelity: 'degrade' },
	'linkTypes.duplicateOf': { use: 'relate-block', fidelity: 'degrade' },
	'linkTypes.causedBy': { use: 'relate-block', fidelity: 'degrade' },
};
const HARD_DELETE: DeclaredFills = {
	meta: { use: 'labels', fidelity: 'strict' },
	delete: { use: 'hard', fidelity: 'strict' },
	'linkTypes.duplicateOf': { use: 'relate-block', fidelity: 'degrade' },
	'linkTypes.causedBy': { use: 'relate-block', fidelity: 'degrade' },
};
const BLOCK_META: DeclaredFills = { meta: { use: 'body-block', fidelity: 'degrade' } };

runBackendContract('GitLabBackend over the fake server, strict', fixtureWith(NONE), gitlabCapabilities(NONE), OPTIONS);
runBackendContract(
	'GitLabBackend over the fake server, meta in labels, tombstone delete, relate-block links',
	fixtureWith(FREE_FILLS),
	gitlabCapabilities(FREE_FILLS),
	OPTIONS
);
runBackendContract(
	'GitLabBackend over the fake server, meta in labels, hard delete, relate-block links',
	fixtureWith(HARD_DELETE),
	gitlabCapabilities(HARD_DELETE),
	OPTIONS
);
runBackendContract(
	'GitLabBackend over the fake server, meta in the description block',
	fixtureWith(BLOCK_META),
	gitlabCapabilities(BLOCK_META),
	OPTIONS
);
