// The options of the `github` strategy (`strategy.options` of a project's config.yml): parsed once, every problem a sentence that
// starts with the dotted key (the host turns it into `<file>: strategy.options.<key>: <problem>`). Pure: no I/O, no environment.
import type { ProjectFacts } from '../kinds.js';

/** How GitHub represents a task status: open or closed, a close reason, an optional label. */
export interface StatusRule {
	state: 'open' | 'closed';
	/** Closed statuses only. Absent: `completed` for a positive terminal status, `not_planned` for a negative one. */
	reason?: CloseReason;
	/** A label that must be on the issue (the intermediate statuses: `status:in-progress`). */
	label?: string;
}

export type CloseReason = 'completed' | 'not_planned' | 'duplicate';

/** A task type as GitHub holds it: a native issue type (by name) or a label. */
export interface TypeRule {
	issueType?: string;
	label?: string;
}

export type TokenSource = { kind: 'env'; name: string } | { kind: 'file'; path: string };

export interface GitHubSettings {
	repo: { owner: string; name: string; full: string };
	/** No trailing slash: `https://api.github.com`, or `https://HOST/api/v3` for GitHub Enterprise Server. */
	baseUrl: string;
	token: TokenSource;
	statusMap: Record<string, StatusRule>;
	typePrefix: string;
	typeMap: Record<string, TypeRule>;
	metaPrefix: string;
	pageSize: number;
	maxPages: number;
	cacheTtlSeconds: number;
	timeoutSeconds: number;
	/** Least time between the start of two writes. GitHub asks integrators to go slowly with content-creating requests: 1 s. */
	writeSpacingSeconds: number;
}

/** The documented option names, in the order the documentation lists them. */
export const GITHUB_OPTION_NAMES: readonly string[] = [
	'repo',
	'baseUrl',
	'tokenEnv',
	'tokenFile',
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

export const DEFAULT_BASE_URL = 'https://api.github.com';
/** GitHub refuses a label name above this many characters (measured on the real API). */
export const GITHUB_LABEL_MAX = 50;

const STATE_KEYS = ['state', 'label', 'reason'] as const;
const CLOSE_REASONS: readonly CloseReason[] = ['completed', 'not_planned', 'duplicate'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const found = (value: unknown): string => (Array.isArray(value) ? 'a list' : (JSON.stringify(value) ?? String(value)));

const isMapping = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** What GitHub would refuse in a label name, as a sentence about `quoted` (the name as written); undefined when it is fine. */
export function labelProblem(name: string): string | undefined {
	if (name.includes(',')) return `"${name}" contains a comma, which GitHub refuses in a label name`;
	if (name !== name.trim()) return `"${name}" starts or ends with a space, which GitHub trims`;
	if (name.length > GITHUB_LABEL_MAX) {
		return `"${name}" is ${name.length} characters; GitHub label names are at most ${GITHUB_LABEL_MAX}`;
	}
	return undefined;
}

type Parsed<T> = { value: T } | { problem: string };

function parseRepo(value: unknown): Parsed<GitHubSettings['repo']> {
	if (value === undefined || value === '') {
		return { problem: 'repo: required (owner/name, for example wadeck-app/task)' };
	}
	if (typeof value !== 'string') return { problem: `repo: must be a string like owner/name, found ${found(value)}` };
	if (!REPO.test(value)) return { problem: `repo: "${value}" is not of the form owner/name` };
	const [owner, name] = value.split('/') as [string, string];
	return { value: { owner, name, full: value } };
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
	return { value: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

function parseToken(options: Record<string, unknown>): Parsed<TokenSource> {
	const { tokenEnv, tokenFile } = options;
	if (tokenEnv !== undefined && tokenFile !== undefined) {
		return { problem: 'tokenFile: give tokenEnv or tokenFile, not both' };
	}
	if (tokenEnv === undefined && tokenFile === undefined) {
		return {
			problem:
				'tokenEnv: required (the NAME of the environment variable that holds the token, for example GITHUB_TOKEN; or give tokenFile)',
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
	return `${rule.state}|${rule.reason ?? ''}|${rule.label?.toLowerCase() ?? ''}`;
}

function describeSignature(rule: StatusRule): string {
	return `state ${rule.state}${rule.reason === undefined ? '' : `, reason ${rule.reason}`}, ${
		rule.label === undefined ? 'no label' : `label ${rule.label}`
	}`;
}

function parseStatusEntry(status: string, value: unknown): Parsed<StatusRule> {
	const at = `statusMap.${status}`;
	if (!isMapping(value)) {
		return { problem: `${at}: must be a mapping with state (and optionally label, reason), found ${found(value)}` };
	}
	for (const key of Object.keys(value)) {
		if (!(STATE_KEYS as readonly string[]).includes(key)) {
			return { problem: `${at}.${key}: unknown key (valid: ${STATE_KEYS.join(', ')})` };
		}
	}
	const { state, label, reason } = value;
	if (state === undefined) return { problem: `${at}.state: required ("open" or "closed")` };
	if (state !== 'open' && state !== 'closed') {
		return { problem: `${at}.state: must be "open" or "closed", found ${found(state)}` };
	}
	if (reason !== undefined) {
		if (state === 'open') {
			return { problem: `${at}.reason: only a closed status has a reason (GitHub opens issues without one)` };
		}
		if (!(CLOSE_REASONS as readonly unknown[]).includes(reason)) {
			return {
				problem: `${at}.reason: must be "completed", "not_planned" or "duplicate", found ${found(reason)}`,
			};
		}
	}
	if (label !== undefined) {
		if (typeof label !== 'string' || label === '') {
			return { problem: `${at}.label: must be a label name, found ${found(label)}` };
		}
		const bad = labelProblem(label);
		if (bad !== undefined) return { problem: `${at}.label: ${bad}` };
	}
	return {
		value: {
			state,
			...(reason === undefined ? {} : { reason: reason as CloseReason }),
			...(label === undefined ? {} : { label: label as string }),
		},
	};
}

function parseStatusMap(value: unknown): Parsed<Record<string, StatusRule>> {
	if (value === undefined) {
		return {
			problem:
				'statusMap: required (task status -> GitHub representation, for example { todo: { state: open }, done: { state: closed } })',
		};
	}
	if (!isMapping(value)) {
		return {
			problem: `statusMap: must be a mapping of status to { state, label?, reason? }, found ${found(value)}`,
		};
	}
	if (Object.keys(value).length === 0) return { problem: 'statusMap: must map at least one status' };
	const map: Record<string, StatusRule> = {};
	const owners = new Map<string, string>();
	for (const [status, entry] of Object.entries(value)) {
		const parsed = parseStatusEntry(status, entry);
		if ('problem' in parsed) return parsed;
		// Two open statuses collide on their label alone. Closed ones also depend on the default reason of their outcome,
		// which only the project knows: checkOptionsAgainstProject compares them.
		if (parsed.value.state === 'open') {
			const signature = signatureOf(parsed.value);
			const owner = owners.get(signature);
			if (owner !== undefined) {
				return {
					problem: `statusMap.${status}: the same GitHub representation as "${owner}" (${describeSignature(parsed.value)}): give one of them ${
						parsed.value.label === undefined ? 'a label' : 'another label'
					}`,
				};
			}
			owners.set(signature, status);
		}
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

function parsePrefixes(options: Record<string, unknown>): Parsed<{ typePrefix: string; metaPrefix: string }> {
	const read = (key: 'typePrefix' | 'metaPrefix', fallback: string): Parsed<string> => {
		const value = options[key] ?? fallback;
		if (typeof value !== 'string' || value === '') {
			return { problem: `${key}: must be a non-empty label prefix, found ${found(value)}` };
		}
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
			return { problem: `${at}: give issueType (a GitHub issue type) or label` };
		}
		if (issueType !== undefined && label !== undefined) {
			return { problem: `${at}.label: give issueType or label, not both` };
		}
		const key = issueType === undefined ? 'label' : 'issueType';
		const name = issueType ?? label;
		if (typeof name !== 'string' || name.trim() === '') {
			return { problem: `${at}.${key}: must be a non-empty name, found ${found(name)}` };
		}
		if (key === 'label') {
			const bad = labelProblem(name);
			if (bad !== undefined) return { problem: `${at}.label: ${bad}` };
		}
		map[type] = key === 'label' ? { label: name } : { issueType: name };
	}
	return { value: map };
}

function parseCache(value: unknown): Parsed<number> {
	if (value === undefined) return { value: 60 };
	if (!isMapping(value))
		return { problem: `cache: must be a mapping like { ttlSeconds: 60 }, found ${found(value)}` };
	for (const key of Object.keys(value)) {
		if (key !== 'ttlSeconds') return { problem: `cache.${key}: unknown key (valid: ttlSeconds)` };
	}
	const ttl = value['ttlSeconds'];
	if (ttl === undefined) return { value: 60 };
	if (typeof ttl !== 'number' || !(ttl >= 0)) {
		return { problem: `cache.ttlSeconds: must be zero or a positive number of seconds, found ${found(ttl)}` };
	}
	return { value: ttl };
}

/** Parses `strategy.options` (without `fills`, which the host reads). Returns the settings, or the first problem as a sentence starting with its key. */
export function parseGitHubOptions(
	options: Record<string, unknown>
): { settings: GitHubSettings } | { problem: string } {
	for (const key of Object.keys(options)) {
		if (!GITHUB_OPTION_NAMES.includes(key)) {
			return {
				problem: `${key}: unknown option for strategy "github" (known: ${GITHUB_OPTION_NAMES.join(', ')})`,
			};
		}
	}
	const repo = parseRepo(options['repo']);
	if ('problem' in repo) return repo;
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
			repo: repo.value,
			baseUrl: baseUrl.value,
			token: token.value,
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

/** The close reason a closed status gets when the map does not say: `completed` after a good ending, `not_planned` after a bad one. */
export function effectiveReason(
	rule: StatusRule,
	outcome: 'positive' | 'negative' | undefined
): CloseReason | undefined {
	if (rule.state !== 'closed') return undefined;
	return rule.reason ?? (outcome === 'negative' ? 'not_planned' : 'completed');
}

function exampleEntry(status: ProjectFacts['statuses'][number]): string {
	if (status.terminal) {
		return status.outcome === 'negative'
			? `${status.name}: { state: closed, reason: not_planned }`
			: `${status.name}: { state: closed }`;
	}
	return status.default
		? `${status.name}: { state: open }`
		: `${status.name}: { state: open, label: 'status:${status.name}' }`;
}

/**
 * Checks the map against the statuses and types of the project, at load: every status has exactly one representation, the
 * terminal ones close the issue with a reason that matches their outcome, one open status needs no label, and every type fits a label.
 * Returns the first problem as a sentence starting with its key, or undefined.
 */
export function checkOptionsAgainstProject(settings: GitHubSettings, project: ProjectFacts): string | undefined {
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
		if (rule.reason !== undefined) {
			if (status.outcome === 'positive' && rule.reason !== 'completed') {
				return `statusMap.${status.name}.reason: the status "${status.name}" ends well (outcome positive), so GitHub must close it as "completed"`;
			}
			if (status.outcome === 'negative' && rule.reason === 'completed') {
				return `statusMap.${status.name}.reason: the status "${status.name}" ends badly (outcome negative), so GitHub must close it as "not_planned" or "duplicate"`;
			}
		}
	}
	if (!project.statuses.some(status => status.terminal)) {
		return 'statusMap: the project has no terminal status, so a closed issue would map to nothing; mark one status terminal in the config (statuses: - name: done / terminal: true)';
	}
	// The effective reasons make two closed statuses collide even when only one of them wrote its reason.
	const owners = new Map<string, string>();
	for (const status of project.statuses) {
		const rule = statusMap[status.name]!;
		const signature = signatureOf({ ...rule, reason: effectiveReason(rule, status.outcome) });
		const owner = owners.get(signature);
		if (owner !== undefined) {
			return `statusMap.${status.name}: the same GitHub representation as "${owner}" (${describeSignature({ ...rule, reason: effectiveReason(rule, status.outcome) })}): give one of them ${
				rule.label === undefined ? 'a label' : 'another label'
			} or another reason`;
		}
		owners.set(signature, status.name);
	}
	const unlabelledOpen = project.statuses.filter(status => {
		const rule = statusMap[status.name]!;
		return rule.state === 'open' && rule.label === undefined;
	});
	if (unlabelledOpen.length === 0) {
		const fallback = project.statuses.find(status => status.default && !status.terminal) ?? project.statuses[0]!;
		return `statusMap: no open status without a label; an issue created on GitHub carries no status label, so one open status (for example "${fallback.name}") must be mapped to { state: open } alone`;
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
		if (bad !== undefined) {
			return label.length > GITHUB_LABEL_MAX
				? `typePrefix: the label of the type "${type}" would be ${label.length} characters (${label}); GitHub label names are at most ${GITHUB_LABEL_MAX}`
				: `typePrefix: the label of the type "${type}" is not usable: ${bad}`;
		}
	}
	return undefined;
}
