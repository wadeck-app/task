import { execSync } from 'node:child_process';

function readBaseVersion(): string {
	const now = new Date();
	const pad2 = (n: number) => String(n).padStart(2, '0');
	const date = `${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}`;
	const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
	let count = '0';
	let hash = 'DEV';
	try {
		count = execSync('git rev-list --count HEAD', { encoding: 'utf8', windowsHide: true }).trim();
	} catch {
		/* not a git repo */
	}
	try {
		hash = execSync('git rev-parse --short=8 HEAD', { encoding: 'utf8', windowsHide: true }).trim();
	} catch {
		/* not a git repo */
	}
	return `${date}-${time}-${count}-${hash}`;
}

// Injected by esbuild at bundle time via define; falls back to readBaseVersion() in dev mode (tsx).
declare const __TASK_CLI_VERSION__: string | undefined;

export const VERSION: string =
	typeof __TASK_CLI_VERSION__ !== 'undefined' && __TASK_CLI_VERSION__ ? __TASK_CLI_VERSION__ : readBaseVersion();
