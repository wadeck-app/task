import { Readable } from 'node:stream';

import { REMOTE_CAPABILITIES } from '@wadeck-app/task-core';
import { runBackendContract } from '@wadeck-app/task-core/contract';
import type { BackendFixture } from '@wadeck-app/task-core/contract';

import { serveStdioRequest } from '../../server/stdioServer.js';
import { createTestContext } from '../../testHelpers.js';
import { RemoteBackend } from '../remote/RemoteBackend.js';
import { createMachinePlugin } from './machinePlugin.js';
import type { MachineRunner } from './machineRunner.js';

// The shared backend contract (design 1.7) against the remote backend over the MACHINE transport: every request becomes the stdin of one
// `task serve --stdio` (the real pipeline, in this process, over a LocalFileBackend), every answer the stdout of that run. The only fake
// is the process boundary (what `machine run` does); the same cases the local store and the plain-http remote pass must pass here.
// As in the plain-http contract run, the SERVER decides the time of a claim: its clock is set to the `now` of each claim just before it.
async function fixture(): Promise<BackendFixture> {
	let serverNow = Date.now();
	const test = createTestContext({ statuses: ['backlog', 'in-progress', 'done', 'waiting-for-review'] } as never);
	const ctx = { ...test.ctx, project: { id: 'ab12cd34', name: 'served', path: test.rootDir } };
	const runner: MachineRunner = {
		async run(call) {
			const answer = await serveStdioRequest(Readable.from([Buffer.from(call.stdin, 'utf8')]), { ctx, now: () => new Date(serverNow) });
			return {
				kind: 'ran',
				exitCode: 0,
				stdout: JSON.stringify(answer),
				stderr: '',
				timedOut: false,
				truncated: false,
			};
		},
	};
	const transport = await createMachinePlugin(runner).create({ peer: 'thinkcentre', project: 'served' }, { env: {} });
	const backend = new RemoteBackend({ transport });
	const claim = backend.claim.bind(backend);
	backend.claim = (id, input) => {
		serverNow = Date.parse(input.now);
		return claim(id, input);
	};
	return {
		backend,
		async dispose() {
			await transport.dispose();
			test.cleanup();
		},
	};
}

runBackendContract(
	'RemoteBackend -> machine transport -> task serve --stdio (in process) -> LocalFileBackend',
	fixture,
	REMOTE_CAPABILITIES
);
