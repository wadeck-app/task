export interface TaskUiConfig {
	/** Prefix put in front of every `/api/...` call of the module, e.g. `/api/modules/task`. */
	apiBase?: string;
	/** Prefix put in front of every in-app link, e.g. `/modules/task`. */
	routeBase?: string;
}

let apiBase = '';
let routeBase = '';

/**
 * A prefix is either empty or an absolute path with no trailing slash, because every caller appends its own
 * leading-slash path. Anything else is refused rather than repaired: a silently normalised prefix hides the
 * misconfiguration until a request or a link goes to the wrong place.
 */
function checkBase(name: string, value: string, example: string): void {
	if (value !== '' && !value.startsWith('/')) {
		throw new Error(`dsl-lib-task ${name} must start with "/" (got "${value}"); use e.g. "${example}".`);
	}
	if (value.endsWith('/')) {
		throw new Error(
			`dsl-lib-task ${name} must not end with a trailing slash (got "${value}"), callers append their own "/path".`
		);
	}
}

/**
 * Sets the process-wide defaults. Called once by the module's `src/dsl-components/index.ts`. A bundle carries its
 * own copy of this file, so configuring one host never leaks into another. Validates everything before applying
 * anything, so a rejected call leaves the config untouched.
 */
export function configureTaskUi(config: TaskUiConfig): void {
	if (config.apiBase !== undefined) {
		checkBase('apiBase', config.apiBase, '/api/modules/task');
	}
	if (config.routeBase !== undefined) {
		checkBase('routeBase', config.routeBase, '/modules/task');
	}
	if (config.apiBase !== undefined) {
		apiBase = config.apiBase;
	}
	if (config.routeBase !== undefined) {
		routeBase = config.routeBase;
	}
}

/** The configured prefix for `/api/...` calls; `''` when nothing was configured. */
export function getApiBase(): string {
	return apiBase;
}

/** The configured prefix for in-app links; `''` when nothing was configured. */
export function getRouteBase(): string {
	return routeBase;
}

/** An in-app path (`/tasks/p/x`) with the configured route prefix in front of it. */
export function appPath(path: string): string {
	return `${routeBase}${path}`;
}

/** Back to the defaults. For tests: the config is module state and would otherwise leak between them. */
export function resetTaskUiConfig(): void {
	apiBase = '';
	routeBase = '';
}
