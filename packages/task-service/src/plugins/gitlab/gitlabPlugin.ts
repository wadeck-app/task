// The built-in strategy `gitlab` (plugins.gitlab.default, alias gitlab): the tasks of a project are the issues of a GitLab project,
// read and written through the official REST API v4 with Node fetch (no vendor CLI, no SDK). Writes are in gitlabWrites.ts.
//
// Verified live on gitlab.com Free with a fine-grained token (2026-11-09); `task strategy check` says what was and was not verified.
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
	capabilitiesFor(fills) {
		return gitlabCapabilities(fills);
	},
	// Status, type and links are mapped by the options; meta, deletion, duplicates and causedBy have no native place.
	fillTechniques: {
		meta: ['labels', 'body-block'],
		delete: ['tombstone', 'hard'],
		'linkTypes.duplicateOf': ['relate-block'],
		'linkTypes.causedBy': ['relate-block'],
	},
	// What is only partly true, said once and printed by `task strategy show` as `partial`.
	capabilityNotes: {
		history: 'derived from the label and state events (the initial state is not recorded by GitLab)',
		activity:
			'the label events, plus the title, description, type and parent edits, which GitLab records only as system notes (free text) and task reads from them',
		hierarchy:
			'two levels: an Issue or Incident is the parent, a native Task the child (GraphQL work items); set-parent converts an Issue child to a native Task',
		search: 'the server matches the title AND the description (case-insensitive, every word of the text must start a word of the issue); task shows only the hits whose TITLE contains the text, so a match in the description alone is not listed',
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
				'The issues of a GitLab project, read and written through the official REST API v4 (no glab CLI). Free tier only: no blocking links (blockedBy is refused); a label like status::x is a plain label.',
			options: {
				project: 'path group/project or group/subgroup/project, or the numeric project id (required)',
				baseUrl:
					'API address, ending with /api/v4; default https://gitlab.com/api/v4, self-managed: https://HOST/api/v4',
				tokenEnv:
					'NAME of the environment variable holding the token (required, or tokenFile); scope api to write, read_api to read only',
				tokenFile: 'path of a file holding the token (instead of tokenEnv); POSIX: readable by you only',
				statusMap:
					'task status -> { state: open|closed, label? }; every status of the project, one open and one closed status without label (required)',
				typePrefix: 'label prefix of the task type; default "type:"',
				typeMap:
					'task type -> { issueType: incident } or { label: <name> }; default: the label typePrefix + type',
				metaPrefix: 'label prefix of metadata with fills.meta: labels; default "meta:" (labels meta:key=value)',
				pageSize: 'items per request, 1 to 100; default 100',
				maxPages: 'pages one read may walk before failing loudly, 1 to 1000; default 50',
				cache: '{ ttlSeconds }: seconds a read is served from memory without asking GitLab; default 30, 0 = never',
				timeoutSeconds: 'time limit of one request; default 15',
				writeSpacingSeconds: 'least time between two writes; default 1',
				rateLimit:
					'{ maxWaitSeconds }: longest wait for the rate limit window to reopen (reads and writes), default 70, 0 = never wait',
				fills: 'meta: labels | body-block; delete: hard | tombstone; linkTypes.duplicateOf / linkTypes.causedBy: relate-block (the approximate ones need fidelity: degrade)',
			},
			snippet: [
				'strategy:',
				'    type: gitlab',
				'    options:',
				'        project: group/project',
				'        tokenEnv: GITLAB_TOKEN',
				'        statusMap:',
				'            todo: { state: open }',
				"            in-progress: { state: open, label: 'status::in-progress' }",
				'            done: { state: closed }',
				"            cancelled: { state: closed, label: 'status::cancelled' }",
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
			maxWaitMs: settings.rateLimitMaxWaitSeconds * 1000,
			// A wait is shown at once on stderr (the command would look frozen) and kept in the task log.
			notice: (text: string) => {
				process.stderr.write(`${text}\n`);
				context.log('info', `gitlab: ${text}`);
			},
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
				`token: ${tokenSentence(settings)}`,
				`cache: memory only, served without asking for ${settings.cacheTtlSeconds} s`,
				'mode: read and write (writes one at a time, at least ' +
					`${settings.writeSpacingSeconds} s apart; optimistic, not atomic: GitLab has no conditional write)`,
				`rate limit: waits up to ${settings.rateLimitMaxWaitSeconds} s for the window to reopen (strategy.options.rateLimit.maxWaitSeconds)`,
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
