import type { ProjectFacts } from '../kinds.js';
import {
	checkOptionsAgainstProject,
	labelProblem,
	parseGitLabOptions,
	webBaseOf,
	DEFAULT_BASE_URL,
} from './gitlabOptions.js';
import type { GitLabSettings } from './gitlabOptions.js';

const BASE = {
	project: 'acme/shop',
	tokenEnv: 'GITLAB_TOKEN',
	tier: 'free',
	statusMap: { backlog: { state: 'open' }, done: { state: 'closed' } },
};

function settingsOf(extra: Record<string, unknown> = {}): GitLabSettings {
	const parsed = parseGitLabOptions({ ...BASE, ...extra });
	if ('problem' in parsed) throw new Error(parsed.problem);
	return parsed.settings;
}

function problemOf(extra: Record<string, unknown>): string {
	const parsed = parseGitLabOptions({ ...BASE, ...extra });
	if (!('problem' in parsed)) throw new Error('expected a problem');
	return parsed.problem;
}

describe('parseGitLabOptions: project', () => {
	it('encodes a namespaced path with %2F', () => {
		const project = settingsOf({ project: 'group/sub/project' }).project;
		expect(project).toEqual({
			ref: 'group/sub/project',
			path: 'group/sub/project',
			apiId: 'group%2Fsub%2Fproject',
		});
	});

	it('takes a numeric id as a string or a number, without a path', () => {
		expect(settingsOf({ project: '1234' }).project).toEqual({ ref: '1234', path: undefined, apiId: '1234' });
		expect(settingsOf({ project: 1234 }).project).toEqual({ ref: '1234', path: undefined, apiId: '1234' });
	});

	it('is required and must be a path or an id', () => {
		expect(problemOf({ project: undefined })).toMatch(/^project: required/);
		expect(problemOf({ project: 'shop' })).toMatch(/^project: "shop" is neither/);
		expect(problemOf({ project: 'a/b c' })).toMatch(/^project:/);
		expect(problemOf({ project: '/a/b' })).toMatch(/^project:/);
		expect(problemOf({ project: -3 })).toMatch(/^project:/);
		expect(problemOf({ project: ['a/b'] })).toMatch(/^project: must be/);
	});
});

describe('parseGitLabOptions: baseUrl', () => {
	it('defaults to gitlab.com and strips a trailing slash', () => {
		expect(settingsOf().baseUrl).toBe(DEFAULT_BASE_URL);
		expect(settingsOf({ baseUrl: 'https://git.example.com/api/v4/' }).baseUrl).toBe(
			'https://git.example.com/api/v4'
		);
	});

	it('accepts a relative URL root before /api/v4', () => {
		expect(settingsOf({ baseUrl: 'https://example.com/gitlab/api/v4' }).baseUrl).toBe(
			'https://example.com/gitlab/api/v4'
		);
	});

	it('must end with /api/v4 and carry no credentials, query or fragment', () => {
		expect(problemOf({ baseUrl: 'https://git.example.com' })).toMatch(/ends with \/api\/v4/);
		expect(problemOf({ baseUrl: 'https://git.example.com/api/v3' })).toMatch(/^baseUrl:/);
		expect(problemOf({ baseUrl: 'ftp://x/api/v4' })).toMatch(/^baseUrl:.*http/);
		expect(problemOf({ baseUrl: 'not a url' })).toMatch(/^baseUrl:/);
		expect(problemOf({ baseUrl: 'https://u:p@x/api/v4' })).toMatch(/credentials/);
		expect(problemOf({ baseUrl: 'https://x/api/v4?a=1' })).toMatch(/query/);
		expect(problemOf({ baseUrl: 42 })).toMatch(/^baseUrl: must be a string/);
	});

	it('derives the web address', () => {
		expect(webBaseOf('https://gitlab.com/api/v4')).toBe('https://gitlab.com');
		expect(webBaseOf('https://x.org/gitlab/api/v4')).toBe('https://x.org/gitlab');
	});
});

describe('parseGitLabOptions: token', () => {
	it('needs exactly one of tokenEnv and tokenFile, and tokenEnv must be a NAME', () => {
		expect(problemOf({ tokenEnv: undefined })).toMatch(/^tokenEnv: required/);
		expect(problemOf({ tokenFile: '/x' })).toMatch(/^tokenFile: give tokenEnv or tokenFile, not both/);
		expect(problemOf({ tokenEnv: 'glpat-abc def' })).toMatch(/^tokenEnv:.*NAME/);
		expect(problemOf({ tokenEnv: '1ABC' })).toMatch(/^tokenEnv:/);
		const file = parseGitLabOptions({ ...BASE, tokenEnv: undefined, tokenFile: '~/t' });
		expect('settings' in file && file.settings.token).toEqual({ kind: 'file', path: '~/t' });
		expect(problemOf({ tokenEnv: undefined, tokenFile: '' })).toMatch(/^tokenFile:/);
	});
});

describe('parseGitLabOptions: tier', () => {
	it('is required, explicit and one of free, premium, ultimate', () => {
		expect(problemOf({ tier: undefined })).toMatch(/^tier: required.*free, premium, ultimate/);
		expect(problemOf({ tier: 'gold' })).toMatch(/^tier: must be one of/);
		expect(settingsOf({ tier: 'free' }).scopedLabels).toBe(false);
		expect(settingsOf({ tier: 'premium' }).scopedLabels).toBe(true);
		expect(settingsOf({ tier: 'ultimate' }).scopedLabels).toBe(true);
	});

	it('refuses a scoped label on free, in statusMap, typeMap and prefixes', () => {
		expect(
			problemOf({ statusMap: { backlog: { state: 'open', label: 'status::x' }, done: { state: 'closed' } } })
		).toMatch(/^statusMap\.backlog\.label:.*Premium and Ultimate/);
		expect(problemOf({ typeMap: { bug: { label: 'type::bug' } } })).toMatch(/^typeMap\.bug\.label:.*scoped/);
		expect(problemOf({ typePrefix: 'kind::' })).toMatch(/^typePrefix:.*scoped/);
		expect(problemOf({ metaPrefix: 'm::' })).toMatch(/^metaPrefix:.*scoped/);
	});

	it('accepts scoped labels on premium', () => {
		const settings = settingsOf({
			tier: 'premium',
			statusMap: { backlog: { state: 'open', label: 'status::backlog' }, done: { state: 'closed' } },
		});
		expect(settings.statusMap['backlog']).toEqual({ state: 'open', label: 'status::backlog' });
	});
});

describe('parseGitLabOptions: prefixes', () => {
	it('defaults to one colon on free and the scoped syntax on premium and ultimate', () => {
		expect(settingsOf()).toMatchObject({ typePrefix: 'type:', metaPrefix: 'meta:' });
		expect(settingsOf({ tier: 'premium' })).toMatchObject({ typePrefix: 'type::', metaPrefix: 'meta::' });
		expect(settingsOf({ tier: 'ultimate' })).toMatchObject({ typePrefix: 'type::', metaPrefix: 'meta::' });
	});

	it('needs a metaPrefix ending with :: on premium', () => {
		expect(problemOf({ tier: 'premium', metaPrefix: 'meta:' })).toMatch(/^metaPrefix:.*must end with "::"/);
		expect(settingsOf({ tier: 'premium', metaPrefix: 'm::' }).metaPrefix).toBe('m::');
	});

	it('refuses prefixes that equal or contain each other', () => {
		expect(problemOf({ typePrefix: 'x:', metaPrefix: 'x:' })).toMatch(/^metaPrefix: must differ/);
		expect(problemOf({ typePrefix: 'x:', metaPrefix: 'x:y:' })).toMatch(/^metaPrefix:.*starts with typePrefix/);
		expect(problemOf({ typePrefix: 'm:t:', metaPrefix: 'm:' })).toMatch(/^typePrefix:.*starts with metaPrefix/);
		expect(problemOf({ typePrefix: '' })).toMatch(/^typePrefix: must be a non-empty/);
		expect(problemOf({ typePrefix: 'a,b:' })).toMatch(/^typePrefix:.*comma/);
	});
});

describe('parseGitLabOptions: statusMap', () => {
	it('is required and must be a non-empty mapping', () => {
		expect(problemOf({ statusMap: undefined })).toMatch(/^statusMap: required/);
		expect(problemOf({ statusMap: {} })).toMatch(/^statusMap: must map at least one/);
		expect(problemOf({ statusMap: [] })).toMatch(/^statusMap: must be a mapping/);
	});

	it('refuses a reason: GitLab has no close reason', () => {
		expect(problemOf({ statusMap: { done: { state: 'closed', reason: 'completed' } } })).toMatch(
			/^statusMap\.done\.reason: GitLab has no close reason/
		);
	});

	it('refuses unknown keys, bad states and bad labels', () => {
		expect(problemOf({ statusMap: { a: { state: 'open', x: 1 } } })).toMatch(/^statusMap\.a\.x: unknown key/);
		expect(problemOf({ statusMap: { a: {} } })).toMatch(/^statusMap\.a\.state: required/);
		expect(problemOf({ statusMap: { a: { state: 'opened' } } })).toMatch(
			/^statusMap\.a\.state: must be "open" or "closed"/
		);
		expect(problemOf({ statusMap: { a: { state: 'open', label: 'a,b' } } })).toMatch(
			/^statusMap\.a\.label:.*comma/
		);
		expect(problemOf({ statusMap: { a: { state: 'open', label: '' } } })).toMatch(/^statusMap\.a\.label:/);
		expect(problemOf({ statusMap: { a: 'open' } })).toMatch(/^statusMap\.a: must be a mapping/);
	});

	it('refuses two statuses with the same representation, labels compared case-insensitively', () => {
		expect(problemOf({ statusMap: { a: { state: 'open' }, b: { state: 'open' } } })).toMatch(
			/^statusMap\.b: the same GitLab representation as "a".*give one of them a label/
		);
		expect(
			problemOf({
				statusMap: { a: { state: 'open', label: 'S:x' }, b: { state: 'open', label: 's:X' } },
			})
		).toMatch(/^statusMap\.b:.*another label/);
	});
});

describe('parseGitLabOptions: typeMap', () => {
	it('accepts a label or a native incident / test_case', () => {
		const map = settingsOf({
			typeMap: { bug: { issueType: 'incident' }, check: { issueType: 'test_case' }, f: { label: 'kind:f' } },
		}).typeMap;
		expect(map).toEqual({
			bug: { issueType: 'incident' },
			check: { issueType: 'test_case' },
			f: { label: 'kind:f' },
		});
	});

	it('refuses task and issue (not both creatable and updatable) and unknown ones', () => {
		expect(problemOf({ typeMap: { a: { issueType: 'task' } } })).toMatch(
			/^typeMap\.a\.issueType: must be incident or test_case/
		);
		expect(problemOf({ typeMap: { a: { issueType: 'issue' } } })).toMatch(/^typeMap\.a\.issueType/);
	});

	it('refuses both keys, none, unknown keys and a native type shared by two task types', () => {
		expect(problemOf({ typeMap: { a: { issueType: 'incident', label: 'x' } } })).toMatch(
			/^typeMap\.a\.label: give issueType or label, not both/
		);
		expect(problemOf({ typeMap: { a: {} } })).toMatch(/^typeMap\.a: give issueType/);
		expect(problemOf({ typeMap: { a: { foo: 1 } } })).toMatch(/^typeMap\.a\.foo: unknown key/);
		expect(problemOf({ typeMap: { a: { issueType: 'incident' }, b: { issueType: 'incident' } } })).toMatch(
			/^typeMap\.b\.issueType:.*already the native type of "a"/
		);
		expect(problemOf({ typeMap: 'x' })).toMatch(/^typeMap: must be a mapping/);
	});
});

describe('parseGitLabOptions: numbers, cache and unknown options', () => {
	it('has defaults', () => {
		expect(settingsOf()).toMatchObject({
			pageSize: 100,
			maxPages: 50,
			cacheTtlSeconds: 30,
			timeoutSeconds: 15,
			writeSpacingSeconds: 1,
		});
	});

	it('validates ranges', () => {
		expect(problemOf({ pageSize: 0 })).toMatch(/^pageSize: must be a whole number from 1 to 100/);
		expect(problemOf({ pageSize: 101 })).toMatch(/^pageSize:/);
		expect(problemOf({ maxPages: 1001 })).toMatch(/^maxPages:/);
		expect(problemOf({ timeoutSeconds: 0 })).toMatch(/^timeoutSeconds:/);
		expect(problemOf({ writeSpacingSeconds: -1 })).toMatch(/^writeSpacingSeconds:/);
		expect(settingsOf({ writeSpacingSeconds: 0 }).writeSpacingSeconds).toBe(0);
		expect(settingsOf({ cache: { ttlSeconds: 0 } }).cacheTtlSeconds).toBe(0);
		expect(settingsOf({ cache: {} }).cacheTtlSeconds).toBe(30);
		expect(problemOf({ cache: { ttlSeconds: -1 } })).toMatch(/^cache\.ttlSeconds:/);
		expect(problemOf({ cache: { ttl: 1 } })).toMatch(/^cache\.ttl: unknown key/);
		expect(problemOf({ cache: 5 })).toMatch(/^cache: must be a mapping/);
	});

	it('refuses an unknown option, naming the known ones', () => {
		expect(problemOf({ repo: 'a/b' })).toMatch(
			/^repo: unknown option for strategy "gitlab" \(known: project, baseUrl/
		);
	});
});

describe('labelProblem', () => {
	it('refuses what cannot be sent', () => {
		expect(labelProblem('')).toMatch(/empty/);
		expect(labelProblem('a,b')).toMatch(/comma/);
		expect(labelProblem(' a')).toMatch(/space/);
		expect(labelProblem('a ')).toMatch(/space/);
	});

	it('accepts colons, accents and long names (no length limit is documented)', () => {
		expect(labelProblem('status:in-progress')).toBeUndefined();
		expect(labelProblem('status::x')).toBeUndefined();
		expect(labelProblem('x'.repeat(300))).toBeUndefined();
	});
});

describe('checkOptionsAgainstProject', () => {
	const facts = (extra: Partial<ProjectFacts> = {}): ProjectFacts => ({
		statuses: [
			{ name: 'backlog', terminal: false, default: true, outcome: undefined },
			{ name: 'wip', terminal: false, default: false, outcome: undefined },
			{ name: 'done', terminal: true, default: false, outcome: 'positive' },
			{ name: 'cancelled', terminal: true, default: false, outcome: 'negative' },
		],
		types: [],
		...extra,
	});
	const map = {
		backlog: { state: 'open' },
		wip: { state: 'open', label: 'status:wip' },
		done: { state: 'closed' },
		cancelled: { state: 'closed', label: 'status:cancelled' },
	};
	const check = (statusMap: unknown, project: ProjectFacts = facts(), extra: Record<string, unknown> = {}) =>
		checkOptionsAgainstProject(settingsOf({ statusMap, ...extra }), project);

	it('accepts a complete map', () => {
		expect(check(map)).toBeUndefined();
	});

	it('names a missing status with an example entry per tier', () => {
		const { cancelled: _omitted, ...rest } = map;
		void _omitted;
		expect(check(rest)).toBe(
			'statusMap.cancelled: the status "cancelled" of the project has no entry; add it, for example: cancelled: { state: closed, label: \'status:cancelled\' }'
		);
		const scoped = checkOptionsAgainstProject(
			settingsOf({
				tier: 'premium',
				statusMap: {
					backlog: { state: 'open' },
					done: { state: 'closed' },
					cancelled: { state: 'closed', label: 'status::cancelled' },
				},
			}),
			facts()
		);
		expect(scoped).toMatch(/^statusMap\.wip:.*wip: \{ state: open, label: 'status::wip' \}/);
	});

	it('refuses an unknown status entry', () => {
		expect(check({ ...map, extra: { state: 'open', label: 'x' } })).toMatch(
			/^statusMap\.extra: the project has no status "extra"/
		);
	});

	it('requires terminal statuses closed and the others open', () => {
		expect(check({ ...map, done: { state: 'open', label: 'status:done' } })).toMatch(
			/^statusMap\.done\.state:.*terminal/
		);
		expect(check({ ...map, wip: { state: 'closed', label: 'status:wip' } })).toMatch(
			/^statusMap\.wip\.state:.*not terminal/
		);
	});

	it('requires a bare open status and a bare closed status', () => {
		expect(check({ ...map, backlog: { state: 'open', label: 'status:backlog' } })).toMatch(
			/^statusMap: no open status without a label.*"backlog"/
		);
		expect(check({ ...map, done: { state: 'closed', label: 'status:done' } })).toMatch(
			/^statusMap: no closed status without a label/
		);
	});

	it('needs a terminal status in the project', () => {
		const project: ProjectFacts = {
			statuses: [{ name: 'backlog', terminal: false, default: true, outcome: undefined }],
			types: [],
		};
		expect(check({ backlog: { state: 'open' } }, project)).toMatch(/no terminal status/);
	});

	it('checks the types against the typeMap and the label of each type', () => {
		expect(check(map, facts({ types: ['bug'] }), { typeMap: { feature: { label: 'kind:f' } } })).toMatch(
			/^typeMap\.feature: the project has no type "feature"/
		);
		expect(check(map, facts({ types: ['bug'] }))).toBeUndefined();
		expect(check(map, facts({ types: ['a,b'] }))).toMatch(/^typePrefix: the label of the type "a,b" is not usable/);
		expect(check(map, facts({ types: ['bug'] }), { typeMap: { bug: { issueType: 'incident' } } })).toBeUndefined();
	});
});
