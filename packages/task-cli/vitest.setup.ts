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

// No test may reach the real `queue` CLI: runTaskCommand builds its event sink with createQueueEventSink, whose delivery
// looks queue up on PATH and spawns `node queue.js push` per event. On a machine with queue installed that cost 1-3 s per
// mutating command and pushed the slowest tests past the 5 s timeout (measured: 96 s cumulative test time in this package, 11.6 s with the fake sink). Every test file
// gets an instant sink instead. Files that exercise the real sink (TaskIndex.events.test.ts, fake spawn) call
// vi.unmock('@wadeck-app/task-service') and keep their own child_process mock.
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
