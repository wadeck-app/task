import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Safety net: no test may push to a real queue. The packaged module that backend.realServer.integration.test.ts spawns
// builds the default event sink (the sink cannot be injected there), which would find the daemon of the machine running
// the tests or start it with `queue start`. QUEUE_SDK_OFF=1 makes the SDK send, start and report nothing (every call
// answers `dropped`), and child processes spawned by tests inherit it.
process.env['QUEUE_SDK_OFF'] = '1';

// Safety net 2: the shared project SDK (registry of `project`) has no off switch; it reads $XDG_CONFIG_HOME/project, else
// <home>/.config/project, and the module reads it at every request. Point all three variables at a temp dir for every test
// file (child processes inherit them), so no test can read or write the real registry. A test that needs a registry creates one
// in that dir (or in its own temp dir) with the SDK.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'task-module-xdg-'));
process.env['XDG_CONFIG_HOME'] = sandbox;
process.env['HOME'] = sandbox;
process.env['USERPROFILE'] = sandbox;

afterAll(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});
