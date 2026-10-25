const reported = new Set<string>();

/** Logs an authoring problem once per message (console.error unless told otherwise), so a re-render does not flood the console. */
export function reportOnce(message: string, level: 'error' | 'warn' = 'error'): void {
	if (reported.has(message)) {
		return;
	}
	reported.add(message);
	console[level](message);
}

/** Forgets what was reported. For tests. */
export function resetReported(): void {
	reported.clear();
}
