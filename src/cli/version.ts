import { execSync } from 'node:child_process';

function readBaseVersion(): string {
	const now = new Date();
	const pad2 = (n: number) => String(n).padStart(2, '0');
	const date = `${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}`;
	const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
	let count = '0';
	let hash = 'DEV';
	try { count = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a git repo */ }
	try { hash = execSync('git rev-parse --short=8 HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a git repo */ }
	return `${date}-${time}-${count}-${hash}`;
}

// In CI this file is replaced before bundling with generated constants:
//   export const VERSION = '2026.08.28-356-c3418bea';
export const VERSION: string = readBaseVersion();
