import { ConfigSchemaError } from '@wadeck-app/project-sdk';

import { StrategyConfigError, parseStrategySection } from './strategyConfig.js';

const FILE = '/reg/projects/p1/task/config/config.yml';

function parse(value: unknown) {
	return parseStrategySection(FILE, value);
}

function failure(value: unknown): StrategyConfigError {
	try {
		parse(value);
	} catch (error) {
		expect(error).toBeInstanceOf(StrategyConfigError);
		return error as StrategyConfigError;
	}
	throw new Error(`expected the strategy section to be refused: ${JSON.stringify(value)}`);
}

describe('parseStrategySection: the shape', () => {
	it('an absent section is undefined: a project without it behaves as before, no warning', () => {
		expect(parse(undefined)).toBeUndefined();
	});

	it('a minimal section gets strict fidelity, no options and no fill', () => {
		expect(parse({ type: 'local' })).toEqual({ type: 'local', fidelity: 'strict', options: {}, fills: {} });
	});

	it("a section without type is valid structurally (the default type is the resolver's decision)", () => {
		expect(parse({ fidelity: 'degrade' })).toEqual({
			type: undefined,
			fidelity: 'degrade',
			options: {},
			fills: {},
		});
	});

	it('keeps the options the plugin will validate, minus fills', () => {
		const section = parse({ type: 'x', options: { repo: 'o/n', fills: { meta: 'labels' } } });

		expect(section?.options).toEqual({ repo: 'o/n' });
		expect(section?.fills).toEqual({ meta: { use: 'labels', fidelity: 'strict' } });
	});

	it.each([[null], ['local'], [3], [['local']]])('%j is refused as not being a mapping', value => {
		const error = failure(value);

		expect(error.message).toMatch(new RegExp(`^${FILE}: strategy: must be a mapping`));
		expect(error.hint).toMatch(/type: local/);
	});

	it('an unknown key names the file and the dotted key and lists the valid ones', () => {
		const error = failure({ type: 'local', repo: 'o/n' });

		expect(error.message).toBe(`${FILE}: strategy.repo: unknown key (valid: type, fidelity, options)`);
		expect(error).toBeInstanceOf(ConfigSchemaError);
		expect(error.layer).toBe(FILE);
		expect(error.key).toBe('strategy');
		expect(error.path).toBe('strategy.repo');
		expect(error.hint).toMatch(/options/);
	});

	it.each(['fills', 'transport', 'tokenEnv', 'tokenFile'])(
		'%s at the top of the section says to move it under options',
		key => {
			const error = failure({ [key]: key === 'fills' || key === 'transport' ? {} : 'X' });

			expect(error.path).toBe(`strategy.${key}`);
			expect(error.hint).toBe(`Move it under strategy.options: strategy.options.${key}`);
		}
	);

	it('pluginsDir is refused with the reason: external plugins are not supported', () => {
		const error = failure({ type: 'local', pluginsDir: '/plugins' });

		expect(error.message).toBe(
			`${FILE}: strategy.pluginsDir: external plugins are not supported in this version (only the built-in ones can be used)`
		);
		expect(error.path).toBe('strategy.pluginsDir');
		expect(error.hint).toBe('Remove the key.');
	});

	it('type must be a string', () => {
		expect(failure({ type: 3 }).message).toBe(`${FILE}: strategy.type: must be a string, found 3`);
	});

	it('fidelity must be strict or degrade', () => {
		const error = failure({ fidelity: 'loose' });

		expect(error.message).toBe(`${FILE}: strategy.fidelity: must be "strict" or "degrade", found "loose"`);
		expect(error.path).toBe('strategy.fidelity');
	});

	it.each([[[]], ['text'], [3]])('options that are not a mapping (%j) are refused', options => {
		expect(failure({ options }).message).toMatch(new RegExp(`^${FILE}: strategy.options: must be a mapping`));
	});
});

describe('parseStrategySection: secrets', () => {
	it.each(['token', 'password', 'secret', 'Token', 'apiKey', 'access_token'])(
		'a key named %s with a value is a hard error',
		key => {
			const error = failure({ type: 'x', options: { [key]: 'abc' } });

			expect(error.message).toBe(
				`${FILE}: strategy.options.${key}: a credential must not be written in the config file`
			);
			expect(error.path).toBe(`strategy.options.${key}`);
			expect(error.hint).toBe(
				'Put the token in an environment variable and write its NAME: tokenEnv: <VARIABLE_NAME> (or tokenFile: <path to a file readable by you only>).'
			);
		}
	);

	it('is found at any depth, transport options included', () => {
		const error = failure({
			type: 'remote',
			options: { transport: { type: 'plain-http', options: { url: 'http://h', password: 'pw' } } },
		});

		expect(error.path).toBe('strategy.options.transport.options.password');
	});

	it('a credential-looking value under any key is refused', () => {
		const error = failure({ type: 'x', options: { auth: 'ghp_0123456789abcdefABCDEF' } });

		expect(error.message).toBe(
			`${FILE}: strategy.options.auth: this value looks like a credential and must not be written in the config file`
		);
		expect(error.hint).toMatch(/tokenEnv/);
	});

	it('tokenEnv must be the NAME of a variable, not a token', () => {
		const error = failure({ type: 'x', options: { tokenEnv: 'ghp_0123456789abcdefABCDEF-and-more!' } });

		expect(error.path).toBe('strategy.options.tokenEnv');
		expect(error.message).toMatch(/is not an environment variable name/);
	});

	it('tokenEnv and tokenFile with sound values are accepted', () => {
		expect(
			parse({ type: 'x', options: { tokenEnv: 'GITHUB_TOKEN', tokenFile: '/home/me/.tokens/gh' } })
		).toBeDefined();
	});

	it('tokenFile must be a non-empty string', () => {
		expect(failure({ type: 'x', options: { tokenFile: 3 } }).message).toBe(
			`${FILE}: strategy.options.tokenFile: must be the path of a file, found 3`
		);
		expect(failure({ type: 'x', options: { tokenFile: '' } }).path).toBe('strategy.options.tokenFile');
	});

	it('an empty token value is not a credential (nothing is written)', () => {
		expect(() => parse({ type: 'x', options: { token: '' } })).not.toThrow();
	});
});

describe('parseStrategySection: fills', () => {
	it('a technique alone, or with its own fidelity', () => {
		const section = parse({
			type: 'x',
			options: { fills: { meta: { use: 'body-block', fidelity: 'degrade' }, hierarchy: 'native' } },
		});

		expect(section?.fills).toEqual({
			meta: { use: 'body-block', fidelity: 'degrade' },
			hierarchy: { use: 'native', fidelity: 'strict' },
		});
	});

	it('link types are filled one by one and flattened', () => {
		const section = parse({
			type: 'x',
			fidelity: 'degrade',
			options: { fills: { linkTypes: { causedBy: 'relate-block' } } },
		});

		expect(section?.fills).toEqual({ 'linkTypes.causedBy': { use: 'relate-block', fidelity: 'degrade' } });
	});

	it('an unknown capability lists the capabilities that can be filled', () => {
		const error = failure({ type: 'x', options: { fills: { banana: 'labels' } } });

		expect(error.message).toBe(
			`${FILE}: strategy.options.fills.banana: unknown capability (fillable: activity, delete, hierarchy, history, ids, linkTypes, meta, search, status)`
		);
		expect(error.path).toBe('strategy.options.fills.banana');
	});

	it('a real capability that is never emulated says so', () => {
		const error = failure({ type: 'x', options: { fills: { labels: 'native' } } });

		expect(error.message).toBe(
			`${FILE}: strategy.options.fills.labels: capability "labels" has no fill technique (a backend that lacks it refuses the operation)`
		);
	});

	it('an unknown technique lists the valid ones for that capability', () => {
		const error = failure({ type: 'x', options: { fills: { meta: 'sticky-notes' } } });

		expect(error.message).toBe(
			`${FILE}: strategy.options.fills.meta: unknown technique "sticky-notes" for capability "meta" (valid: labels, body-block, sidecar)`
		);
	});

	it('an unknown link type lists the ones of the design', () => {
		const error = failure({ type: 'x', options: { fills: { linkTypes: { friendOf: 'native' } } } });

		expect(error.message).toBe(
			`${FILE}: strategy.options.fills.linkTypes.friendOf: unknown link type (valid: blockedBy, causedBy, duplicateOf)`
		);
	});

	it('linkTypes given as a technique instead of a mapping is refused with the shape', () => {
		expect(failure({ type: 'x', options: { fills: { linkTypes: 'native' } } }).message).toMatch(
			/fills\.linkTypes: must map link types to techniques/
		);
	});

	it.each([[[]], ['text']])('fills that are not a mapping (%j) are refused', fills => {
		expect(failure({ type: 'x', options: { fills } }).message).toMatch(
			/strategy\.options\.fills: must be a mapping/
		);
	});

	it('a fill given as an object needs "use"', () => {
		expect(failure({ type: 'x', options: { fills: { meta: { fidelity: 'degrade' } } } }).message).toBe(
			`${FILE}: strategy.options.fills.meta.use: required (the technique name; valid: labels, body-block, sidecar)`
		);
	});

	it('an unknown key in a fill object is refused', () => {
		expect(failure({ type: 'x', options: { fills: { meta: { use: 'labels', how: 'x' } } } }).message).toBe(
			`${FILE}: strategy.options.fills.meta.how: unknown key (valid: use, fidelity)`
		);
	});

	it('a fill fidelity must be strict or degrade', () => {
		expect(failure({ type: 'x', options: { fills: { meta: { use: 'labels', fidelity: 'meh' } } } }).path).toBe(
			'strategy.options.fills.meta.fidelity'
		);
	});

	it('an approximate fill under strict needs its own degrade, and the message says how', () => {
		const error = failure({ type: 'x', options: { fills: { meta: 'body-block' } } });

		expect(error.message).toBe(
			`${FILE}: strategy.options.fills.meta: "body-block" is approximate and fidelity is strict`
		);
		expect(error.hint).toBe(
			'Accept it for this capability: meta: { use: body-block, fidelity: degrade } (or set strategy.fidelity: degrade for all fills).'
		);
	});

	it('a lossy fill is treated like an approximate one', () => {
		expect(failure({ type: 'x', options: { fills: { hierarchy: 'tasklist' } } }).message).toMatch(
			/"tasklist" is lossy/
		);
	});

	it('an approximate fill is accepted with its own degrade or under a global degrade', () => {
		expect(() =>
			parse({ type: 'x', options: { fills: { meta: { use: 'body-block', fidelity: 'degrade' } } } })
		).not.toThrow();
		expect(() =>
			parse({ type: 'x', fidelity: 'degrade', options: { fills: { meta: 'body-block' } } })
		).not.toThrow();
	});
});
