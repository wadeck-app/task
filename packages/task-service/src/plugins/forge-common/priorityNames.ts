// How a task priority is spelled on a forge (an option of a native field, or the tail of a label) and back. Shared by the forges:
// names are matched case-insensitively (a forge keeps `High` where the project says `high`), and a `priorityMap` entry
// (`task priority -> forge name`) wins over the same name. Pure.

export class PriorityNames {
	private readonly toRemote = new Map<string, string>();
	private readonly toTask = new Map<string, string>();

	/**
	 * @param priorities the project's priorities, highest first; undefined = any priority is accepted (a hand-built context)
	 * @param map `priorityMap`: task priority -> the name the forge uses for it
	 */
	constructor(
		readonly priorities: readonly string[] | undefined,
		map: Readonly<Record<string, string>> = {}
	) {
		for (const priority of priorities ?? []) {
			const remote = map[priority] ?? priority;
			this.toRemote.set(priority, remote);
			this.toTask.set(remote.toLowerCase(), priority);
		}
		// With no list of priorities, the map is all there is to read back with.
		if (priorities === undefined) {
			for (const [priority, remote] of Object.entries(map)) {
				this.toRemote.set(priority, remote);
				this.toTask.set(remote.toLowerCase(), priority);
			}
		}
	}

	/** The name the forge uses for a task priority. */
	remoteName(priority: string): string {
		return this.toRemote.get(priority) ?? priority;
	}

	/**
	 * The task priority a forge name stands for; undefined when the project has no such priority. With no list of priorities every
	 * name is a priority (as written).
	 */
	taskPriority(remote: string): string | undefined {
		const found = this.toTask.get(remote.toLowerCase());
		if (found !== undefined) return found;
		return this.priorities === undefined ? remote : undefined;
	}
}
