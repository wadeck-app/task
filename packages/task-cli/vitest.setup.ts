import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate every test file from the developer's real ~/.config/task (invocation logs, projects.json registry):
// ConfigDir.get('task') honours XDG_CONFIG_HOME, and spawned child processes inherit it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-xdg-'));
process.env['XDG_CONFIG_HOME'] = sandbox;

afterAll(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});

// No test may reach the real queue: runTaskCommand builds its event sink with createQueueEventSink, whose delivery goes
// through @wadeck-app/queue-sdk (finds the daemon, may start it with `queue start`). On a machine with queue installed that
// would push real events and cost seconds per mutating command. Every test file gets an instant sink instead. Files that
// exercise the real sink (TaskIndex.events.test.ts) call vi.unmock('@wadeck-app/task-service') and mock the SDK module
// itself (vi.mock('@wadeck-app/queue-sdk')).
// Plain functions, not vi.fn(): the config's mockReset would wipe the implementation before each test.
vi.mock('@wadeck-app/task-service', async importOriginal => {
	const actual = await importOriginal<typeof import('@wadeck-app/task-service')>();
	return {
		...actual,
		createQueueEventSink: (): import('@wadeck-app/task-service').EventSink => ({
			deliver: () => Promise.resolve({ delivered: true }),
		}),
	};
});
