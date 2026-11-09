// Server-side validation of every input of the task server. Nothing from the network reaches the backend unchecked: ids are matched
// against a strict pattern (the local store builds a file name from an id, so a `..` or a separator would leave the data folder),
// bodies must hold exactly the keys of their operation with the right types, and statuses / types / link types are checked against
// the SERVED project's config. Every refusal is a WireProtocolError `invalid-request` (HTTP 400) that names the field and the fix.
import { LINK_TYPES, resolveTypeValidationStrategy } from '@wadeck-app/task-core';
import type { LinkType, ListQuery, PortOperation, TaskResolvedConfig } from '@wadeck-app/task-core';
import { WireProtocolError } from '@wadeck-app/task-core';

/** A task id as the local store makes them (base36) or as older data has them: letters, digits, `_` and `-`, never a path. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_NAME = 1024;
const MAX_IDS_PER_REQUEST = 10_000;

function refuse(message: string, hint: string): never {
	throw new WireProtocolError('invalid-request', message, hint);
}

function describe(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'a list';
	if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 40)}...` : value}"`;
	return typeof value;
}

/** The body as an object with exactly these keys (unknown keys are refused: a typo must not be silently ignored). */
function exactObject(body: unknown, operation: string, allowed: readonly string[]): Record<string, unknown> {
	if (body === undefined) {
		return refuse(
			`${operation}: a JSON body is required`,
			`Send a JSON object with Content-Type: application/json (keys: ${allowed.join(', ') || 'none'})`
		);
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return refuse(`${operation}: the body must be a JSON object, found ${describe(body)}`, 'Send a JSON object.');
	}
	for (const key of Object.keys(body)) {
		if (!allowed.includes(key)) {
			refuse(
				`${operation}: unknown key "${key}"`,
				`The keys of this request are: ${allowed.join(', ') || 'none'}. Both machines should run the same version of task (task strategy check).`
			);
		}
	}
	return body as Record<string, unknown>;
}

function text(
	source: Record<string, unknown>,
	key: string,
	operation: string,
	options: { optional?: boolean; allowEmpty?: boolean } = {}
): string | undefined {
	const value = source[key];
	if (value === undefined) {
		if (options.optional === true) return undefined;
		return refuse(`${operation}: "${key}" is required`, `Add "${key}" (a string) to the body.`);
	}
	if (typeof value !== 'string') {
		return refuse(
			`${operation}: "${key}" must be a string, found ${describe(value)}`,
			`Send "${key}" as a string.`
		);
	}
	if (value.trim() === '' && options.allowEmpty !== true) {
		return refuse(`${operation}: "${key}" must not be blank`, `Give "${key}" a value.`);
	}
	return value;
}

function required(value: string | undefined): string {
	return value as string;
}

export function validId(value: unknown, what: string): string {
	if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
		return refuse(
			`${what}: ${describe(value)} is not a task id`,
			'A task id is made of letters, digits, "_" and "-" (at most 64); it is never a path.'
		);
	}
	return value;
}

function name(value: unknown, what: string): string {
	if (typeof value !== 'string' || value === '') return refuse(`${what}: must not be empty`, `Give ${what} a value.`);
	if (value.length > MAX_NAME) {
		return refuse(`${what}: longer than ${MAX_NAME} characters`, `Use at most ${MAX_NAME} characters.`);
	}
	return value;
}

function linkType(value: unknown, what: string): LinkType {
	if (typeof value !== 'string' || !(LINK_TYPES as readonly string[]).includes(value)) {
		return refuse(`${what}: ${describe(value)} is not a link type`, `Valid link types: ${LINK_TYPES.join(', ')}.`);
	}
	return value as LinkType;
}

function statusOf(config: TaskResolvedConfig, value: string, what: string): string {
	if (!config.statuses.includes(value)) {
		return refuse(
			`${what}: "${value}" is not a status of the served project (valid: ${config.statuses.join(', ')})`,
			'The statuses in the config of the machine that runs task serve differ from the ones of this machine: make them equal (task strategy check compares them).'
		);
	}
	return value;
}

/** What each operation hands to the server: params already decoded and checked, body checked. */
export type ValidInput = {
	list: Record<string, never>;
	listPage: ListQuery;
	get: { id: string };
	getMany: { ids: string[] };
	findByPrefix: { prefix: string };
	listLabels: Record<string, never>;
	getLinks: { id: string };
	getLinksLenient: { id: string };
	getChildren: { id: string };
	getTree: { id: string };
	getForest: { parentId?: string };
	getDescendants: { id: string };
	getFullTree: { id: string };
	getAncestors: { id: string };
	create: { title: string; status: string; parentId?: string; description?: string; createdAt?: string };
	updateStatus: { id: string; status: string };
	setTitle: { id: string; title: string };
	setDescription: { id: string; description: string };
	setType: { id: string; type: string };
	clearType: { id: string };
	addLabel: { id: string; label: string };
	removeLabel: { id: string; label: string };
	setMeta: { id: string; key: string; value: string };
	removeMeta: { id: string; key: string };
	setParent: { id: string; parentId: string };
	removeParent: { id: string };
	addLink: { id: string; type: LinkType; targetId: string };
	removeLink: { id: string; type: LinkType; targetId: string };
	addComment: { id: string; text: string; author?: string };
	editComment: { id: string; commentId: string; text: string };
	removeComment: { id: string; commentId: string };
	deleteTask: { id: string };
};

export interface RequestParts {
	params: Record<string, string>;
	query: URLSearchParams;
	/** The parsed JSON body; undefined when the request had none. */
	body: unknown;
}

type Validator<K extends PortOperation> = (parts: RequestParts, config: TaskResolvedConfig) => ValidInput[K];

const noInput = (): Record<string, never> => ({});
const idOnly = (parts: RequestParts): { id: string } => ({ id: validId(parts.params['id'], 'id') });

const VALIDATORS: { [K in PortOperation]: Validator<K> } = {
	list: noInput,
	listLabels: noInput,
	get: idOnly,
	getLinks: idOnly,
	getLinksLenient: idOnly,
	getChildren: idOnly,
	getTree: idOnly,
	getDescendants: idOnly,
	getFullTree: idOnly,
	getAncestors: idOnly,
	clearType: idOnly,
	removeParent: idOnly,
	deleteTask: idOnly,
	findByPrefix: parts => ({ prefix: validId(parts.params['prefix'], 'prefix') }),
	getForest: parts => {
		const parentId = parts.query.get('parentId');
		return parentId === null ? {} : { parentId: validId(parentId, 'parentId') };
	},
	listPage: ({ body }) => {
		// An empty body is the query with no filter.
		if (body === undefined) return {};
		const source = exactObject(body, 'listPage', ['parentId', 'statusIn', 'text', 'limit', 'cursor']);
		const query: ListQuery = {};
		if (source['parentId'] !== undefined) {
			query.parentId = source['parentId'] === null ? null : validId(source['parentId'], 'parentId');
		}
		if (source['statusIn'] !== undefined) {
			const list = source['statusIn'];
			if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) {
				refuse('listPage: "statusIn" must be a list of strings', 'Send a list of status names.');
			}
			query.statusIn = list as string[];
		}
		const queryText = text(source, 'text', 'listPage', { optional: true, allowEmpty: true });
		if (queryText !== undefined) query.text = queryText;
		if (source['limit'] !== undefined) {
			const limit = source['limit'];
			if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
				refuse('listPage: "limit" must be a positive integer', 'Send a whole number of 1 or more.');
			}
			query.limit = limit as number;
		}
		const cursor = text(source, 'cursor', 'listPage', { optional: true });
		if (cursor !== undefined) query.cursor = cursor;
		return query;
	},
	getMany: ({ body }) => {
		const source = exactObject(body, 'getMany', ['ids']);
		const ids = source['ids'];
		if (!Array.isArray(ids))
			return refuse('getMany: "ids" must be a list of task ids', 'Send {"ids": ["a1b2c3d4"]}.');
		if (ids.length > MAX_IDS_PER_REQUEST) {
			return refuse(
				`getMany: ${ids.length} ids in one request (at most ${MAX_IDS_PER_REQUEST})`,
				'Ask in several requests.'
			);
		}
		return { ids: ids.map((id, index) => validId(id, `ids[${index}]`)) };
	},
	create: ({ body }, config) => {
		const source = exactObject(body, 'create', ['title', 'status', 'parentId', 'description', 'createdAt']);
		const input: ValidInput['create'] = {
			title: required(text(source, 'title', 'create')),
			status: statusOf(config, required(text(source, 'status', 'create')), 'create: status'),
		};
		if (source['parentId'] !== undefined) input.parentId = validId(source['parentId'], 'parentId');
		const description = text(source, 'description', 'create', { optional: true, allowEmpty: true });
		if (description !== undefined) input.description = description;
		const createdAt = text(source, 'createdAt', 'create', { optional: true });
		if (createdAt !== undefined) input.createdAt = createdAt;
		return input;
	},
	updateStatus: (parts, config) => {
		const source = exactObject(parts.body, 'updateStatus', ['status']);
		return {
			id: validId(parts.params['id'], 'id'),
			status: statusOf(config, required(text(source, 'status', 'updateStatus')), 'updateStatus: status'),
		};
	},
	setTitle: parts => {
		const source = exactObject(parts.body, 'setTitle', ['title']);
		return { id: validId(parts.params['id'], 'id'), title: required(text(source, 'title', 'setTitle')) };
	},
	setDescription: parts => {
		const source = exactObject(parts.body, 'setDescription', ['description']);
		return {
			id: validId(parts.params['id'], 'id'),
			description: required(text(source, 'description', 'setDescription', { allowEmpty: true })),
		};
	},
	setType: (parts, config) => {
		const source = exactObject(parts.body, 'setType', ['type']);
		const type = required(text(source, 'type', 'setType'));
		const outcome = resolveTypeValidationStrategy(config.types).validate(type);
		if (!outcome.valid) {
			refuse(
				`setType: ${outcome.error}`,
				'The types in the config of the machine that runs task serve differ from the ones of this machine: make them equal (task strategy check compares them).'
			);
		}
		return { id: validId(parts.params['id'], 'id'), type };
	},
	addLabel: parts => {
		const source = exactObject(parts.body, 'addLabel', ['label']);
		return { id: validId(parts.params['id'], 'id'), label: name(source['label'], 'addLabel: label') };
	},
	removeLabel: parts => ({
		id: validId(parts.params['id'], 'id'),
		label: name(parts.params['label'], 'removeLabel: label'),
	}),
	setMeta: parts => {
		const source = exactObject(parts.body, 'setMeta', ['value']);
		return {
			id: validId(parts.params['id'], 'id'),
			key: name(parts.params['key'], 'setMeta: key'),
			value: required(text(source, 'value', 'setMeta', { allowEmpty: true })),
		};
	},
	removeMeta: parts => ({
		id: validId(parts.params['id'], 'id'),
		key: name(parts.params['key'], 'removeMeta: key'),
	}),
	setParent: parts => {
		const source = exactObject(parts.body, 'setParent', ['parentId']);
		return {
			id: validId(parts.params['id'], 'id'),
			parentId: validId(source['parentId'], 'setParent: parentId'),
		};
	},
	addLink: parts => {
		const source = exactObject(parts.body, 'addLink', ['type', 'targetId']);
		return {
			id: validId(parts.params['id'], 'id'),
			type: linkType(source['type'], 'addLink: type'),
			targetId: validId(source['targetId'], 'addLink: targetId'),
		};
	},
	removeLink: parts => ({
		id: validId(parts.params['id'], 'id'),
		type: linkType(parts.params['type'], 'removeLink: type'),
		targetId: validId(parts.params['target'], 'removeLink: target'),
	}),
	addComment: parts => {
		const source = exactObject(parts.body, 'addComment', ['text', 'author']);
		const input: ValidInput['addComment'] = {
			id: validId(parts.params['id'], 'id'),
			// The store applies the comment rules (trimmed, not blank, length limits) and answers them with their own hints.
			text: required(text(source, 'text', 'addComment', { allowEmpty: true })),
		};
		const author = text(source, 'author', 'addComment', { optional: true, allowEmpty: true });
		if (author !== undefined) input.author = author;
		return input;
	},
	editComment: parts => {
		const source = exactObject(parts.body, 'editComment', ['text']);
		return {
			id: validId(parts.params['id'], 'id'),
			commentId: name(parts.params['commentId'], 'editComment: commentId'),
			text: required(text(source, 'text', 'editComment', { allowEmpty: true })),
		};
	},
	removeComment: parts => ({
		id: validId(parts.params['id'], 'id'),
		commentId: name(parts.params['commentId'], 'removeComment: commentId'),
	}),
};

/** The checked input of an operation. Throws WireProtocolError `invalid-request` for anything the operation does not accept. */
export function validateInput<K extends PortOperation>(
	op: K,
	parts: RequestParts,
	config: TaskResolvedConfig
): ValidInput[K] {
	return VALIDATORS[op](parts, config);
}
