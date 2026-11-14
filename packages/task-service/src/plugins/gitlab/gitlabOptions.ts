// The options of the `gitlab` strategy (`strategy.options` of a project's config.yml): parsed once, every problem a sentence that
// starts with the dotted key (the host turns it into `<file>: strategy.options.<key>: <problem>`). Pure: no I/O, no environment.
//
// Only the Free tier is supported (verified live on gitlab.com Free, 2026-11-09): the `blocks` / `is_blocked_by` links are a paid
// feature that task does not offer. A label written with the scoped syntax (`status::todo`) is a PLAIN label on Free (no exclusivity,
// accepted by the API and the UI): it is allowed everywhere, and the wrapper itself keeps a task to one status label.
import type { TokenSource } from '../forge-common/forgeToken.js';
import { found, isMapping, parseNumber, parseTtlCache } from '../forge-common/optionParsing.js';
import type { Parsed } from '../forge-common/optionParsing.js';
import type { ProjectFacts } from '../kinds.js';

/** How GitLab represents a task status: opened or closed, and an optional label (GitLab has no close reason). */
export interface StatusRule {
	state: 'open' | 'closed';
	/** A label that must be on the issue (`status:in-progress`). */
	label?: string;
}

/** A task type as GitLab holds it: the native issue type `incident`, or a label. */
export interface TypeRule {
	issueType?: NativeIssueType;
	label?: string;
}

/**
 * The native issue types a task type can map to (`issue` is the default for everything else). `test_case` is refused: see
 * TEST_CASE_REASON. `task` is refused too: the native Task is the type of a hierarchy child (see TASK_RESERVED_REASON).
 */
export type NativeIssueType = 'incident';
export const NATIVE_ISSUE_TYPES: readonly NativeIssueType[] = ['incident'];

const TASK_RESERVED_REASON =
	'native Task is the hierarchy child type, it cannot also be a task type (every child would read back as that type)';

// VERIFIED-LIVE on gitlab.com Free (2026-11-09): the REST API does not really support it.
const TEST_CASE_REASON =
	'test_case cannot be used: on gitlab.com Free a POST with issue_type test_case silently creates a plain issue and a PUT silently ignores it, so the type would never be stored';

export type { TokenSource };

export interface GitLabProject {
	/** As written in the config: `group/sub/project` or `1234`. */
	ref: string;
	/** The path form, or undefined for a numeric id. */
	path: string | undefined;
	/** The `:id` of the URLs: the numeric id, or the URL-encoded path (`group%2Fsub%2Fproject`). */
	apiId: string;
}

export interface GitLabSettings {
	project: GitLabProject;
	/** No trailing slash: `https://gitlab.com/api/v4`, or `https://HOST/api/v4` for a self-managed instance. */
	baseUrl: string;
	token: TokenSource;
	statusMap: Record<string, StatusRule>;
	typePrefix: string;
	typeMap: Record<string, TypeRule>;
	metaPrefix: string;
	/** Prefix of the label that carries a priority (`priority:high`, or `priority::high`): GitLab Free has no native priority field. */
	priorityPrefix: string;
	/** Task priority -> the WHOLE label name that carries it (default: the prefix + the priority). */
	priorityMap: Record<string, string>;
	pageSize: number;
	maxPages: number;
	cacheTtlSeconds: number;
	timeoutSeconds: number;
	/** Least time between the start of two writes (a polite pace: GitLab.com allows 60 notes and 200 issues a minute). */
	writeSpacingSeconds: number;
	/** Longest wait for the rate limit window to reopen (reads and writes); a longer one fails with the instant to retry at. */
	rateLimitMaxWaitSeconds: number;
}

/** The documented option names, in the order the documentation lists them. */
export const GITLAB_OPTION_NAMES: readonly string[] = [
	'project',
	'baseUrl',
	'tokenEnv',
	'tokenFile',
	'statusMap',
	'typePrefix',
	'typeMap',
	'metaPrefix',
	'priorityPrefix',
	'priorityMap',
	'pageSize',
	'maxPages',
	'cache',
	'timeoutSeconds',
	'writeSpacingSeconds',
	'rateLimit',
];

/** gitlab.com counts requests in a fixed window of about 60 s: waiting one window out is the default. */
export const DEFAULT_MAX_WAIT_SECONDS = 70;
export const DEFAULT_BASE_URL = 'https://gitlab.com/api/v4';
/** GitLab allows 100 labels on one issue (docs.gitlab.com/administration/instance_limits, `limit_labels_per_work_item`). */
export const LABELS_PER_ISSUE = 100;
/** The longest description of an issue: 1,048,576 characters (docs.gitlab.com/api/issues, create and edit). */
export const DESCRIPTION_MAX = 1_048_576;
/** The longest note body: 1,000,000 characters (docs.gitlab.com/api/notes). */
export const COMMENT_MAX = 1_000_000;

const STATE_KEYS = ['state', 'label'] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
const PROJECT_ID = /^\d+$/;

/**
 * What GitLab (or the way task sends labels) cannot take in a label name, as a sentence about the name as written; undefined when it
 * is fine. Only what is certain is refused: the API takes a comma separated list, so a comma cannot be part of a name, and a name
 * with a space at an end is trimmed by the server. GitLab documents no limit on the length of a name (UNVERIFIED): the server's own
 * refusal is passed on, with its words, when it comes.
 */
export function labelProblem(name: string): string | undefined {
	if (name === '') return 'an empty label name';
	if (name.includes(',')) return `"${name}" contains a comma, which cannot be sent to GitLab in a label list`;
	if (name !== name.trim()) return `"${name}" starts or ends with a space, which GitLab trims`;
	return undefined;
}

function parseProject(value: unknown): Parsed<GitLabProject> {
	if (value === undefined || value === '') {
		return { problem: 'project: required (the path group/project, group/subgroup/project, or the numeric id)' };
	}
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
		return { value: { ref: String(value), path: undefined, apiId: String(value) } };
	}
	if (typeof value !== 'string') {
		return { problem: `project: must be a project path like group/project or a numeric id, found ${found(value)}` };
	}
	if (PROJECT_ID.test(value)) return { value: { ref: value, path: undefined, apiId: value } };
	if (!PROJECT_PATH.test(value)) {
		return {
			problem: `project: "${value}" is neither a numeric id nor a path of the form group/project (nested groups: group/subgroup/project)`,
		};
	}
	// The slashes of a namespaced path are written %2F in a URL (docs.gitlab.com/api/rest, "Namespaced paths").
	return { value: { ref: value, path: value, apiId: encodeURIComponent(value) } };
}

function parseBaseUrl(value: unknown): Parsed<string> {
	if (value === undefined) return { value: DEFAULT_BASE_URL };
	if (typeof value !== 'string') return { problem: `baseUrl: must be a string, found ${found(value)}` };
	let url: URL | undefined;
	try {
		url = new URL(value);
	} catch {
		url = undefined;
	}
	if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
		return { problem: `baseUrl: "${value}" is not an http:// or https:// address` };
	}
	if (url.username !== '' || url.password !== '') {
		return {
			problem:
				'baseUrl: must not contain credentials; the token is read from the environment variable named by tokenEnv',
		};
	}
	if (url.search !== '' || url.hash !== '') {
		return { problem: 'baseUrl: must not contain a query or fragment' };
	}
	const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
	if (!/\/api\/v4$/.test(base)) {
		return {
			problem: `baseUrl: "${value}" is not the REST address of a GitLab instance; it ends with /api/v4 (gitlab.com: ${DEFAULT_BASE_URL}, self-managed: https://HOST/api/v4)`,
		};
	}
	return { value: base };
}

function parseToken(options: Record<string, unknown>): Parsed<TokenSource> {
	const { tokenEnv, tokenFile } = options;
	if (tokenEnv !== undefined && tokenFile !== undefined) {
		return { problem: 'tokenFile: give tokenEnv or tokenFile, not both' };
	}
	if (tokenEnv === undefined && tokenFile === undefined) {
		return {
			problem:
				'tokenEnv: required (the NAME of the environment variable that holds the token, for example GITLAB_TOKEN; or give tokenFile)',
		};
	}
	if (tokenFile !== undefined) {
		if (typeof tokenFile !== 'string' || tokenFile === '') {
			return { problem: `tokenFile: must be the path of a file, found ${found(tokenFile)}` };
		}
		return { value: { kind: 'file', path: tokenFile } };
	}
	if (typeof tokenEnv !== 'string' || !ENV_NAME.test(tokenEnv)) {
		return {
			problem: `tokenEnv: ${found(tokenEnv)} is not an environment variable name (letters, digits and underscores, not starting with a digit); it must be the NAME of the variable, never the token`,
		};
	}
	return { value: { kind: 'env', name: tokenEnv } };
}

function signatureOf(rule: StatusRule): string {
	return `${rule.state}|${rule.label ?? ''}`;
}

function describeSignature(rule: StatusRule): string {
	return `state ${rule.state}, ${rule.label === undefined ? 'no label' : `label ${rule.label}`}`;
}

function parseStatusEntry(status: string, value: unknown): Parsed<StatusRule> {
	const at = `statusMap.${status}`;
	if (!isMapping(value)) {
		return { problem: `${at}: must be a mapping with state (and optionally label), found ${found(value)}` };
	}
	for (const key of Object.keys(value)) {
		if (key === 'reason') {
			return {
				problem: `${at}.reason: GitLab has no close reason; tell two ways to end apart with a label (cancelled: { state: closed, label: 'status:cancelled' })`,
			};
		}
		if (!(STATE_KEYS as readonly string[]).includes(key)) {
			return { problem: `${at}.${key}: unknown key (valid: ${STATE_KEYS.join(', ')})` };
		}
	}
	const { state, label } = value;
	if (state === undefined) return { problem: `${at}.state: required ("open" or "closed")` };
	if (state !== 'open' && state !== 'closed') {
		return { problem: `${at}.state: must be "open" or "closed", found ${found(state)}` };
	}
	if (label !== undefined) {
		if (typeof label !== 'string' || label === '') {
			return { problem: `${at}.label: must be a label name, found ${found(label)}` };
		}
		const bad = labelProblem(label);
		if (bad !== undefined) return { problem: `${at}.label: ${bad}` };
	}
	return { value: { state, ...(label === undefined ? {} : { label: label as string }) } };
}

function parseStatusMap(value: unknown): Parsed<Record<string, StatusRule>> {
	if (value === undefined) {
		return {
			problem:
				'statusMap: required (task status -> GitLab representation, for example { todo: { state: open }, done: { state: closed } })',
		};
	}
	if (!isMapping(value)) {
		return { problem: `statusMap: must be a mapping of status to { state, label? }, found ${found(value)}` };
	}
	if (Object.keys(value).length === 0) return { problem: 'statusMap: must map at least one status' };
	const map: Record<string, StatusRule> = {};
	const owners = new Map<string, string>();
	for (const [status, entry] of Object.entries(value)) {
		const parsed = parseStatusEntry(status, entry);
		if ('problem' in parsed) return parsed;
		const signature = signatureOf(parsed.value);
		const owner = owners.get(signature);
		if (owner !== undefined) {
			return {
				problem: `statusMap.${status}: the same GitLab representation as "${owner}" (${describeSignature(parsed.value)}): give one of them ${
					parsed.value.label === undefined ? 'a label' : 'another label'
				}`,
			};
		}
		owners.set(signature, status);
		map[status] = parsed.value;
	}
	return { value: map };
}

function parsePrefixes(options: Record<string, unknown>): Parsed<{ typePrefix: string; metaPrefix: string }> {
	const read = (key: 'typePrefix' | 'metaPrefix', fallback: string): Parsed<string> => {
		const value = options[key] ?? fallback;
		if (typeof value !== 'string' || value === '') {
			return { problem: `${key}: must be a non-empty label prefix, found ${found(value)}` };
		}
		const bad = labelProblem(value);
		if (bad !== undefined) return { problem: `${key}: ${bad}` };
		return { value };
	};
	const type = read('typePrefix', 'type:');
	if ('problem' in type) return type;
	const meta = read('metaPrefix', 'meta:');
	if ('problem' in meta) return meta;
	if (type.value === meta.value) return { problem: `metaPrefix: must differ from typePrefix ("${type.value}")` };
	if (meta.value.startsWith(type.value)) {
		return {
			problem: `metaPrefix: "${meta.value}" starts with typePrefix "${type.value}", so a meta label would read as a type label`,
		};
	}
	if (type.value.startsWith(meta.value)) {
		return {
			problem: `typePrefix: "${type.value}" starts with metaPrefix "${meta.value}", so a type label would read as a meta label`,
		};
	}
	return { value: { typePrefix: type.value, metaPrefix: meta.value } };
}

/** Label names that are never a priority whatever the options say: the tombstone of a deleted task. */
const RESERVED_LABELS: readonly string[] = ['task:deleted'];

function parsePriority(
	options: Record<string, unknown>,
	prefixes: { typePrefix: string; metaPrefix: string },
	statusMap: Record<string, StatusRule>,
	typeMap: Record<string, TypeRule>
): Parsed<{ priorityPrefix: string; priorityMap: Record<string, string> }> {
	const prefix = options['priorityPrefix'] ?? 'priority:';
	if (typeof prefix !== 'string' || prefix === '') {
		return { problem: `priorityPrefix: must be a non-empty label prefix, found ${found(prefix)}` };
	}
	const bad = labelProblem(prefix);
	if (bad !== undefined) return { problem: `priorityPrefix: ${bad}` };
	// Names are compared exactly: GitLab labels are case sensitive.
	for (const [key, other] of [
		['typePrefix', prefixes.typePrefix],
		['metaPrefix', prefixes.metaPrefix],
	] as const) {
		if (prefix === other) return { problem: `priorityPrefix: must differ from ${key} ("${other}")` };
		if (prefix.startsWith(other)) {
			return {
				problem: `priorityPrefix: "${prefix}" starts with ${key} "${other}", so a priority label would read as another kind of label`,
			};
		}
		if (other.startsWith(prefix)) {
			return {
				problem: `${key}: "${other}" starts with priorityPrefix "${prefix}", so a label of that kind would read as a priority label`,
			};
		}
	}
	const statusLabels = Object.entries(statusMap).flatMap(([status, rule]) =>
		rule.label === undefined ? [] : [{ at: `statusMap.${status}.label`, label: rule.label }]
	);
	const typeLabels = Object.entries(typeMap).flatMap(([type, rule]) =>
		rule.label === undefined ? [] : [{ at: `typeMap.${type}.label`, label: rule.label }]
	);
	for (const { at, label } of [...statusLabels, ...typeLabels]) {
		if (label.startsWith(prefix)) {
			return {
				problem: `${at}: "${label}" starts with priorityPrefix "${prefix}", so it would read as a priority label; change the label or priorityPrefix`,
			};
		}
	}
	for (const reserved of RESERVED_LABELS) {
		if (reserved.startsWith(prefix)) {
			return {
				problem: `priorityPrefix: "${prefix}" is a prefix of the reserved label "${reserved}", so it would read as a priority label`,
			};
		}
	}
	const mapValue = options['priorityMap'] ?? {};
	if (!isMapping(mapValue)) {
		return {
			problem: `priorityMap: must be a mapping of task priority to the label name GitLab holds, found ${found(mapValue)}`,
		};
	}
	const map: Record<string, string> = {};
	const owners = new Map<string, string>();
	for (const [priority, name] of Object.entries(mapValue)) {
		const at = `priorityMap.${priority}`;
		if (typeof name !== 'string' || name === '') {
			return { problem: `${at}: must be a label name, found ${found(name)}` };
		}
		const refused = labelProblem(name);
		if (refused !== undefined) return { problem: `${at}: ${refused}` };
		const owner = owners.get(name);
		if (owner !== undefined) {
			return { problem: `${at}: the same label as "${owner}" ("${name}"): two priorities cannot share a label` };
		}
		const taken = [...statusLabels, ...typeLabels].find(entry => entry.label === name);
		if (taken !== undefined) {
			return {
				problem: `${at}: "${name}" is already the label of ${taken.at}; a label cannot carry two meanings`,
			};
		}
		if (RESERVED_LABELS.includes(name)) {
			return { problem: `${at}: "${name}" is reserved (it marks a deleted task)` };
		}
		for (const [key, other] of [
			['typePrefix', prefixes.typePrefix],
			['metaPrefix', prefixes.metaPrefix],
		] as const) {
			if (name.startsWith(other)) {
				return {
					problem: `${at}: "${name}" starts with ${key} "${other}", so it would read as another kind of label`,
				};
			}
		}
		owners.set(name, priority);
		map[priority] = name;
	}
	return { value: { priorityPrefix: prefix, priorityMap: map } };
}

function parseTypeMap(value: unknown): Parsed<Record<string, TypeRule>> {
	if (value === undefined) return { value: {} };
	if (!isMapping(value)) {
		return { problem: `typeMap: must be a mapping of task type to { issueType | label }, found ${found(value)}` };
	}
	const map: Record<string, TypeRule> = {};
	for (const [type, entry] of Object.entries(value)) {
		const at = `typeMap.${type}`;
		if (!isMapping(entry)) {
			return { problem: `${at}: must be a mapping with issueType or label, found ${found(entry)}` };
		}
		for (const key of Object.keys(entry)) {
			if (key !== 'issueType' && key !== 'label') {
				return { problem: `${at}.${key}: unknown key (valid: issueType, label)` };
			}
		}
		const { issueType, label } = entry;
		if (issueType === undefined && label === undefined) {
			return { problem: `${at}: give issueType (${NATIVE_ISSUE_TYPES.join(' or ')}) or label` };
		}
		if (issueType !== undefined && label !== undefined) {
			return { problem: `${at}.label: give issueType or label, not both` };
		}
		if (issueType !== undefined) {
			if (issueType === 'test_case')
				return { problem: `${at}.issueType: ${TEST_CASE_REASON}; use incident or a label` };
			if (issueType === 'task')
				return {
					problem: `${at}.issueType: ${TASK_RESERVED_REASON}; use a label type (label: <name>)`,
				};
			if (typeof issueType !== 'string' || !(NATIVE_ISSUE_TYPES as readonly string[]).includes(issueType)) {
				return {
					problem: `${at}.issueType: must be ${NATIVE_ISSUE_TYPES.join(' or ')}, found ${found(issueType)}`,
				};
			}
			map[type] = { issueType: issueType as NativeIssueType };
			continue;
		}
		if (typeof label !== 'string' || label.trim() === '') {
			return { problem: `${at}.label: must be a non-empty name, found ${found(label)}` };
		}
		const bad = labelProblem(label);
		if (bad !== undefined) return { problem: `${at}.label: ${bad}` };
		map[type] = { label };
	}
	// Two task types cannot share one native type: reading it back could not tell them apart.
	const owners = new Map<string, string>();
	for (const [type, rule] of Object.entries(map)) {
		if (rule.issueType === undefined) continue;
		const owner = owners.get(rule.issueType);
		if (owner !== undefined) {
			return {
				problem: `typeMap.${type}.issueType: "${rule.issueType}" is already the native type of "${owner}"`,
			};
		}
		owners.set(rule.issueType, type);
	}
	return { value: map };
}

const parseCache = (value: unknown): Parsed<number> => parseTtlCache(value, 30);

function parseRateLimit(value: unknown): Parsed<number> {
	if (value === undefined) return { value: DEFAULT_MAX_WAIT_SECONDS };
	if (!isMapping(value)) {
		return { problem: `rateLimit: must be a mapping like { maxWaitSeconds: 70 }, found ${found(value)}` };
	}
	for (const key of Object.keys(value)) {
		if (key !== 'maxWaitSeconds') return { problem: `rateLimit.${key}: unknown key (valid: maxWaitSeconds)` };
	}
	const wait = value['maxWaitSeconds'];
	if (wait === undefined) return { value: DEFAULT_MAX_WAIT_SECONDS };
	if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0) {
		return {
			problem: `rateLimit.maxWaitSeconds: must be zero or a positive number of seconds (0 = never wait, fail with the instant to retry at), found ${found(wait)}`,
		};
	}
	return { value: wait };
}

/** Parses `strategy.options` (without `fills`, which the host reads). Returns the settings, or the first problem as a sentence starting with its key. */
export function parseGitLabOptions(
	options: Record<string, unknown>
): { settings: GitLabSettings } | { problem: string } {
	// An old config may still declare a plan: never ignored silently.
	if (Object.prototype.hasOwnProperty.call(options, 'tier')) {
		return {
			problem:
				'tier: the gitlab strategy supports the Free tier only; remove `tier` (the blocking links of the paid tiers are not supported)',
		};
	}
	// GitHub's option: said apart, so a config copied from a github project gets the reason, not only "unknown".
	if (Object.prototype.hasOwnProperty.call(options, 'priorityStorage')) {
		return {
			problem:
				'priorityStorage: GitLab Free has no native priority field, so the priority is always stored in a label (priorityPrefix, priorityMap); remove priorityStorage',
		};
	}
	for (const key of Object.keys(options)) {
		if (!GITLAB_OPTION_NAMES.includes(key)) {
			return {
				problem: `${key}: unknown option for strategy "gitlab" (known: ${GITLAB_OPTION_NAMES.join(', ')})`,
			};
		}
	}
	const project = parseProject(options['project']);
	if ('problem' in project) return project;
	const baseUrl = parseBaseUrl(options['baseUrl']);
	if ('problem' in baseUrl) return baseUrl;
	const token = parseToken(options);
	if ('problem' in token) return token;
	const statusMap = parseStatusMap(options['statusMap']);
	if ('problem' in statusMap) return statusMap;
	const prefixes = parsePrefixes(options);
	if ('problem' in prefixes) return prefixes;
	const typeMap = parseTypeMap(options['typeMap']);
	if ('problem' in typeMap) return typeMap;
	const priority = parsePriority(options, prefixes.value, statusMap.value, typeMap.value);
	if ('problem' in priority) return priority;
	const pageSize = parseNumber(
		options,
		'pageSize',
		100,
		n => Number.isInteger(n) && n >= 1 && n <= 100,
		'a whole number from 1 to 100'
	);
	if ('problem' in pageSize) return pageSize;
	const maxPages = parseNumber(
		options,
		'maxPages',
		50,
		n => Number.isInteger(n) && n >= 1 && n <= 1000,
		'a whole number from 1 to 1000'
	);
	if ('problem' in maxPages) return maxPages;
	const cache = parseCache(options['cache']);
	if ('problem' in cache) return cache;
	const timeout = parseNumber(options, 'timeoutSeconds', 15, n => n > 0, 'a positive number of seconds');
	if ('problem' in timeout) return timeout;
	const spacing = parseNumber(options, 'writeSpacingSeconds', 1, n => n >= 0, 'zero or a positive number of seconds');
	if ('problem' in spacing) return spacing;
	const rateLimit = parseRateLimit(options['rateLimit']);
	if ('problem' in rateLimit) return rateLimit;
	return {
		settings: {
			project: project.value,
			baseUrl: baseUrl.value,
			token: token.value,
			statusMap: statusMap.value,
			typePrefix: prefixes.value.typePrefix,
			typeMap: typeMap.value,
			metaPrefix: prefixes.value.metaPrefix,
			priorityPrefix: priority.value.priorityPrefix,
			priorityMap: priority.value.priorityMap,
			pageSize: pageSize.value,
			maxPages: maxPages.value,
			cacheTtlSeconds: cache.value,
			timeoutSeconds: timeout.value,
			writeSpacingSeconds: spacing.value,
			rateLimitMaxWaitSeconds: rateLimit.value,
		},
	};
}

function exampleEntry(status: ProjectFacts['statuses'][number]): string {
	const label = (name: string): string => `'status:${name}'`;
	if (status.terminal) {
		return status.default || status.outcome !== 'negative'
			? `${status.name}: { state: closed }`
			: `${status.name}: { state: closed, label: ${label(status.name)} }`;
	}
	return status.default
		? `${status.name}: { state: open }`
		: `${status.name}: { state: open, label: ${label(status.name)} }`;
}

/**
 * Checks the map against the statuses and types of the project, at load: every status has exactly one representation, the terminal
 * ones close the issue, one open status and one closed status need no label (an issue created or closed on GitLab carries none), and
 * every type fits a label. Returns the first problem as a sentence starting with its key, or undefined.
 */
export function checkOptionsAgainstProject(settings: GitLabSettings, project: ProjectFacts): string | undefined {
	const { statusMap } = settings;
	const names = project.statuses.map(status => status.name);
	for (const status of project.statuses) {
		if (statusMap[status.name] === undefined) {
			return `statusMap.${status.name}: the status "${status.name}" of the project has no entry; add it, for example: ${exampleEntry(status)}`;
		}
	}
	for (const mapped of Object.keys(statusMap)) {
		if (!names.includes(mapped)) {
			return `statusMap.${mapped}: the project has no status "${mapped}" (statuses: ${names.join(', ')})`;
		}
	}
	for (const status of project.statuses) {
		const rule = statusMap[status.name]!;
		if (status.terminal && rule.state !== 'closed') {
			return `statusMap.${status.name}.state: the status "${status.name}" is terminal, so its issue must be closed`;
		}
		if (!status.terminal && rule.state !== 'open') {
			return `statusMap.${status.name}.state: the status "${status.name}" is not terminal, so its issue must stay open`;
		}
	}
	if (!project.statuses.some(status => status.terminal)) {
		return 'statusMap: the project has no terminal status, so a closed issue would map to nothing; mark one status terminal in the config (statuses: - name: done / terminal: true)';
	}
	for (const state of ['open', 'closed'] as const) {
		const here = project.statuses.filter(status => statusMap[status.name]!.state === state);
		if (here.length === 0) continue;
		if (!here.some(status => statusMap[status.name]!.label === undefined)) {
			const fallback = here.find(status => status.default) ?? here[0]!;
			return `statusMap: no ${state} status without a label; an issue ${
				state === 'open' ? 'created' : 'closed'
			} on GitLab carries no status label, so one ${state} status (for example "${fallback.name}") must be mapped to { state: ${state} } alone`;
		}
	}
	for (const type of Object.keys(settings.typeMap)) {
		if (project.types.length > 0 && !project.types.includes(type)) {
			return `typeMap.${type}: the project has no type "${type}" (types: ${project.types.join(', ')})`;
		}
	}
	for (const type of project.types) {
		if (settings.typeMap[type] !== undefined) continue;
		const label = `${settings.typePrefix}${type}`;
		const bad = labelProblem(label);
		if (bad !== undefined) return `typePrefix: the label of the type "${type}" is not usable: ${bad}`;
	}
	return checkPriorities(settings, project);
}

/** The label that carries a task priority: the mapped name, else the prefix + the priority. */
export function priorityLabelName(
	settings: Pick<GitLabSettings, 'priorityPrefix' | 'priorityMap'>,
	priority: string
): string {
	return Object.hasOwn(settings.priorityMap, priority)
		? settings.priorityMap[priority]!
		: `${settings.priorityPrefix}${priority}`;
}

/** The priority options against the priorities of the project (a hand-built fact list without them checks nothing). */
function checkPriorities(settings: GitLabSettings, project: ProjectFacts): string | undefined {
	const { priorities } = project;
	if (priorities === undefined) return undefined;
	for (const key of Object.keys(settings.priorityMap)) {
		if (!priorities.includes(key)) {
			return `priorityMap.${key}: the project has no priority "${key}" (priorities: ${priorities.join(', ')})`;
		}
	}
	const owners = new Map<string, string>();
	for (const name of priorities) {
		const label = priorityLabelName(settings, name);
		const mapped = Object.hasOwn(settings.priorityMap, name);
		const bad = labelProblem(label);
		if (bad !== undefined) {
			return mapped
				? `priorityMap.${name}: the label is not usable: ${bad}`
				: `priorityPrefix: the label of the priority "${name}" is not usable: ${bad}`;
		}
		const owner = owners.get(label);
		if (owner !== undefined) {
			return `priorityMap.${mapped ? name : owner}: the label "${label}" would carry both "${owner}" and "${name}"; give each priority its own label`;
		}
		owners.set(label, name);
	}
	return undefined;
}

/** The page of the GitLab instance on the web, derived from the API address: `https://gitlab.com/api/v4` -> `https://gitlab.com`. */
export function webBaseOf(baseUrl: string): string {
	return baseUrl.replace(/\/api\/v4$/, '');
}
