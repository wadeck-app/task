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
