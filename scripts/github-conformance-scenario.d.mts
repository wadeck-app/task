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
		/** An image upload: the raw bytes as base64; sent to the uploads address with the `token` scheme. */
		upload?: { bytesBase64: string };
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
