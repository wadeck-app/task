/** A duration for a message: `450ms`, `30s`, `12m 30s`, `2h 5m`. Whole units, rounded down; negative counts as zero. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms));
	if (total < 1000) return `${total}ms`;
	const seconds = Math.floor(total / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const rest = seconds % 60;
		return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
	}
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}
