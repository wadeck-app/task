// Types of scripts/github-conformance-scenario.mjs for the tests that import it (the step list).
export interface ScenarioStep {
	name: string;
	request: {
		method: string;
		path: string;
		body?: unknown;
		rawBody?: string;
		headers?: Record<string, string>;
		auth?: 'token' | 'none' | 'bad';
	};
	save?: Record<string, string>;
	saveHeaders?: Record<string, string>;
	saveLinks?: Record<string, string>;
	wait?: number;
	ignoreKeys?: string[];
	subset?: boolean;
	/** Name of a variable holding an issue number to close at the end (removed from the fixture). */
	track?: string;
}

export function steps(): ScenarioStep[];
