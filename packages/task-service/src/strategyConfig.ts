// The `strategy` section of a project's config.yml (design 4.1): `{ type, fidelity, options }`, scope `local`. The project SDK
// validates the key `strategy` only (one nested level at most); everything inside is checked here, and every problem is a
// ConfigSchemaError naming the FILE and the dotted key, with a hint saying what to write instead.
import { ConfigSchemaError } from '@wadeck-app/project-sdk';
import { BACKEND_CAPABILITY_NAMES } from '@wadeck-app/task-core';

import type { DeclaredFills } from './plugins/kinds.js';
import { fillableCapabilities, techniquesOf, LINK_FILL_TECHNIQUES } from './strategyFills.js';

export type Fidelity = 'strict' | 'degrade';

/** The section after the structural checks. `type` is as written (the resolver defaults it); `options` has no `fills`. */
export interface StrategySection {
	type: string | undefined;
	fidelity: Fidelity;
	options: Record<string, unknown>;
	fills: DeclaredFills;
}

/** A problem in the strategy section (or in the plugin it selects). A ConfigSchemaError, so every caller already maps it; `hint` is the fix. */
export class StrategyConfigError extends ConfigSchemaError {
	constructor(
		file: string,
		path: string,
		problem: string,
		readonly hint?: string
	) {
		super(`${file}: ${path}: ${problem}`, { layer: file, key: 'strategy', path });
		this.name = 'StrategyConfigError';
	}
}

const SECTION_KEYS = ['type', 'fidelity', 'options'] as const;
const MISPLACED_AT_TOP = ['fills', 'transport', 'tokenEnv', 'tokenFile'];
const FILL_OBJECT_KEYS = ['use', 'fidelity'] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_KEY = /^(token|password|passwd|secret|api[-_]?key|access[-_]?token|private[-_]?key|client[-_]?secret)$/i;
const CREDENTIAL_VALUE =
	/^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})$/;
const SECRET_HINT =
	'Put the token in an environment variable and write its NAME: tokenEnv: <VARIABLE_NAME> (or tokenFile: <path to a file readable by you only>).';

function found(value: unknown): string {
	return Array.isArray(value) ? 'a list' : (JSON.stringify(value) ?? String(value));
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Refuses a literal credential anywhere under `value`: a key named like a secret with a value, a credential-looking value, a `tokenEnv` that is not a variable name. */
function checkSecrets(file: string, path: string, value: unknown): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => checkSecrets(file, `${path}.${index}`, item));
		return;
	}
	if (isMapping(value)) {
		for (const [key, child] of Object.entries(value)) {
			const childPath = `${path}.${key}`;
			const hasValue = child !== null && child !== undefined && child !== '' && typeof child !== 'object';
			if (SECRET_KEY.test(key) && hasValue) {
				throw new StrategyConfigError(
					file,
					childPath,
					'a credential must not be written in the config file',
					SECRET_HINT
				);
			}
			if (key === 'tokenEnv' && child !== undefined && (typeof child !== 'string' || !ENV_NAME.test(child))) {
				throw new StrategyConfigError(
					file,
					childPath,
					`${found(child)} is not an environment variable name (letters, digits and underscores, not starting with a digit)`,
					SECRET_HINT
				);
			}
			if (key === 'tokenFile' && (typeof child !== 'string' || child === '')) {
				throw new StrategyConfigError(file, childPath, `must be the path of a file, found ${found(child)}`);
			}
			checkSecrets(file, childPath, child);
		}
		return;
	}
	if (typeof value === 'string' && CREDENTIAL_VALUE.test(value)) {
		throw new StrategyConfigError(
			file,
			path,
			'this value looks like a credential and must not be written in the config file',
			SECRET_HINT
		);
	}
}

function parseFidelity(file: string, path: string, value: unknown): Fidelity {
	if (value !== 'strict' && value !== 'degrade') {
		throw new StrategyConfigError(file, path, `must be "strict" or "degrade", found ${found(value)}`);
	}
	return value;
}

/** One declared fill under its key (`meta`, `linkTypes.causedBy`): a technique name, or `{ use, fidelity? }`. */
function parseFill(file: string, path: string, key: string, value: unknown, global: Fidelity): DeclaredFills[string] {
	const techniques = techniquesOf(key);
	if (techniques === undefined) throw new Error(`parseFill called for a key without fill: ${key}`);
	const valid = Object.keys(techniques).join(', ');
	let use: unknown;
	let fidelity: Fidelity | undefined;
	if (isMapping(value)) {
		for (const name of Object.keys(value)) {
			if (!(FILL_OBJECT_KEYS as readonly string[]).includes(name)) {
				throw new StrategyConfigError(
					file,
					`${path}.${name}`,
					`unknown key (valid: ${FILL_OBJECT_KEYS.join(', ')})`
				);
			}
		}
		use = value['use'];
		if (use === undefined) {
			throw new StrategyConfigError(file, `${path}.use`, `required (the technique name; valid: ${valid})`);
		}
		if (value['fidelity'] !== undefined) fidelity = parseFidelity(file, `${path}.fidelity`, value['fidelity']);
	} else {
		use = value;
	}
	const technique = typeof use === 'string' ? use : undefined;
	if (technique === undefined || !(technique in techniques)) {
		const capability = key.split('.')[0]!;
		const subject = key.includes('.') ? `link type "${key.split('.')[1]}"` : `capability "${capability}"`;
		throw new StrategyConfigError(file, path, `unknown technique ${found(use)} for ${subject} (valid: ${valid})`);
	}
	const effective = fidelity ?? global;
	const class_ = techniques[technique]!;
	if (class_ !== 'exact' && effective === 'strict') {
		throw new StrategyConfigError(
			file,
			path,
			`"${technique}" is ${class_} and fidelity is strict`,
			`Accept it for this capability: ${key.split('.').pop()}: { use: ${technique}, fidelity: degrade } (or set strategy.fidelity: degrade for all fills).`
		);
	}
	return { use: technique, fidelity: effective };
}

function parseFills(file: string, path: string, value: unknown, global: Fidelity): DeclaredFills {
	if (!isMapping(value)) {
		throw new StrategyConfigError(
			file,
			path,
			`must be a mapping of capability to technique, found ${found(value)}`
		);
	}
	const fills: DeclaredFills = {};
	for (const [capability, declared] of Object.entries(value)) {
		const capabilityPath = `${path}.${capability}`;
		if (capability === 'linkTypes') {
			if (!isMapping(declared)) {
				throw new StrategyConfigError(
					file,
					capabilityPath,
					`must map link types to techniques (for example causedBy: relate-block), found ${found(declared)}`
				);
			}
			for (const [linkType, technique] of Object.entries(declared)) {
				if (!(linkType in LINK_FILL_TECHNIQUES)) {
					throw new StrategyConfigError(
						file,
						`${capabilityPath}.${linkType}`,
						`unknown link type (valid: ${Object.keys(LINK_FILL_TECHNIQUES).sort().join(', ')})`
					);
				}
				fills[`linkTypes.${linkType}`] = parseFill(
					file,
					`${capabilityPath}.${linkType}`,
					`linkTypes.${linkType}`,
					technique,
					global
				);
			}
			continue;
		}
		if (techniquesOf(capability) === undefined) {
			const fillable = fillableCapabilities();
			throw new StrategyConfigError(
				file,
				capabilityPath,
				isCapabilityName(capability)
					? `capability "${capability}" has no fill technique (a backend that lacks it refuses the operation)`
					: `unknown capability (fillable: ${fillable.join(', ')})`
			);
		}
		fills[capability] = parseFill(file, capabilityPath, capability, declared, global);
	}
	return fills;
}

function isCapabilityName(name: string): boolean {
	return (BACKEND_CAPABILITY_NAMES as readonly string[]).includes(name);
}

/**
 * Checks the structure of a `strategy` value read from `file`: keys, fidelity, secrets, fills against the fill table. Pure (no
 * registry, no I/O): it runs on every layer of the project chain. Whether the plugin exists and likes its options is the
 * resolver's job, on the layer in effect only. `undefined` (no section) returns undefined.
 */
export function parseStrategySection(file: string, value: unknown): StrategySection | undefined {
	if (value === undefined) return undefined;
	if (!isMapping(value)) {
		throw new StrategyConfigError(
			file,
			'strategy',
			`must be a mapping of type, fidelity and options, found ${found(value)}`,
			'Write "strategy:" followed by an indented "type: local", or remove the key.'
		);
	}
	for (const key of Object.keys(value)) {
		if (key === 'pluginsDir') {
			throw new StrategyConfigError(
				file,
				'strategy.pluginsDir',
				'external plugins are not supported in this version (only the built-in ones can be used)',
				'Remove the key.'
			);
		}
		if ((SECTION_KEYS as readonly string[]).includes(key)) continue;
		throw new StrategyConfigError(
			file,
			`strategy.${key}`,
			`unknown key (valid: ${SECTION_KEYS.join(', ')})`,
			MISPLACED_AT_TOP.includes(key)
				? `Move it under strategy.options: strategy.options.${key}`
				: 'The settings of a strategy go under strategy.options.'
		);
	}
	const type = value['type'];
	if (type !== undefined && typeof type !== 'string') {
		throw new StrategyConfigError(file, 'strategy.type', `must be a string, found ${found(type)}`);
	}
	const fidelity =
		value['fidelity'] === undefined ? 'strict' : parseFidelity(file, 'strategy.fidelity', value['fidelity']);
	const rawOptions = value['options'] ?? {};
	if (!isMapping(rawOptions)) {
		throw new StrategyConfigError(
			file,
			'strategy.options',
			`must be a mapping of option names to values, found ${found(rawOptions)}`
		);
	}
	checkSecrets(file, 'strategy', value);
	const { fills: rawFills, ...options } = rawOptions;
	const fills = rawFills === undefined ? {} : parseFills(file, 'strategy.options.fills', rawFills, fidelity);
	return { type, fidelity, options, fills };
}
