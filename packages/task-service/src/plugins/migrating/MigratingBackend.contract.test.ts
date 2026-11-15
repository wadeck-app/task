import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOCAL_CAPABILITIES } from '@wadeck-app/task-core';
import type { BackendCapabilities } from '@wadeck-app/task-core';
import { runBackendContract } from '@wadeck-app/task-core/contract';
import type { BackendFixture } from '@wadeck-app/task-core/contract';

import { openTaskContext } from '../../openContext.js';
import { FakeGitHub } from '../github/fakeGitHub.testkit.js';

// The shared backend contract against the migrating strategy in state `in-a`, over TWO different pairs, so that what the wrapper does is
// proved to depend on the capabilities of the sides and on nothing else:
//  - two sides of the same kind: the intersection is the whole of what each does;
//  - a side that stores the tasks itself and a side behind an HTTP API (a fake server): where the second cannot do what a case does, the
//    case asserts the loud refusal (UnsupportedByBackendError) from the wrapper, though the first could do it.
// The wrapper is built the way a project is: a config.yml, the plugin registry, the host opening both sides.
const STATUS_CONFIG = `statuses:
    - backlog
    - in-progress
    - review
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
    - { name: duplicate, terminal: true, outcome: negative }
types:
    - bug
    - feature
`;

function fixture(configYml: string, env: NodeJS.ProcessEnv, stop?: () => Promise<void>): () => Promise<BackendFixture> {
	return () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
		const configFile = path.join(root, 'config', 'config.yml');
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, configYml, 'utf8');
		const ctx = openTaskContext({
			storage: { dataDir: path.join(root, 'data'), configFiles: [configFile] },
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'shop', path: root },
			env,
		});
		return Promise.resolve({
			backend: ctx.store,
			dispose: async () => {
				await ctx.dispose?.();
				await stop?.();
				fs.rmSync(root, { recursive: true, force: true });
			},
		});
	};
}

runBackendContract(
	'migrating strategy in state in-a, two sides of the same kind',
	fixture(
		`${STATUS_CONFIG}strategy:\n    type: migrating\n    options:\n        current: { type: local }\n        new: { type: local }\n`,
		{}
	),
	LOCAL_CAPABILITIES
);

// What both a side with files and the fake API can do, written out (not computed by the code under test).
const SHARED_WITH_THE_API: BackendCapabilities = {
	hierarchy: 'limited',
	linkTypes: ['blockedBy'],
	status: 'mapped',
	history: 'derived',
	activity: 'native',
	delete: 'no',
	search: 'native',
	concurrency: 'check-then-write',
	ids: 'assigned',
	labels: true,
	meta: false,
	comments: true,
	priority: true,
	assignee: true,
	claim: true,
	writes: 'full',
	indexedGraph: false,
	events: 'client',
};

let fake: FakeGitHub | undefined;

runBackendContract(
	'migrating strategy in state in-a, files on one side and an HTTP API (fake server) on the other',
	async () => {
		fake = await FakeGitHub.start({ searchLagRequests: 0 });
		const running = fake;
		const config = `${STATUS_CONFIG}strategy:
    type: migrating
    options:
        current: { type: local }
        new:
            type: github
            options:
                repo: ${running.repo}
                baseUrl: ${running.baseUrl}
                tokenEnv: MIGRATING_CONTRACT_TOKEN
                cache: { ttlSeconds: 0 }
                priorityStorage: label
                timeoutSeconds: 2
                writeSpacingSeconds: 0
                statusMap:
                    backlog: { state: open }
                    in-progress: { state: open, label: 'status:in-progress' }
                    review: { state: open, label: 'status:review' }
                    done: { state: closed }
                    cancelled: { state: closed, reason: not_planned }
                    duplicate: { state: closed, reason: duplicate }
`;
		return fixture(config, { MIGRATING_CONTRACT_TOKEN: running.token }, () => running.stop())();
	},
	SHARED_WITH_THE_API
);
