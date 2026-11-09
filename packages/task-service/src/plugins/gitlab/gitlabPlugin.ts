// The built-in strategy `gitlab` (plugins.gitlab.default, alias gitlab): the tasks of a project are the issues of a GitLab project,
// read and written through the official REST API v4 with Node fetch (no vendor CLI, no SDK). Writes are in gitlabWrites.ts.
//
// NOT VERIFIED AGAINST A REAL GITLAB: no instance and no token were available when this was written. Everything follows
// docs.gitlab.com and a fake server modelled on it; `task strategy check` says so on every run.
import type { CheckLine, ReadNotice, StrategyContext, StrategyInstance, StrategyPlugin } from '../kinds.js';
import { GITLAB_CAPABILITIES, GitLabBackend, gitlabCapabilities } from './GitLabBackend.js';
import { checkGitLab } from './gitlabCheck.js';
import { GitLabClient } from './gitlabClient.js';
import { StatusMapper } from './gitlabStatusMapping.js';
import { checkOptionsAgainstProject, parseGitLabOptions, webBaseOf } from './gitlabOptions.js';
import type { GitLabSettings } from './gitlabOptions.js';
import { resolveToken } from './gitlabToken.js';
import { gitlabTraits } from './gitlabTraits.js';

function tokenSentence(settings: GitLabSettings): string {
	return settings.token.kind === 'env'
		? `the environment variable ${settings.token.name} (strategy.options.tokenEnv)`
		: `the file ${settings.token.path} (strategy.options.tokenFile)`;
}

/** The page of an issue on the web: the path form of the project is known, a numeric id only has the API address. */
export function issueUrlOf(settings: GitLabSettings): (iid: number) => string {
	const web = webBaseOf(settings.baseUrl);
	const { path, apiId } = settings.project;
	return iid =>
		path === undefined ? `${settings.baseUrl}/projects/${apiId}/issues/${iid}` : `${web}/${path}/-/issues/${iid}`;
}

export const gitlabPlugin: StrategyPlugin = {
	extensionPoint: 'strategy',
	backendKind: 'gitlab',
	capabilities: GITLAB_CAPABILITIES,
	// The tier is an option: the capabilities of a project depend on it (blocking links), not only on its fills.
	capabilitiesFor(fills, options) {
		const parsed = parseGitLabOptions(options);
		return gitlabCapabilities('problem' in parsed ? 'free' : parsed.settings.tier, fills);
	},
	// Status, type and links are mapped by the options and the tier; meta, deletion, duplicates and causedBy have no native place.
	fillTechniques: {
		meta: ['labels', 'body-block'],
		delete: ['tombstone', 'hard'],
		'linkTypes.duplicateOf': ['relate-block'],
		'linkTypes.causedBy': ['relate-block'],
	},
	// What is only partly true, said once and printed by `task strategy show` as `partial`.
	capabilityNotes: {
		history: 'derived from the label and state events (the initial state is not recorded by GitLab)',
		activity: 'the label events; title and description edits are system notes (free text) and are not read',
		search: 'the issues search (title and description, matching rule not documented); only the title counts here',
		'linkTypes.duplicateOf':
			'GitLab has no readable duplicate that task writes without a marker: with the relate-block fill task keeps it in a managed block of the description and adds a relates_to link',
		'linkTypes.causedBy':
			'no GitLab link means "caused by": with the relate-block fill task keeps it in a managed block of the description and adds a relates_to link',
	},

	validate(options) {
		const parsed = parseGitLabOptions(options);
		return 'problem' in parsed ? parsed.problem : undefined;
	},

	validateForProject(options, project) {
		const parsed = parseGitLabOptions(options);
		return 'problem' in parsed ? parsed.problem : checkOptionsAgainstProject(parsed.settings, project);
	},

	traitsFor(options, fills) {
		const parsed = parseGitLabOptions(options);
		if ('problem' in parsed) throw new Error(parsed.problem);
		return gitlabTraits(parsed.settings, fills);
	},

	locationOf(options) {
		const parsed = parseGitLabOptions(options);
		if ('problem' in parsed) return undefined;
		// A numeric id and the path of the same project cannot be told apart without asking GitLab: two spellings are two locations.
		return `gitlab ${parsed.settings.baseUrl.toLowerCase()} ${parsed.settings.project.ref.toLowerCase()}`;
	},

	describe() {
		return {
			summary:
				'The issues of a GitLab project, read and written through the official REST API v4 (no glab CLI). NOT verified against a real GitLab instance. The tier you declare decides what exists: scoped labels and blocking links are Premium and Ultimate only; there is no parent/child.',
			options: {
				project: 'path group/project or group/subgroup/project, or the numeric project id (required)',
				baseUrl:
					'API address, ending with /api/v4; default https://gitlab.com/api/v4, self-managed: https://HOST/api/v4',
				tokenEnv:
					'NAME of the environment variable holding the token (required, or tokenFile); scope api to write, read_api to read only',
				tokenFile: 'path of a file holding the token (instead of tokenEnv); POSIX: readable by you only',
				tier: 'free | premium | ultimate: the plan of the GitLab project, declared by you and never guessed (required); strategy check warns when it looks wrong',
				statusMap:
					'task status -> { state: open|closed, label? }; every status of the project, one open and one closed status without label (required)',
				typePrefix:
					'label prefix of the task type; default "type:" on free, "type::" (scoped) on premium and ultimate',
				typeMap:
					'task type -> { issueType: incident|test_case } or { label: <name> }; default: the label typePrefix + type',
				metaPrefix:
					'label prefix of metadata with fills.meta: labels; default "meta:" (labels meta:key=value) on free, "meta::" (labels meta::key::value) on premium and ultimate',
				pageSize: 'items per request, 1 to 100; default 100',
				maxPages: 'pages one read may walk before failing loudly, 1 to 1000; default 50',
				cache: '{ ttlSeconds }: seconds a read is served from memory without asking GitLab; default 30, 0 = never',
				timeoutSeconds: 'time limit of one request; default 15',
				writeSpacingSeconds: 'least time between two writes; default 1',
				fills: 'meta: labels | body-block; delete: hard | tombstone; linkTypes.duplicateOf / linkTypes.causedBy: relate-block (the approximate ones need fidelity: degrade)',
			},
			snippet: [
				'strategy:',
				'    type: gitlab',
				'    options:',
				'        project: group/project',
				'        tier: free',
				'        tokenEnv: GITLAB_TOKEN',
				'        statusMap:',
				'            todo: { state: open }',
				"            in-progress: { state: open, label: 'status:in-progress' }",
				'            done: { state: closed }',
				"            cancelled: { state: closed, label: 'status:cancelled' }",
			].join('\n'),
		};
	},

	async create(rawOptions, context: StrategyContext) {
		const parsed = parseGitLabOptions(rawOptions);
		if ('problem' in parsed) throw new Error(parsed.problem);
		const { settings } = parsed;
		const projectRef = settings.project.ref;
		const token = resolveToken(settings.token, context.env, {
			source: context.source,
			project: context.project.name,
			gitlabProject: projectRef,
		});

		const web = webBaseOf(settings.baseUrl);
		const projectUrl =
			settings.project.path === undefined
				? `${web}/projects/${settings.project.apiId}`
				: `${web}/${settings.project.path}`;
		const issueUrl = issueUrlOf(settings);
		const notices: ReadNotice[] = [];
		const seen = new Set<string>();
		const notice = (next: ReadNotice): void => {
			if (seen.has(next.text)) return;
			seen.add(next.text);
			notices.push(next);
		};
		const debug = context.env['TASK_DEBUG'] === '1';
		const client = new GitLabClient({
			baseUrl: settings.baseUrl,
			token,
			project: projectRef,
			tokenHint: tokenSentence(settings),
			timeoutMs: settings.timeoutSeconds * 1000,
			writeSpacingMs: settings.writeSpacingSeconds * 1000,
			// A migration reads the system as it is now: no answer is served from the cache.
			cacheTtlMs: context.freshReads === true ? 0 : settings.cacheTtlSeconds * 1000,
			maxPages: settings.maxPages,
			onNotice: notice,
			...(debug ? { debug: (line: string) => context.log('info', `gitlab: ${line}`) } : {}),
		});
		const backend = new GitLabBackend({
			settings,
			client,
			issueUrl,
			newIssueUrl: `${projectUrl}/-/issues/new`,
			fills: context.fills,
			map: {
				settings,
				mapper: new StatusMapper(settings.statusMap, context.statuses, issueUrl),
				metaFromLabels: context.fills['meta']?.use === 'labels',
				metaFromBlock: context.fills['meta']?.use === 'body-block',
				projectTypes: context.types,
				notice,
				issueUrl,
			},
		});
		const instance: StrategyInstance = {
			backend,
			describe: () => [
				`project: ${projectRef} (${projectUrl})`,
				`api: ${settings.baseUrl}`,
				`tier: ${settings.tier} (declared; ${
					settings.scopedLabels
						? 'scoped labels and blocking links are used'
						: 'no scoped labels, no blocking links'
				})`,
				`token: ${tokenSentence(settings)}`,
				`cache: memory only, served without asking for ${settings.cacheTtlSeconds} s`,
				'mode: read and write (writes one at a time, at least ' +
					`${settings.writeSpacingSeconds} s apart; optimistic, not atomic: GitLab has no conditional write)`,
				'NOT verified against a real GitLab instance (built from docs.gitlab.com and a fake server)',
			],
			check: (): Promise<CheckLine[]> =>
				checkGitLab({
					client,
					settings,
					project: { statuses: context.statuses, types: context.types },
					projectUrl,
					now: Date.now,
					tokenHint: tokenSentence(settings),
					fills: context.fills,
					projectName: context.project.name,
				}),
			takeNotices: () => notices.splice(0, notices.length),
			dispose: () => Promise.resolve(),
		};
		return instance;
	},
};
