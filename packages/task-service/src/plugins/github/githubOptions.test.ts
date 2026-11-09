import type { ProjectFacts } from '../kinds.js';
import { checkOptionsAgainstProject, GITHUB_OPTION_NAMES, parseGitHubOptions } from './githubOptions.js';
import type { GitHubSettings } from './githubOptions.js';

const STATUS_MAP = {
	todo: { state: 'open' },
	'in-progress': { state: 'open', label: 'status:in-progress' },
	done: { state: 'closed' },
	cancelled: { state: 'closed', reason: 'not_planned' },
};

function valid(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { repo: 'wadeck-app/task', tokenEnv: 'GITHUB_TOKEN', statusMap: STATUS_MAP, ...extra };
}

function problem(options: Record<string, unknown>): string {
	const parsed = parseGitHubOptions(options);
	if ('settings' in parsed) throw new Error(`expected a problem, got settings ${JSON.stringify(parsed.settings)}`);
	return parsed.problem;
}

function settings(options: Record<string, unknown>): GitHubSettings {
	const parsed = parseGitHubOptions(options);
	if ('problem' in parsed) throw new Error(`unexpected problem: ${parsed.problem}`);
	return parsed.settings;
}

describe('parseGitHubOptions: a valid configuration and its defaults', () => {
	it('reads the repo, the token source, the map and applies the documented defaults', () => {
		expect(settings(valid())).toEqual({
			repo: { owner: 'wadeck-app', name: 'task', full: 'wadeck-app/task' },
			baseUrl: 'https://api.github.com',
			token: { kind: 'env', name: 'GITHUB_TOKEN' },
			statusMap: {
				todo: { state: 'open' },
				'in-progress': { state: 'open', label: 'status:in-progress' },
				// The reason a closed status gets when it is not written depends on its outcome: see effectiveReason.
				done: { state: 'closed' },
				cancelled: { state: 'closed', reason: 'not_planned' },
			},
			typePrefix: 'type:',
			typeMap: {},
			metaPrefix: 'meta:',
			pageSize: 100,
			maxPages: 50,
			cacheTtlSeconds: 60,
			timeoutSeconds: 15,
			writeSpacingSeconds: 1,
		});
	});

	it('takes a token file instead of a variable', () => {
		const { tokenEnv: _drop, ...rest } = valid();

		expect(settings({ ...rest, tokenFile: '~/.config/task/gh-token' }).token).toEqual({
			kind: 'file',
			path: '~/.config/task/gh-token',
		});
	});

	it('takes a GitHub Enterprise Server address and drops a trailing slash', () => {
		expect(settings(valid({ baseUrl: 'https://ghe.example.com/api/v3/' })).baseUrl).toBe(
			'https://ghe.example.com/api/v3'
		);
	});

	it('takes every tuning option', () => {
		const parsed = settings(
			valid({
				pageSize: 30,
				maxPages: 5,
				cache: { ttlSeconds: 0 },
				timeoutSeconds: 3,
				writeSpacingSeconds: 0.5,
				typePrefix: 'kind/',
				metaPrefix: 'm/',
				typeMap: { bug: { issueType: 'Bug' }, chore: { label: 'chore' } },
			})
		);

		expect(parsed).toMatchObject({
			pageSize: 30,
			maxPages: 5,
			cacheTtlSeconds: 0,
			timeoutSeconds: 3,
			writeSpacingSeconds: 0.5,
			typePrefix: 'kind/',
			metaPrefix: 'm/',
			typeMap: { bug: { issueType: 'Bug' }, chore: { label: 'chore' } },
		});
	});

	it('lists its option names for the documentation (fills belong to the host)', () => {
		expect([...GITHUB_OPTION_NAMES].sort()).toEqual(
			[
				'baseUrl',
				'cache',
				'maxPages',
				'metaPrefix',
				'pageSize',
				'repo',
				'statusMap',
				'timeoutSeconds',
				'tokenEnv',
				'tokenFile',
				'typeMap',
				'typePrefix',
				'writeSpacingSeconds',
			].sort()
		);
	});
});

describe('parseGitHubOptions: every problem names its option', () => {
	it('an unknown option lists the known ones', () => {
		expect(problem(valid({ repository: 'a/b' }))).toBe(
			`repository: unknown option for strategy "github" (known: ${[...GITHUB_OPTION_NAMES].join(', ')})`
		);
	});

	it('repo is required and must be owner/name', () => {
		const { repo: _drop, ...rest } = valid();

		expect(problem(rest)).toBe('repo: required (owner/name, for example wadeck-app/task)');
		expect(problem(valid({ repo: 'task' }))).toBe('repo: "task" is not of the form owner/name');
		expect(problem(valid({ repo: 'a/b/c' }))).toBe('repo: "a/b/c" is not of the form owner/name');
		expect(problem(valid({ repo: 12 }))).toBe('repo: must be a string like owner/name, found 12');
		expect(problem(valid({ repo: 'https://github.com/a/b' }))).toMatch(/not of the form owner\/name/);
	});

	it('baseUrl must be an http(s) address without credentials, query or fragment', () => {
		expect(problem(valid({ baseUrl: 'api.github.com' }))).toBe(
			'baseUrl: "api.github.com" is not an http:// or https:// address'
		);
		expect(problem(valid({ baseUrl: 'https://u:p@ghe.example.com/api/v3' }))).toMatch(
			/must not contain credentials/
		);
		expect(problem(valid({ baseUrl: 'https://ghe.example.com/api/v3?x=1' }))).toMatch(/query or fragment/);
		expect(problem(valid({ baseUrl: 5 }))).toBe('baseUrl: must be a string, found 5');
	});

	it('a token source is required: tokenEnv or tokenFile, not both', () => {
		const { tokenEnv: _drop, ...rest } = valid();

		expect(problem(rest)).toBe(
			'tokenEnv: required (the NAME of the environment variable that holds the token, for example GITHUB_TOKEN; or give tokenFile)'
		);
		expect(problem(valid({ tokenFile: '/x' }))).toBe('tokenFile: give tokenEnv or tokenFile, not both');
		const { tokenFile: _unused, ...withoutFile } = valid({ tokenEnv: 'my token' });
		expect(problem(withoutFile)).toMatch(/tokenEnv: .* is not an environment variable name/);
		expect(problem({ ...rest, tokenFile: '' })).toBe('tokenFile: must be the path of a file, found ""');
	});

	it('statusMap is required and every entry says its state', () => {
		const { statusMap: _drop, ...rest } = valid();

		expect(problem(rest)).toMatch(/^statusMap: required \(/);
		expect(problem(valid({ statusMap: [] }))).toMatch(/^statusMap: must be a mapping/);
		expect(problem(valid({ statusMap: {} }))).toMatch(/^statusMap: must map at least one status/);
		expect(problem(valid({ statusMap: { todo: 'open' } }))).toBe(
			'statusMap.todo: must be a mapping with state (and optionally label, reason), found "open"'
		);
		expect(problem(valid({ statusMap: { todo: {} } }))).toBe('statusMap.todo.state: required ("open" or "closed")');
		expect(problem(valid({ statusMap: { todo: { state: 'opened' } } }))).toBe(
			'statusMap.todo.state: must be "open" or "closed", found "opened"'
		);
		expect(problem(valid({ statusMap: { todo: { state: 'open', color: 'red' } } }))).toBe(
			'statusMap.todo.color: unknown key (valid: state, label, reason)'
		);
	});

	it('a reason is for closed statuses only and one of the three GitHub close reasons', () => {
		expect(problem(valid({ statusMap: { todo: { state: 'open', reason: 'completed' } } }))).toBe(
			'statusMap.todo.reason: only a closed status has a reason (GitHub opens issues without one)'
		);
		expect(problem(valid({ statusMap: { done: { state: 'closed', reason: 'finished' } } }))).toBe(
			'statusMap.done.reason: must be "completed", "not_planned" or "duplicate", found "finished"'
		);
	});

	it('a status label is a valid GitHub label name', () => {
		expect(problem(valid({ statusMap: { todo: { state: 'open', label: '' } } }))).toBe(
			'statusMap.todo.label: must be a label name, found ""'
		);
		expect(problem(valid({ statusMap: { todo: { state: 'open', label: 'a,b' } } }))).toBe(
			'statusMap.todo.label: "a,b" contains a comma, which GitHub refuses in a label name'
		);
		expect(problem(valid({ statusMap: { todo: { state: 'open', label: ` ${'x'.repeat(10)}` } } }))).toMatch(
			/starts or ends with a space/
		);
		expect(problem(valid({ statusMap: { todo: { state: 'open', label: 'x'.repeat(51) } } }))).toBe(
			`statusMap.todo.label: "${'x'.repeat(51)}" is 51 characters; GitHub label names are at most 50`
		);
	});

	it('two statuses cannot share one representation (the read would be ambiguous)', () => {
		expect(
			problem(
				valid({
					statusMap: {
						todo: { state: 'open' },
						backlog: { state: 'open' },
						done: { state: 'closed' },
					},
				})
			)
		).toBe(
			'statusMap.backlog: the same GitHub representation as "todo" (state open, no label): give one of them a label'
		);
		expect(
			problem(
				valid({
					statusMap: {
						todo: { state: 'open' },
						a: { state: 'open', label: 'Status:Doing' },
						b: { state: 'open', label: 'status:doing' },
						done: { state: 'closed' },
					},
				})
			)
		).toBe(
			'statusMap.b: the same GitHub representation as "a" (state open, label status:doing): give one of them another label'
		);
	});

	it.each([
		['pageSize', 0, 'pageSize: must be a whole number from 1 to 100, found 0'],
		['pageSize', 101, 'pageSize: must be a whole number from 1 to 100, found 101'],
		['pageSize', 1.5, 'pageSize: must be a whole number from 1 to 100, found 1.5'],
		['maxPages', 0, 'maxPages: must be a whole number from 1 to 1000, found 0'],
		['timeoutSeconds', 0, 'timeoutSeconds: must be a positive number of seconds, found 0'],
		['timeoutSeconds', 'fast', 'timeoutSeconds: must be a positive number of seconds, found "fast"'],
		['writeSpacingSeconds', -1, 'writeSpacingSeconds: must be zero or a positive number of seconds, found -1'],
		[
			'writeSpacingSeconds',
			'slow',
			'writeSpacingSeconds: must be zero or a positive number of seconds, found "slow"',
		],
	])('%s %j is refused', (key, value, message) => {
		expect(problem(valid({ [key]: value }))).toBe(message);
	});

	it('the cache takes ttlSeconds only, zero or more', () => {
		expect(problem(valid({ cache: 60 }))).toBe('cache: must be a mapping like { ttlSeconds: 60 }, found 60');
		expect(problem(valid({ cache: { ttl: 3 } }))).toBe('cache.ttl: unknown key (valid: ttlSeconds)');
		expect(problem(valid({ cache: { ttlSeconds: -1 } }))).toBe(
			'cache.ttlSeconds: must be zero or a positive number of seconds, found -1'
		);
	});

	it('the type and meta prefixes must differ and not contain one another', () => {
		expect(problem(valid({ typePrefix: '' }))).toBe('typePrefix: must be a non-empty label prefix, found ""');
		expect(problem(valid({ typePrefix: 'x:', metaPrefix: 'x:' }))).toBe(
			'metaPrefix: must differ from typePrefix ("x:")'
		);
		expect(problem(valid({ typePrefix: 'kind:', metaPrefix: 'kind:m:' }))).toMatch(/starts with typePrefix/);
	});

	it('typeMap entries name an issue type or a label, one of them', () => {
		expect(problem(valid({ typeMap: { bug: 'Bug' } }))).toBe(
			'typeMap.bug: must be a mapping with issueType or label, found "Bug"'
		);
		expect(problem(valid({ typeMap: { bug: {} } }))).toBe(
			'typeMap.bug: give issueType (a GitHub issue type) or label'
		);
		expect(problem(valid({ typeMap: { bug: { issueType: 'Bug', label: 'bug' } } }))).toBe(
			'typeMap.bug.label: give issueType or label, not both'
		);
		expect(problem(valid({ typeMap: { bug: { colour: 'x' } } }))).toBe(
			'typeMap.bug.colour: unknown key (valid: issueType, label)'
		);
	});
});

describe('checkOptionsAgainstProject: the map agrees with the statuses of the project', () => {
	const facts: ProjectFacts = {
		statuses: [
			{ name: 'todo', terminal: false, default: true, outcome: undefined },
			{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
			{ name: 'done', terminal: true, default: false, outcome: 'positive' },
			{ name: 'cancelled', terminal: true, default: false, outcome: 'negative' },
		],
		types: [],
	};

	function check(options: Record<string, unknown>, project: ProjectFacts = facts): string | undefined {
		return checkOptionsAgainstProject(settings(options), project);
	}

	it('accepts a complete, consistent map', () => {
		expect(check(valid())).toBeUndefined();
	});

	it('every status of the project must have an entry, and the message lists the missing ones with the fix', () => {
		const { cancelled: _drop, ...partial } = STATUS_MAP;

		expect(check(valid({ statusMap: partial }))).toBe(
			'statusMap.cancelled: the status "cancelled" of the project has no entry; add it, for example: cancelled: { state: closed, reason: not_planned }'
		);
		expect(check(valid({ statusMap: { todo: { state: 'open' } } }))).toMatch(
			/^statusMap\.in-progress: the status "in-progress"/
		);
	});

	it('an entry for a status the project does not have is refused (a typo would otherwise pass)', () => {
		expect(check(valid({ statusMap: { ...STATUS_MAP, finished: { state: 'closed' } } }))).toBe(
			'statusMap.finished: the project has no status "finished" (statuses: todo, in-progress, done, cancelled)'
		);
	});

	it('a terminal status closes the issue and a non-terminal one keeps it open', () => {
		expect(check(valid({ statusMap: { ...STATUS_MAP, done: { state: 'open', label: 'status:done' } } }))).toBe(
			'statusMap.done.state: the status "done" is terminal, so its issue must be closed'
		);
		expect(check(valid({ statusMap: { ...STATUS_MAP, 'in-progress': { state: 'closed' } } }))).toBe(
			'statusMap.in-progress.state: the status "in-progress" is not terminal, so its issue must stay open'
		);
	});

	it('a positive terminal status closes as completed, a negative one as not_planned or duplicate', () => {
		expect(check(valid({ statusMap: { ...STATUS_MAP, done: { state: 'closed', reason: 'not_planned' } } }))).toBe(
			'statusMap.done.reason: the status "done" ends well (outcome positive), so GitHub must close it as "completed"'
		);
		expect(
			check(valid({ statusMap: { ...STATUS_MAP, cancelled: { state: 'closed', reason: 'completed' } } }))
		).toBe(
			'statusMap.cancelled.reason: the status "cancelled" ends badly (outcome negative), so GitHub must close it as "not_planned" or "duplicate"'
		);
		expect(
			check(valid({ statusMap: { ...STATUS_MAP, cancelled: { state: 'closed', reason: 'duplicate' } } }))
		).toBeUndefined();
	});

	it('exactly one open status has no label: it is what an issue without a status label reads as', () => {
		expect(check(valid({ statusMap: { ...STATUS_MAP, todo: { state: 'open', label: 'status:todo' } } }))).toBe(
			'statusMap: no open status without a label; an issue created on GitHub carries no status label, so one open status (for example "todo") must be mapped to { state: open } alone'
		);
	});

	it('a project without terminal status cannot close issues: refused', () => {
		const open: ProjectFacts = {
			statuses: [
				{ name: 'todo', terminal: false, default: true, outcome: undefined },
				{ name: 'doing', terminal: false, default: false, outcome: undefined },
			],
			types: [],
		};

		expect(
			check(
				{ ...valid(), statusMap: { todo: { state: 'open' }, doing: { state: 'open', label: 'doing' } } },
				open
			)
		).toBe(
			'statusMap: the project has no terminal status, so a closed issue would map to nothing; mark one status terminal in the config (statuses: - name: done / terminal: true)'
		);
	});

	it('types: a typeMap key must be a type of the project, and the label of a type must fit 50 characters', () => {
		const typed: ProjectFacts = { ...facts, types: ['bug', 'feature'] };

		expect(check(valid({ typeMap: { chore: { label: 'chore' } } }), typed)).toBe(
			'typeMap.chore: the project has no type "chore" (types: bug, feature)'
		);
		expect(check(valid({ typePrefix: `${'p'.repeat(46)}:` }), { ...facts, types: ['feature'] })).toBe(
			`typePrefix: the label of the type "feature" would be ${47 + 7} characters (${'p'.repeat(46)}:feature); GitHub label names are at most 50`
		);
	});
});
