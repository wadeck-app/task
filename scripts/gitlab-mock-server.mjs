// Runs the local GitLab mock (packages/task-service/src/plugins/gitlab/fakeGitLab.testkit.ts) as a server until Ctrl+C, so a task project
// can use the gitlab strategy against it without Docker or network:
//
//   npm run build
//   node scripts/gitlab-mock-server.mjs --seed
//
// It prints the URL, the project, the token, the GITLAB_TOKEN line and a ready-to-paste `strategy:` block. `--help` lists the options.
// The mock answers like the recorded gitlab.com Free but is NOT a real GitLab and keeps nothing when it stops.
// Exit codes: 0 stopped, 1 the server could not start, 2 bad usage or the build is missing.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(import.meta.dirname, '../packages/task-service/dist/plugins/gitlab');
const modules = ['fakeGitLab.testkit.js', 'gitlabMockServer.testkit.js'].map(name => path.join(dist, name));
const missing = modules.filter(file => !fs.existsSync(file));
if (missing.length > 0) {
	console.error(`gitlab-mock-server: ${missing.join(', ')} not found. Run: npm run build`);
	process.exit(2);
}

const { runMockServer } = await import(pathToFileURL(modules[1]).href);

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop.abort());

const code = await runMockServer(
	process.argv.slice(2),
	{ out: line => console.log(line), err: line => console.error(line) },
	stop.signal
);
process.exit(code);
