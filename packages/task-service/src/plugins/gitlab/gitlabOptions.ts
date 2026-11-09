// The options of the `gitlab` strategy (`strategy.options` of a project's config.yml): parsed once, every problem a sentence that
// starts with the dotted key (the host turns it into `<file>: strategy.options.<key>: <problem>`). Pure: no I/O, no environment.
//
// NOT VERIFIED AGAINST A REAL GITLAB: everything here follows docs.gitlab.com (see the "GitLab verification log" of the storage
// plan). The tier is DECLARED by the user and never guessed: scoped labels and the `blocks` / `is_blocked_by` links are Premium and
// Ultimate only, and nothing task does depends on a silent probe.
import type { ProjectFacts } from '../kinds.js';

/** The GitLab plan the user declares. It decides which features the strategy offers (scoped labels, blocking links). */
export type GitLabTier = 'free' | 'premium' | 'ultimate';
export const GITLAB_TIERS: readonly GitLabTier[] = ['free', 'premium', 'ultimate'];

/** How GitLab represents a task status: opened or closed, and an optional label (GitLab has no close reason). */
export interface StatusRule {
	state: 'open' | 'closed';
	/** A label that must be on the issue (`status:in-progress`, or the scoped `status::in-progress` on Premium and Ultimate). */
	label?: string;
}

/** A task type as GitLab holds it: a native issue type (REST accepts `incident` and `test_case` on create AND update) or a label. */
export interface TypeRule {
	issueType?: NativeIssueType;
	label?: string;
}

/** The issue types the REST API can both create and update (`task` is create-only, `issue` is the default for everything else). */
export type NativeIssueType = 'incident' | 'test_case';
export const NATIVE_ISSUE_TYPES: readonly NativeIssueType[] = ['incident', 'test_case'];

export type TokenSource = { kind: 'env'; name: string } | { kind: 'file'; path: string };

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
	tier: GitLabTier;
	/** `tier` is premium or ultimate: scoped labels (`key::value`) exist and exclude each other natively. */
	scopedLabels: boolean;
	statusMap: Record<string, StatusRule>;
	typePrefix: string;
	typeMap: Record<string, TypeRule>;
	metaPrefix: string;
	pageSize: number;
	maxPages: number;
	cacheTtlSeconds: number;
	timeoutSeconds: number;
	/** Least time between the start of two writes (a polite pace: GitLab.com allows 60 notes and 200 issues a minute). */
	writeSpacingSeconds: number;
}

/** The documented option names, in the order the documentation lists them. */
export const GITLAB_OPTION_NAMES: readonly string[] = [
	'project',
	'baseUrl',
	'tokenEnv',
	'tokenFile',
	'tier',
	'statusMap',
	'typePrefix',
	'typeMap',
	'metaPrefix',
	'pageSize',
	'maxPages',
	'cache',
	'timeoutSeconds',
	'writeSpacingSeconds',
];

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

const found = (value: unknown): string => (Array.isArray(value) ? 'a list' : (JSON.stringify(value) ?? String(value)));

const isMapping = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

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

type Parsed<T> = { value: T } | { problem: string };

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

function parseTier(value: unknown): Parsed<GitLabTier> {
	if (value === undefined) {
		return {
			problem: `tier: required, one of ${GITLAB_TIERS.join(', ')}: the plan of the GitLab project decides what exists (scoped labels and blocking links are Premium and Ultimate only) and task never guesses it; \`task strategy check\` warns when the declaration looks wrong`,
		};
	}
	if (typeof value !== 'string' || !(GITLAB_TIERS as readonly string[]).includes(value)) {
		return { problem: `tier: must be one of ${GITLAB_TIERS.join(', ')}, found ${found(value)}` };
	}
	return { value: value as GitLabTier };
}

/** True for a label written with the scoped syntax (`key::value`), which only Premium and Ultimate give a meaning to. */
export const isScopedLabelName = (name: string): boolean => name.includes('::');

function signatureOf(rule: StatusRule): string {
	return `${rule.state}|${rule.label?.toLowerCase() ?? ''}`;
}

function describeSignature(rule: StatusRule): string {
	return `state ${rule.state}, ${rule.label === undefined ? 'no label' : `label ${rule.label}`}`;
}

function parseStatusEntry(status: string, value: unknown, tier: GitLabTier): Parsed<StatusRule> {
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
		const bad = labelProblem(label) ?? scopedProblem(label, tier);
		if (bad !== undefined) return { problem: `${at}.label: ${bad}` };
	}
	return { value: { state, ...(label === undefined ? {} : { label: label as string }) } };
}

/** A scoped label on the Free plan is an ordinary label with colons in its name: refused, because it would promise an exclusivity it does not have. */
function scopedProblem(name: string, tier: GitLabTier): string | undefined {
	if (tier === 'free' && isScopedLabelName(name)) {
		return `"${name}" is a scoped label (key::value), which exists on GitLab Premium and Ultimate only; on the free tier use one colon (for example "status:in-progress") or declare tier: premium`;
	}
	return undefined;
}

function parseStatusMap(value: unknown, tier: GitLabTier): Parsed<Record<string, StatusRule>> {
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
		const parsed = parseStatusEntry(status, entry, tier);
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

function parseNumber(
	options: Record<string, unknown>,
	key: string,
	fallback: number,
	rule: (n: number) => boolean,
	expected: string
): Parsed<number> {
	const value = options[key];
	if (value === undefined) return { value: fallback };
	if (typeof value !== 'number' || !rule(value))
		return { problem: `${key}: must be ${expected}, found ${found(value)}` };
	return { value };
}

function parsePrefixes(
	options: Record<string, unknown>,
	tier: GitLabTier
): Parsed<{ typePrefix: string; metaPrefix: string }> {
	// Scoped labels exclude each other natively on Premium and Ultimate: the defaults use them there, one colon on Free.
	const scoped = tier !== 'free';
	const read = (key: 'typePrefix' | 'metaPrefix', fallback: string): Parsed<string> => {
		const value = options[key] ?? fallback;
		if (typeof value !== 'string' || value === '') {
			return { problem: `${key}: must be a non-empty label prefix, found ${found(value)}` };
		}
		const bad = labelProblem(value) ?? scopedProblem(value, tier);
		if (bad !== undefined) return { problem: `${key}: ${bad}` };
		return { value };
	};
	const type = read('typePrefix', scoped ? 'type::' : 'type:');
	if ('problem' in type) return type;
	const meta = read('metaPrefix', scoped ? 'meta::' : 'meta:');
	if ('problem' in meta) return meta;
	if (scoped && !meta.value.endsWith('::')) {
		return {
			problem: `metaPrefix: "${meta.value}" must end with "::" on tier ${tier}: a metadata entry is the scoped label ${meta.value}key::value, so two values of one key exclude each other`,
		};
	}
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

function parseTypeMap(value: unknown, tier: GitLabTier): Parsed<Record<string, TypeRule>> {
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
			if (typeof issueType !== 'string' || !(NATIVE_ISSUE_TYPES as readonly string[]).includes(issueType)) {
				return {
					problem: `${at}.issueType: must be ${NATIVE_ISSUE_TYPES.join(' or ')} (the issue types the REST API can both create and update; "task" can only be given at creation), found ${found(issueType)}`,
				};
			}
			map[type] = { issueType: issueType as NativeIssueType };
			continue;
		}
		if (typeof label !== 'string' || label.trim() === '') {
			return { problem: `${at}.label: must be a non-empty name, found ${found(label)}` };
		}
		const bad = labelProblem(label) ?? scopedProblem(label, tier);
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

function parseCache(value: unknown): Parsed<number> {
	if (value === undefined) return { value: 30 };
	if (!isMapping(value))
		return { problem: `cache: must be a mapping like { ttlSeconds: 30 }, found ${found(value)}` };
	for (const key of Object.keys(value)) {
		if (key !== 'ttlSeconds') return { problem: `cache.${key}: unknown key (valid: ttlSeconds)` };
	}
	const ttl = value['ttlSeconds'];
	if (ttl === undefined) return { value: 30 };
	if (typeof ttl !== 'number' || !(ttl >= 0)) {
		return { problem: `cache.ttlSeconds: must be zero or a positive number of seconds, found ${found(ttl)}` };
	}
	return { value: ttl };
}

/** Parses `strategy.options` (without `fills`, which the host reads). Returns the settings, or the first problem as a sentence starting with its key. */
export function parseGitLabOptions(
	options: Record<string, unknown>
): { settings: GitLabSettings } | { problem: string } {
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
	const tier = parseTier(options['tier']);
	if ('problem' in tier) return tier;
	const statusMap = parseStatusMap(options['statusMap'], tier.value);
	if ('problem' in statusMap) return statusMap;
	const prefixes = parsePrefixes(options, tier.value);
	if ('problem' in prefixes) return prefixes;
	const typeMap = parseTypeMap(options['typeMap'], tier.value);
	if ('problem' in typeMap) return typeMap;
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
	return {
		settings: {
			project: project.value,
			baseUrl: baseUrl.value,
			token: token.value,
			tier: tier.value,
			scopedLabels: tier.value !== 'free',
			statusMap: statusMap.value,
			typePrefix: prefixes.value.typePrefix,
			typeMap: typeMap.value,
			metaPrefix: prefixes.value.metaPrefix,
			pageSize: pageSize.value,
			maxPages: maxPages.value,
			cacheTtlSeconds: cache.value,
			timeoutSeconds: timeout.value,
			writeSpacingSeconds: spacing.value,
		},
	};
}

function exampleEntry(status: ProjectFacts['statuses'][number], tier: GitLabTier): string {
	const label = (name: string): string => `'status${tier === 'free' ? ':' : '::'}${name}'`;
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
			return `statusMap.${status.name}: the status "${status.name}" of the project has no entry; add it, for example: ${exampleEntry(status, settings.tier)}`;
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
	return undefined;
}

/** The page of the GitLab instance on the web, derived from the API address: `https://gitlab.com/api/v4` -> `https://gitlab.com`. */
export function webBaseOf(baseUrl: string): string {
	return baseUrl.replace(/\/api\/v4$/, '');
}
