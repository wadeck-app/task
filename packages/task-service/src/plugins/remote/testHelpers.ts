// Test fixture of the remote strategy: a real `task serve` on a free loopback port over a disposable local project, and a RemoteBackend
// that reaches it through the real plain-http transport. Shared by the remote tests (contract suite, errors, events, migration).
// Nothing shipped imports this file.
import type { ReadNotice, TransportInstance } from '../kinds.js';
import { startServerFixture } from '../../server/testHelpers.js';
import type { FixtureOptions, ServerFixture } from '../../server/testHelpers.js';
import { plainHttpPlugin } from '../plain-http/plainHttpPlugin.js';
import { RemoteBackend } from './RemoteBackend.js';
import type { RemoteBackendOptions } from './RemoteBackend.js';

export interface RemoteFixture {
	server: ServerFixture;
	transport: TransportInstance;
	backend: RemoteBackend;
	notices: ReadNotice[];
	stop(): Promise<void>;
}

export interface RemoteFixtureOptions extends FixtureOptions {
	/** Options of the transport (url excluded), for example a short timeout. */
	transportOptions?: Record<string, unknown>;
	/** Options of the backend (expectedProject, suppressEvents). */
	backendOptions?: Partial<RemoteBackendOptions>;
	/** The token the CLIENT presents, when it must differ from the server's (a wrong-token test). */
	clientToken?: string;
}

export async function startRemoteFixture(options: RemoteFixtureOptions = {}): Promise<RemoteFixture> {
	const server = await startServerFixture(options);
	const token = options.clientToken ?? server.token;
	const transport = await plainHttpPlugin.create(
		{ url: server.server.url, tokenEnv: 'TASK_TEST_TOKEN', ...options.transportOptions },
		{ env: { TASK_TEST_TOKEN: token } }
	);
	const notices: ReadNotice[] = [];
	const backend = new RemoteBackend({ transport, notice: notice => notices.push(notice), ...options.backendOptions });
	return {
		server,
		transport,
		backend,
		notices,
		async stop() {
			await transport.dispose();
			await server.stop();
		},
	};
}
