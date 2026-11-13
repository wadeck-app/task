// Types of scripts/gitlab-conformance-scenario.mjs for the tests that import it (the GraphQL documents, the step list).
export const GQL_READ: string;
export const GQL_SET_PARENT: string;
export const GQL_CONVERT: string;

export interface ScenarioStep {
	name: string;
	request: {
		method: string;
		path: string;
		body?: unknown;
		rawBody?: string;
		headers?: Record<string, string>;
		auth?: 'token' | 'bearer' | 'none' | 'bad';
	};
	save?: Record<string, string>;
	saveHeaders?: Record<string, string>;
	/** Name of a variable holding an issue iid to close at the end (removed from the fixture). */
	track?: string;
	/** Label names to delete at the end (removed from the fixture). */
	trackLabels?: unknown[];
}

export function steps(): ScenarioStep[];

export function runScenario(options: {
	call: (
		label: string,
		method: string,
		route: string,
		body?: unknown,
		options?: Record<string, unknown>
	) => Promise<{
		status: number;
		headers: Record<string, string>;
		text: string;
		json: unknown;
		ms: number;
	}>;
	projectPath: string;
	run: string;
	apiBase: string;
	track: { issues: Set<number>; labels: Set<string> };
}): Promise<{ format: 1; recordedAt: string; source: string; steps: unknown[] }>;
