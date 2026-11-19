// GET /health: the update test of app-core-cli (module-authoring.md, "Update test of app-core-cli"). The updater starts the new server
// on a copy of the registry entries and asks every module whether it runs. Read only, no network (a forge project is only OPENED, which
// reads its config files, never its tasks), fast.
//
// What fails the update: only what makes the module itself unusable, the shared registry that cannot be read (every page would fail).
// A project whose config is broken is the user's data, not this version of the module: it is reported in the `projects` check, ok.
import { inspectKnownProjects } from '@wadeck-app/task-service';

import type { RouteKit } from './routeKit.js';

interface HealthCheck {
	name: string;
	ok: boolean;
	detail?: string;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function registerHealthRoutes(kit: RouteKit): void {
	kit.route('GET', '/health', async () => {
		const { entries, registryProblem } = inspectKnownProjects();
		for (const entry of entries) await entry.context?.dispose?.();
		const checks: HealthCheck[] = [];
		if (registryProblem !== null) {
			checks.push({ name: 'registry', ok: false, detail: registryProblem });
		} else {
			checks.push({
				name: 'registry',
				ok: true,
				detail:
					entries.length === 0
						? 'no project registered (first use)'
						: `${plural(entries.length, 'project')} registered`,
			});
			const unreadable = entries.filter(entry => entry.health.error !== null);
			checks.push({
				name: 'projects',
				ok: true,
				detail:
					unreadable.length === 0
						? 'every project can be opened'
						: `${unreadable.length} unreadable (their own config or parent chain, see the Projects page): ${unreadable
								.map(entry => entry.known.name)
								.join(', ')}`,
			});
		}
		return { status: 200, body: { ok: checks.every(entry => entry.ok), checks } };
	});
}
