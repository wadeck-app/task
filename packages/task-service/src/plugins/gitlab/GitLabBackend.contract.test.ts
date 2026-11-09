import { runBackendContract } from '@wadeck-app/task-core/contract';
import type { BackendFixture } from '@wadeck-app/task-core/contract';

import type { DeclaredFills } from '../kinds.js';
import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import { gitlabCapabilities } from './GitLabBackend.js';
import type { GitLabTier } from './gitlabOptions.js';

// The shared backend contract (design 1.7) against the gitlab backend over the fake server: the same cases the local store passes,
// with the capabilities gitlab declares for each tier and set of fills. Where GitLab cannot do what a case does (hierarchy, blocking
// links on the free tier, undeclared fills), the case asserts the loud refusal (UnsupportedByBackendError) instead -- "unsupported"
// is tested, never skipped. The fake is modelled on docs.gitlab.com: this proves agreement with the documentation as read, not with
// a real GitLab.
function fixtureWith(tier: GitLabTier, fills: DeclaredFills) {
	return async (): Promise<BackendFixture> => {
		const fake = await FakeGitLab.start({ tier });
		const { backend } = makeGitLabBackend(fake, {
			tier,
			statuses: WRITE_STATUSES,
			projectTypes: ['bug', 'feature'],
			options: { statusMap: writeStatusMap(tier) },
			fills,
		});
		return { backend, dispose: () => fake.stop() };
	};
}

const OPTIONS = { authoredComments: false };

const NONE: DeclaredFills = {};
const FREE_FILLS: DeclaredFills = {
	meta: { use: 'labels', fidelity: 'strict' },
	delete: { use: 'tombstone', fidelity: 'degrade' },
	'linkTypes.duplicateOf': { use: 'relate-block', fidelity: 'degrade' },
	'linkTypes.causedBy': { use: 'relate-block', fidelity: 'degrade' },
};
const PREMIUM_FILLS: DeclaredFills = {
	meta: { use: 'labels', fidelity: 'strict' },
	delete: { use: 'hard', fidelity: 'strict' },
	'linkTypes.duplicateOf': { use: 'relate-block', fidelity: 'degrade' },
	'linkTypes.causedBy': { use: 'relate-block', fidelity: 'degrade' },
};
const BLOCK_META: DeclaredFills = { meta: { use: 'body-block', fidelity: 'degrade' } };

runBackendContract(
	'GitLabBackend over the fake server, free tier, strict',
	fixtureWith('free', NONE),
	gitlabCapabilities('free', NONE),
	OPTIONS
);
runBackendContract(
	'GitLabBackend over the fake server, free tier, meta in labels, tombstone delete, relate-block links',
	fixtureWith('free', FREE_FILLS),
	gitlabCapabilities('free', FREE_FILLS),
	OPTIONS
);
runBackendContract(
	'GitLabBackend over the fake server, premium tier, strict',
	fixtureWith('premium', NONE),
	gitlabCapabilities('premium', NONE),
	OPTIONS
);
runBackendContract(
	'GitLabBackend over the fake server, premium tier, scoped meta labels, hard delete, relate-block links',
	fixtureWith('premium', PREMIUM_FILLS),
	gitlabCapabilities('premium', PREMIUM_FILLS),
	OPTIONS
);
runBackendContract(
	'GitLabBackend over the fake server, ultimate tier, meta in the description block',
	fixtureWith('ultimate', BLOCK_META),
	gitlabCapabilities('ultimate', BLOCK_META),
	OPTIONS
);
