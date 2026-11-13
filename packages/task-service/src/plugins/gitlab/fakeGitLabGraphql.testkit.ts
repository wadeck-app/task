// The GraphQL half of the GitLab mock (fakeGitLab.testkit.ts): a SMALL real executor, not canned answers. It parses the document
// (operations, variables, aliases, fields, arguments, inline fragments and named fragments, @include / @skip), validates the
// selections against a tiny schema and resolves them over a host the mock provides. Only the subset the gitlab strategy needs is in
// the schema: `workItem`, `project`, `namespace`, `workItemUpdate` (hierarchy widget) and `workItemConvert`.
//
// Tags used below (same words as the header of fakeGitLab.testkit.ts):
//   LIVE-VERIFIED 2026-11-09  recorded on gitlab.com Free (fixtures/live-conformance.json, steps "read A hierarchy" ... "graphql syntax error")
//   DOCUMENTED-NOT-LIVE       a GitLab page says it, nothing recorded
//   UNVERIFIABLE              cannot be probed with the test token (see the ledger, fakeGitLabLedger.testkit.ts)
// Test-only: nothing in the shipped code imports this file.

/** A syntax error of the document: graphql-ruby answers it as a top-level error without data. */
export class GqlSyntaxError extends Error {
	constructor(
		message: string,
		readonly line: number,
		readonly column: number
	) {
		super(message);
	}
}

/** A failure of one field: the field is null and the error carries its path (LIVE-VERIFIED: "404 Not Found", "You are not allowed..."). */
export class GqlFieldError extends Error {}

/**
 * The request needs something the mock does not implement (a field GitLab has outside the hierarchy, an input it would ignore, a
 * subscription): the REST layer answers its 501 `mock: not modelled`, never an invented GraphQL answer.
 */
export class GqlNotModelled extends Error {}

/** The token may not do this: the REST layer answers its 403 `insufficient_granular_scope` (UNVERIFIABLE for GraphQL: it needs a weaker token than the one we have). */
export class GqlForbidden extends Error {
	constructor(
		readonly resource: string,
		readonly action: string
	) {
		super(`${resource}: ${action}`);
	}
}

/** A work item as the executor sees it. */
export interface GqlWorkItem {
	/** Global id of the issue row (the number of `gid://gitlab/WorkItem/<n>`). */
	id: number;
	iid: number;
	title: string;
	description: string | null;
	state: 'opened' | 'closed';
	typeName: 'Issue' | 'Incident' | 'Task';
	confidential: boolean;
	webUrl: string;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
}

export interface GqlHost {
	/** Undefined when the item does not exist; throws a GqlFieldError for a malformed global id. */
	workItem(gid: string): GqlWorkItem | undefined;
	parentOf(item: GqlWorkItem): GqlWorkItem | undefined;
	childrenOf(item: GqlWorkItem): GqlWorkItem[];
	/** Sets (or removes with null) the parent; returns the messages of the refusal, empty when it worked. */
	setParent(child: GqlWorkItem, parent: GqlWorkItem | null): string[];
	/** Throws a GqlFieldError for a type GitLab refuses; returns the messages of a refusal otherwise. */
	convert(item: GqlWorkItem, typeGid: string): string[];
	project(fullPath: string): { id: number; fullPath: string; name: string } | undefined;
	namespace(fullPath: string): { id: number; fullPath: string; name: string } | undefined;
	can(action: 'read' | 'update'): boolean;
}

// ------------------------------------------------------------------------------------------------ lexer

interface Token {
	kind: string;
	value: string;
	line: number;
	column: number;
}

const PUNCTUATION: Record<string, string> = {
	'!': 'BANG',
	$: 'DOLLAR',
	'&': 'AMP',
	'(': 'LPAREN',
	')': 'RPAREN',
	':': 'COLON',
	'=': 'EQUALS',
	'@': 'AT',
	'[': 'LBRACKET',
	']': 'RBRACKET',
	'{': 'LCURLY',
	'|': 'PIPE',
	'}': 'RCURLY',
};

function lex(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	let line = 1;
	let lineStart = 0;
	const at = (): { line: number; column: number } => ({ line, column: i - lineStart + 1 });
	while (i < source.length) {
		const ch = source[i]!;
		if (ch === '\n') {
			line += 1;
			i += 1;
			lineStart = i;
			continue;
		}
		if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',' || ch.charCodeAt(0) === 0xfeff) {
			i += 1;
			continue;
		}
		if (ch === '#') {
			while (i < source.length && source[i] !== '\n') i += 1;
			continue;
		}
		const where = at();
		if (source.startsWith('...', i)) {
			tokens.push({ kind: 'ELLIPSIS', value: '...', ...where });
			i += 3;
			continue;
		}
		const punct = PUNCTUATION[ch];
		if (punct !== undefined) {
			tokens.push({ kind: punct, value: ch, ...where });
			i += 1;
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			const start = i;
			while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i += 1;
			tokens.push({ kind: 'IDENTIFIER', value: source.slice(start, i), ...where });
			continue;
		}
		if (/[-0-9]/.test(ch)) {
			const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
			if (match === null)
				throw new GqlSyntaxError(
					`Parse error on "${ch}" (UNKNOWN_CHAR) at [${where.line}, ${where.column}]`,
					where.line,
					where.column
				);
			i += match[0].length;
			tokens.push({
				kind: match[1] !== undefined || match[2] !== undefined ? 'FLOAT' : 'INT',
				value: match[0],
				...where,
			});
			continue;
		}
		if (ch === '"') {
			if (source.startsWith('"""', i)) {
				const end = source.indexOf('"""', i + 3);
				if (end < 0) throw new GqlSyntaxError(`Unexpected end of document`, where.line, where.column);
				tokens.push({ kind: 'STRING', value: source.slice(i + 3, end).trim(), ...where });
				for (const c of source.slice(i, end + 3)) {
					if (c === '\n') line += 1;
				}
				i = end + 3;
				continue;
			}
			let value = '';
			i += 1;
			let closed = false;
			while (i < source.length) {
				const c = source[i]!;
				if (c === '"') {
					closed = true;
					i += 1;
					break;
				}
				if (c === '\n') break;
				if (c === '\\') {
					const next = source[i + 1] ?? '';
					const simple: Record<string, string> = {
						n: '\n',
						t: '\t',
						r: '\r',
						b: '\b',
						f: '\f',
						'"': '"',
						'\\': '\\',
						'/': '/',
					};
					if (next === 'u') {
						value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
						i += 6;
						continue;
					}
					value += simple[next] ?? next;
					i += 2;
					continue;
				}
				value += c;
				i += 1;
			}
			// LIVE-VERIFIED (step "graphql unterminated string").
			if (!closed)
				throw new GqlSyntaxError(
					'Expected string or block string, but it was malformed',
					where.line,
					where.column
				);
			tokens.push({ kind: 'STRING', value, ...where });
			continue;
		}
		throw new GqlSyntaxError(
			`Parse error on "${ch}" (UNKNOWN_CHAR) at [${where.line}, ${where.column}]`,
			where.line,
			where.column
		);
	}
	tokens.push({ kind: 'EOF', value: '', line, column: i - lineStart + 1 });
	return tokens;
}

// ------------------------------------------------------------------------------------------------ parser

type Value =
	| { k: 'var'; name: string }
	| { k: 'scalar'; v: string | number | boolean | null; enum?: boolean }
	| { k: 'list'; items: Value[] }
	| { k: 'object'; fields: Array<{ name: string; value: Value }> };

interface Directive {
	name: string;
	args: Array<{ name: string; value: Value }>;
}

interface FieldNode {
	kind: 'field';
	alias: string | undefined;
	name: string;
	args: Array<{ name: string; value: Value }>;
	directives: Directive[];
	selection: SelectionNode[] | undefined;
	line: number;
	column: number;
}

interface InlineFragmentNode {
	kind: 'inline';
	typeCondition: string | undefined;
	directives: Directive[];
	selection: SelectionNode[];
	line: number;
	column: number;
}

interface SpreadNode {
	kind: 'spread';
	name: string;
	directives: Directive[];
	line: number;
	column: number;
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface VariableDefinition {
	name: string;
	/** The type as written (`WorkItemID!`, `[ID!]`). */
	type: string;
	required: boolean;
	defaultValue: Value | undefined;
}

interface OperationNode {
	operation: 'query' | 'mutation' | 'subscription';
	name: string | undefined;
	variables: VariableDefinition[];
	selection: SelectionNode[];
}

interface FragmentNode {
	name: string;
	typeCondition: string;
	selection: SelectionNode[];
}

interface Document {
	operations: OperationNode[];
	fragments: Map<string, FragmentNode>;
}

class Parser {
	private pos = 0;
	constructor(private readonly tokens: Token[]) {}

	private get current(): Token {
		return this.tokens[this.pos]!;
	}

	private fail(token: Token = this.current): never {
		if (token.kind === 'EOF') throw new GqlSyntaxError('Unexpected end of document', token.line, token.column);
		throw new GqlSyntaxError(
			`Parse error on "${token.value}" (${token.kind}) at [${token.line}, ${token.column}]`,
			token.line,
			token.column
		);
	}

	private eat(kind: string): Token {
		const token = this.current;
		if (token.kind !== kind) this.fail();
		this.pos += 1;
		return token;
	}

	private is(kind: string, value?: string): boolean {
		return this.current.kind === kind && (value === undefined || this.current.value === value);
	}

	parseDocument(): Document {
		const operations: OperationNode[] = [];
		const fragments = new Map<string, FragmentNode>();
		if (this.is('EOF')) this.fail();
		while (!this.is('EOF')) {
			if (this.is('LCURLY')) {
				operations.push({
					operation: 'query',
					name: undefined,
					variables: [],
					selection: this.parseSelectionSet(),
				});
			} else if (this.is('IDENTIFIER', 'fragment')) {
				this.pos += 1;
				const name = this.eat('IDENTIFIER').value;
				if (!this.is('IDENTIFIER', 'on')) this.fail();
				this.pos += 1;
				const typeCondition = this.eat('IDENTIFIER').value;
				this.parseDirectives();
				fragments.set(name, { name, typeCondition, selection: this.parseSelectionSet() });
			} else if (
				this.is('IDENTIFIER', 'query') ||
				this.is('IDENTIFIER', 'mutation') ||
				this.is('IDENTIFIER', 'subscription')
			) {
				const operation = this.eat('IDENTIFIER').value as OperationNode['operation'];
				const name = this.is('IDENTIFIER') ? this.eat('IDENTIFIER').value : undefined;
				const variables = this.is('LPAREN') ? this.parseVariableDefinitions() : [];
				this.parseDirectives();
				operations.push({ operation, name, variables, selection: this.parseSelectionSet() });
			} else this.fail();
		}
		return { operations, fragments };
	}

	private parseVariableDefinitions(): VariableDefinition[] {
		this.eat('LPAREN');
		const out: VariableDefinition[] = [];
		while (!this.is('RPAREN')) {
			this.eat('DOLLAR');
			const name = this.eat('IDENTIFIER').value;
			this.eat('COLON');
			const type = this.parseType();
			let defaultValue: Value | undefined;
			if (this.is('EQUALS')) {
				this.pos += 1;
				defaultValue = this.parseValue();
			}
			out.push({ name, type, required: type.endsWith('!'), defaultValue });
		}
		this.eat('RPAREN');
		return out;
	}

	private parseType(): string {
		let text: string;
		if (this.is('LBRACKET')) {
			this.pos += 1;
			text = `[${this.parseType()}]`;
			this.eat('RBRACKET');
		} else text = this.eat('IDENTIFIER').value;
		if (this.is('BANG')) {
			this.pos += 1;
			text += '!';
		}
		return text;
	}

	private parseSelectionSet(): SelectionNode[] {
		this.eat('LCURLY');
		const out: SelectionNode[] = [];
		if (this.is('RCURLY')) this.fail();
		while (!this.is('RCURLY')) out.push(this.parseSelection());
		this.eat('RCURLY');
		return out;
	}

	private parseSelection(): SelectionNode {
		if (this.is('ELLIPSIS')) {
			const spread = this.eat('ELLIPSIS');
			if (this.is('IDENTIFIER') && this.current.value !== 'on') {
				const name = this.eat('IDENTIFIER').value;
				return {
					kind: 'spread',
					name,
					directives: this.parseDirectives(),
					line: spread.line,
					column: spread.column,
				};
			}
			let typeCondition: string | undefined;
			if (this.is('IDENTIFIER', 'on')) {
				this.pos += 1;
				typeCondition = this.eat('IDENTIFIER').value;
			}
			const directives = this.parseDirectives();
			return {
				kind: 'inline',
				typeCondition,
				directives,
				selection: this.parseSelectionSet(),
				line: spread.line,
				column: spread.column,
			};
		}
		const first = this.eat('IDENTIFIER');
		let alias: string | undefined;
		let name = first.value;
		if (this.is('COLON')) {
			this.pos += 1;
			alias = name;
			name = this.eat('IDENTIFIER').value;
		}
		const args = this.is('LPAREN') ? this.parseArguments() : [];
		const directives = this.parseDirectives();
		const selection = this.is('LCURLY') ? this.parseSelectionSet() : undefined;
		return { kind: 'field', alias, name, args, directives, selection, line: first.line, column: first.column };
	}

	private parseArguments(): Array<{ name: string; value: Value }> {
		this.eat('LPAREN');
		const out: Array<{ name: string; value: Value }> = [];
		if (this.is('RPAREN')) this.fail();
		while (!this.is('RPAREN')) {
			const name = this.eat('IDENTIFIER').value;
			this.eat('COLON');
			out.push({ name, value: this.parseValue() });
		}
		this.eat('RPAREN');
		return out;
	}

	private parseDirectives(): Directive[] {
		const out: Directive[] = [];
		while (this.is('AT')) {
			this.pos += 1;
			const name = this.eat('IDENTIFIER').value;
			out.push({ name, args: this.is('LPAREN') ? this.parseArguments() : [] });
		}
		return out;
	}

	private parseValue(): Value {
		const token = this.current;
		switch (token.kind) {
			case 'DOLLAR':
				this.pos += 1;
				return { k: 'var', name: this.eat('IDENTIFIER').value };
			case 'INT':
				this.pos += 1;
				return { k: 'scalar', v: Number(token.value) };
			case 'FLOAT':
				this.pos += 1;
				return { k: 'scalar', v: Number(token.value) };
			case 'STRING':
				this.pos += 1;
				return { k: 'scalar', v: token.value };
			case 'IDENTIFIER':
				this.pos += 1;
				if (token.value === 'true') return { k: 'scalar', v: true };
				if (token.value === 'false') return { k: 'scalar', v: false };
				if (token.value === 'null') return { k: 'scalar', v: null };
				return { k: 'scalar', v: token.value, enum: true };
			case 'LBRACKET': {
				this.pos += 1;
				const items: Value[] = [];
				while (!this.is('RBRACKET')) items.push(this.parseValue());
				this.eat('RBRACKET');
				return { k: 'list', items };
			}
			case 'LCURLY': {
				this.pos += 1;
				const fields: Array<{ name: string; value: Value }> = [];
				while (!this.is('RCURLY')) {
					const name = this.eat('IDENTIFIER').value;
					this.eat('COLON');
					fields.push({ name, value: this.parseValue() });
				}
				this.eat('RCURLY');
				return { k: 'object', fields };
			}
			default:
				return this.fail();
		}
	}
}

// ------------------------------------------------------------------------------------------------ schema

interface ArgDef {
	type: string;
	required?: boolean;
}

// The resolvers read loosely typed sources (a work item, a widget wrapper, a payload): one explicit escape hatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

interface Obj {
	t: string;
	v: Loose;
}

const obj = (t: string, v: unknown): Obj => ({ t, v });

interface Ctx {
	host: GqlHost;
}

interface FieldDef {
	/** The named type returned (`WorkItem`, `String`): composite when it is in TYPES. */
	type: string;
	list?: boolean;
	args?: Record<string, ArgDef>;
	resolve: (source: Loose, args: Record<string, unknown>, ctx: Ctx) => unknown;
}

interface TypeDef {
	kind: 'object' | 'interface';
	fields: Record<string, FieldDef>;
}

// LIVE-VERIFIED (steps "widget types of an Issue / an Incident / a Task", "read B hierarchy"): an Issue has 19 widgets (hierarchy at index 9),
// an Incident 18 (hierarchy at index 8: it has ESCALATION_STATUS and SEVERITY, no DESIGNS, ERROR_TRACKING nor START_AND_DUE_DATE), a Task 16
// (hierarchy at index 6). Only the hierarchy widget has fields in the mock; a field of any other widget answers 501.
const ISSUE_WIDGETS = [
	'ASSIGNEES',
	'AWARD_EMOJI',
	'CRM_CONTACTS',
	'CURRENT_USER_TODOS',
	'DESCRIPTION',
	'DESIGNS',
	'DEVELOPMENT',
	'EMAIL_PARTICIPANTS',
	'ERROR_TRACKING',
	'HIERARCHY',
	'LABELS',
	'LINKED_ITEMS',
	'MILESTONE',
	'NOTES',
	'NOTIFICATIONS',
	'PARTICIPANTS',
	'START_AND_DUE_DATE',
	'TIME_TRACKING',
	'LINKED_RESOURCES',
] as const;
const INCIDENT_WIDGETS = [
	'ASSIGNEES',
	'AWARD_EMOJI',
	'CRM_CONTACTS',
	'CURRENT_USER_TODOS',
	'DESCRIPTION',
	'DEVELOPMENT',
	'EMAIL_PARTICIPANTS',
	'ESCALATION_STATUS',
	'HIERARCHY',
	'LABELS',
	'LINKED_ITEMS',
	'LINKED_RESOURCES',
	'MILESTONE',
	'NOTES',
	'NOTIFICATIONS',
	'PARTICIPANTS',
	'SEVERITY',
	'TIME_TRACKING',
] as const;
const TASK_WIDGETS = [
	'ASSIGNEES',
	'AWARD_EMOJI',
	'CRM_CONTACTS',
	'CURRENT_USER_TODOS',
	'DESCRIPTION',
	'DEVELOPMENT',
	'HIERARCHY',
	'LABELS',
	'LINKED_ITEMS',
	'LINKED_RESOURCES',
	'MILESTONE',
	'NOTES',
	'NOTIFICATIONS',
	'PARTICIPANTS',
	'START_AND_DUE_DATE',
	'TIME_TRACKING',
] as const;

const pascal = (widget: string): string =>
	widget
		.toLowerCase()
		.split('_')
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');

const widgetTypeName = (widget: string): string => `WorkItemWidget${pascal(widget)}`;

// LIVE-VERIFIED: `gid://gitlab/WorkItems::Type/1` Issue, /2 Incident, /5 Task ("Task work" in the recording), /3 Test Case refused.
export const WORK_ITEM_TYPE_IDS: Record<string, 'Issue' | 'Incident' | 'Task'> = {
	'gid://gitlab/WorkItems::Type/1': 'Issue',
	'gid://gitlab/WorkItems::Type/2': 'Incident',
	'gid://gitlab/WorkItems::Type/5': 'Task',
};
const TYPE_GID: Record<'Issue' | 'Incident' | 'Task', string> = {
	Issue: 'gid://gitlab/WorkItems::Type/1',
	Incident: 'gid://gitlab/WorkItems::Type/2',
	Task: 'gid://gitlab/WorkItems::Type/5',
};

const widgetBase: Record<string, FieldDef> = {
	type: { type: 'WorkItemWidgetType', resolve: source => source.type },
};

const TYPES: Record<string, TypeDef> = {
	Query: {
		kind: 'object',
		fields: {
			workItem: {
				type: 'WorkItem',
				args: { id: { type: 'WorkItemID', required: true } },
				resolve: (_s, args, ctx) => {
					if (!ctx.host.can('read')) throw new GqlForbidden('Work Item', 'Read');
					const item = ctx.host.workItem(String(args['id']));
					// LIVE-VERIFIED (step "read an unknown work item"): an error naming the path, and data.workItem null.
					if (item === undefined)
						throw new GqlFieldError(
							"The resource that you are attempting to access does not exist or you don't have permission to perform this action"
						);
					return obj('WorkItem', item);
				},
			},
			// LIVE-VERIFIED: null (no error) when the token has no `Project: Read`.
			project: {
				type: 'Project',
				args: { fullPath: { type: 'ID', required: true } },
				resolve: (_s, args, ctx) => {
					const found = ctx.host.project(String(args['fullPath']));
					return found === undefined ? null : obj('Project', found);
				},
			},
			// LIVE-VERIFIED: null when the token has no `Namespace: Read`.
			namespace: {
				type: 'Namespace',
				args: { fullPath: { type: 'ID', required: true } },
				resolve: (_s, args, ctx) => {
					const found = ctx.host.namespace(String(args['fullPath']));
					return found === undefined ? null : obj('Namespace', found);
				},
			},
		},
	},
	Mutation: {
		kind: 'object',
		fields: {
			workItemUpdate: {
				type: 'WorkItemUpdatePayload',
				args: { input: { type: 'WorkItemUpdateInput', required: true } },
				resolve: (_s, args, ctx) => {
					if (!ctx.host.can('update')) throw new GqlForbidden('Work Item', 'Update');
					const input = (args['input'] ?? {}) as Record<string, unknown>;
					// The mock changes the parent and nothing else: any other input would be ignored, which GitLab does not do.
					const extra = Object.keys(input).find(
						key => !['id', 'hierarchyWidget', 'clientMutationId'].includes(key)
					);
					if (extra !== undefined) throw new GqlNotModelled(`the workItemUpdate input ${extra}`);
					const item = ctx.host.workItem(String(input['id']));
					if (item === undefined) throw new GqlFieldError('404 Not Found');
					const hierarchy = input['hierarchyWidget'] as Record<string, unknown> | undefined;
					const otherHierarchy = Object.keys(hierarchy ?? {}).find(key => key !== 'parentId');
					if (otherHierarchy !== undefined)
						throw new GqlNotModelled(`the hierarchyWidget input ${otherHierarchy}`);
					let errors: string[] = [];
					if (hierarchy !== undefined && hierarchy !== null && 'parentId' in hierarchy) {
						const parentId = hierarchy['parentId'];
						let parent: GqlWorkItem | null = null;
						if (parentId !== null && parentId !== undefined) {
							const found = ctx.host.workItem(String(parentId));
							// LIVE-VERIFIED (step "task C under an unknown parent"): a field error with Ruby's inspect of the global id.
							if (found === undefined)
								throw new GqlFieldError(
									`No object found for \`parentId: #<GlobalID:0x00007ba7129ead88 @uri=#<URI::GID ${String(parentId)}>>\``
								);
							else parent = found;
						}
						if (errors.length === 0) errors = ctx.host.setParent(item, parent);
					}
					const after = ctx.host.workItem(`gid://gitlab/WorkItem/${item.id}`);
					return obj('WorkItemUpdatePayload', { errors, workItem: errors.length > 0 ? null : after });
				},
			},
			workItemConvert: {
				type: 'WorkItemConvertPayload',
				args: { input: { type: 'WorkItemConvertInput', required: true } },
				resolve: (_s, args, ctx) => {
					if (!ctx.host.can('update')) throw new GqlForbidden('Work Item', 'Update');
					const input = (args['input'] ?? {}) as Record<string, unknown>;
					const item = ctx.host.workItem(String(input['id']));
					if (item === undefined) throw new GqlFieldError('404 Not Found');
					const errors = ctx.host.convert(item, String(input['workItemTypeId']));
					const after = ctx.host.workItem(`gid://gitlab/WorkItem/${item.id}`);
					return obj('WorkItemConvertPayload', { errors, workItem: errors.length > 0 ? null : after });
				},
			},
		},
	},
	WorkItemUpdatePayload: {
		kind: 'object',
		fields: {
			errors: { type: 'String', list: true, resolve: source => source.errors },
			workItem: {
				type: 'WorkItem',
				resolve: source => (source.workItem === null ? null : obj('WorkItem', source.workItem)),
			},
		},
	},
	WorkItemConvertPayload: {
		kind: 'object',
		fields: {
			errors: { type: 'String', list: true, resolve: source => source.errors },
			workItem: {
				type: 'WorkItem',
				resolve: source => (source.workItem === null ? null : obj('WorkItem', source.workItem)),
			},
		},
	},
	WorkItem: {
		kind: 'object',
		fields: {
			id: { type: 'WorkItemID', resolve: (s: GqlWorkItem) => `gid://gitlab/WorkItem/${s.id}` },
			// LIVE-VERIFIED: the iid is a string.
			iid: { type: 'String', resolve: (s: GqlWorkItem) => String(s.iid) },
			title: { type: 'String', resolve: (s: GqlWorkItem) => s.title },
			state: { type: 'WorkItemState', resolve: (s: GqlWorkItem) => (s.state === 'opened' ? 'OPEN' : 'CLOSED') },
			confidential: { type: 'Boolean', resolve: (s: GqlWorkItem) => s.confidential },
			webUrl: { type: 'String', resolve: (s: GqlWorkItem) => s.webUrl },
			createdAt: { type: 'Time', resolve: (s: GqlWorkItem) => s.createdAt },
			updatedAt: { type: 'Time', resolve: (s: GqlWorkItem) => s.updatedAt },
			closedAt: { type: 'Time', resolve: (s: GqlWorkItem) => s.closedAt },
			workItemType: {
				type: 'WorkItemType',
				resolve: (s: GqlWorkItem) => obj('WorkItemType', { id: TYPE_GID[s.typeName], name: s.typeName }),
			},
			widgets: {
				type: 'WorkItemWidget',
				list: true,
				resolve: (s: GqlWorkItem) =>
					(s.typeName === 'Task'
						? TASK_WIDGETS
						: s.typeName === 'Incident'
							? INCIDENT_WIDGETS
							: ISSUE_WIDGETS
					).map(widget => obj(widgetTypeName(widget), { type: widget, item: s })),
			},
		},
	},
	WorkItemType: {
		kind: 'object',
		fields: {
			id: { type: 'WorkItemsTypeID', resolve: s => s.id },
			name: { type: 'String', resolve: s => s.name },
		},
	},
	WorkItemWidget: { kind: 'interface', fields: widgetBase },
	WorkItemWidgetHierarchy: {
		kind: 'object',
		fields: {
			...widgetBase,
			parent: {
				type: 'WorkItem',
				resolve: (s, _a, ctx) => {
					const parent = ctx.host.parentOf(s.item);
					return parent === undefined ? null : obj('WorkItem', parent);
				},
			},
			children: {
				type: 'WorkItemConnection',
				args: { first: { type: 'Int' } },
				resolve: (s, args, ctx) => {
					const first = typeof args['first'] === 'number' ? args['first'] : 100;
					return obj('WorkItemConnection', { nodes: ctx.host.childrenOf(s.item).slice(0, first) });
				},
			},
		},
	},
	WorkItemConnection: {
		kind: 'object',
		fields: {
			nodes: {
				type: 'WorkItem',
				list: true,
				resolve: s => s.nodes.map((node: GqlWorkItem) => obj('WorkItem', node)),
			},
		},
	},
	Project: {
		kind: 'object',
		fields: {
			id: { type: 'ID', resolve: s => `gid://gitlab/Project/${s.id}` },
			fullPath: { type: 'ID', resolve: s => s.fullPath },
			name: { type: 'String', resolve: s => s.name },
		},
	},
	Namespace: {
		kind: 'object',
		fields: {
			id: { type: 'ID', resolve: s => `gid://gitlab/Namespaces::ProjectNamespace/${s.id}` },
			fullPath: { type: 'ID', resolve: s => s.fullPath },
			name: { type: 'String', resolve: s => s.name },
		},
	},
};

// LIVE-VERIFIED (step "graphql unknown fragment type": Nope -> Note): some of the types GitLab has, only to build a "Did you mean".
const TYPE_NAMES = ['Note', 'Namespace', 'Project', 'User', 'Group', 'WorkItem', 'Issue', 'Todo', 'Query', 'Mutation'];

// UNVERIFIABLE (the schema is not available offline): some of the fields of the Query type, only to build the "Did you mean" of an
// unknown field. LIVE-VERIFIED for `nope` -> `note`; the rest of GitLab's list is not reproduced.
const QUERY_FIELD_NAMES = [
	'note',
	'namespace',
	'project',
	'projects',
	'group',
	'groups',
	'user',
	'users',
	'workItem',
	'workItemsByReference',
	'currentUser',
	'metadata',
	'milestone',
	'issue',
	'echo',
	'todo',
];

const INPUT_TYPES: Record<string, { fields: Record<string, { required: boolean }> }> = {
	WorkItemUpdateInput: {
		fields: {
			id: { required: true },
			hierarchyWidget: { required: false },
			title: { required: false },
			stateEvent: { required: false },
			clientMutationId: { required: false },
		},
	},
	WorkItemConvertInput: {
		fields: { id: { required: true }, workItemTypeId: { required: true }, clientMutationId: { required: false } },
	},
	WorkItemHierarchyUpdateInput: {
		fields: {
			parentId: { required: false },
			childrenIds: { required: false },
			adjacentWorkItemId: { required: false },
			relativePosition: { required: false },
		},
	},
};

const KNOWN_SCALARS = new Set([
	'String',
	'ID',
	'Int',
	'Float',
	'Boolean',
	'Time',
	'WorkItemID',
	'WorkItemsTypeID',
	'WorkItemState',
	'WorkItemWidgetType',
]);

const isWidgetTypeName = (name: string): boolean => /^WorkItemWidget[A-Z]/.test(name);

/** The type a field of `typeName` can be asked for: widgets other than the ones above only answer `type`. */
function typeDef(typeName: string): TypeDef | undefined {
	const known = TYPES[typeName];
	if (known !== undefined) return known;
	if (KNOWN_SCALARS.has(typeName)) return undefined;
	if (isWidgetTypeName(typeName)) return { kind: 'object', fields: widgetBase };
	return undefined;
}

// ------------------------------------------------------------------------------------------------ errors

interface GqlError {
	message: string;
	locations?: Array<{ line: number; column: number }>;
	path?: Array<string | number>;
	extensions?: Record<string, unknown>;
}

function levenshtein(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0]!;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const held = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
			previous = held;
		}
	}
	return row[b.length]!;
}

function suggestion(name: string, candidates: readonly string[]): string {
	const limit = Math.max(1, Math.floor(name.length / 3));
	let best: string | undefined;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const distance = levenshtein(name.toLowerCase(), candidate.toLowerCase());
		if (distance <= limit && distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best === undefined ? '' : ` (Did you mean \`${best}\`?)`;
}

// ------------------------------------------------------------------------------------------------ validation

class Validator {
	readonly errors: GqlError[] = [];
	constructor(private readonly document: Document) {}

	validateOperation(operation: OperationNode): void {
		const root = operation.operation === 'mutation' ? 'Mutation' : 'Query';
		const base: Array<string | number> = [
			operation.operation,
			...(operation.name === undefined ? [] : [operation.name]),
		];
		this.validateSelection(root, operation.selection, base, new Set());
	}

	private validateSelection(
		typeName: string,
		selection: SelectionNode[],
		path: Array<string | number>,
		spreading: Set<string>
	): void {
		const def = typeDef(typeName);
		for (const node of selection) {
			if (node.kind === 'inline') {
				const condition = node.typeCondition ?? typeName;
				if (typeDef(condition) === undefined && !KNOWN_SCALARS.has(condition)) {
					this.errors.push({
						// LIVE-VERIFIED (step "graphql unknown fragment type"): suggests among GitLab's types, path ends with "... on <Type>".
						message: `No such type ${condition}, so it can't be a fragment condition${suggestion(condition, TYPE_NAMES)}`,
						locations: [{ line: node.line, column: node.column }],
						path: [...path, `... on ${condition}`],
						extensions: { code: 'undefinedType', typeName: condition },
					});
					continue;
				}
				this.validateSelection(condition, node.selection, path, spreading);
				continue;
			}
			if (node.kind === 'spread') {
				const fragment = this.document.fragments.get(node.name);
				if (fragment === undefined) {
					this.errors.push({
						message: `Fragment ${node.name} was used, but not defined`,
						locations: [{ line: node.line, column: node.column }],
						path: [...path, `... ${node.name}`],
						extensions: { code: 'useAndDefineFragment', fragmentName: node.name },
					});
					continue;
				}
				if (spreading.has(node.name)) continue;
				this.validateSelection(
					fragment.typeCondition,
					fragment.selection,
					path,
					new Set([...spreading, node.name])
				);
				continue;
			}
			const fieldPath = [...path, node.alias ?? node.name];
			if (node.name === '__typename') continue;
			const field = def?.fields[node.name];
			// The widgets and connections have dozens of fields on GitLab and the mock knows two: an unknown one is not "missing".
			if (
				field === undefined &&
				(typeName === 'WorkItemWidget' || isWidgetTypeName(typeName) || typeName.endsWith('Connection'))
			)
				throw new GqlNotModelled(`the field ${node.name} of ${typeName}`);
			if (field === undefined) {
				const names = typeName === 'Query' ? QUERY_FIELD_NAMES : Object.keys(def?.fields ?? {});
				this.errors.push({
					message: `Field '${node.name}' doesn't exist on type '${typeName}'${suggestion(node.name, names)}`,
					locations: [{ line: node.line, column: node.column }],
					path: [...path, node.name],
					extensions: { code: 'undefinedField', typeName, fieldName: node.name },
				});
				continue;
			}
			const known = Object.keys(field.args ?? {});
			for (const arg of node.args) {
				if (!known.includes(arg.name)) {
					this.errors.push({
						message: `Field '${node.name}' doesn't accept argument '${arg.name}'`,
						locations: [{ line: node.line, column: node.column }],
						path: [...path, node.name, arg.name],
						// LIVE-VERIFIED (step "graphql unknown argument"): typeName is the class "Field".
						extensions: {
							code: 'argumentNotAccepted',
							name: node.name,
							typeName: 'Field',
							argumentName: arg.name,
						},
					});
				}
			}
			const missing = Object.entries(field.args ?? {})
				.filter(([name, def2]) => def2.required === true && !node.args.some(arg => arg.name === name))
				.map(([name]) => name);
			if (missing.length > 0) {
				this.errors.push({
					message: `Field '${node.name}' is missing required arguments: ${missing.join(', ')}`,
					locations: [{ line: node.line, column: node.column }],
					path: [...path, node.name],
					extensions: {
						code: 'missingRequiredArguments',
						className: 'Field',
						name: node.name,
						arguments: missing.join(', '),
					},
				});
			}
			const composite = typeDef(field.type) !== undefined;
			if (composite && node.selection === undefined) {
				this.errors.push({
					message: `Field must have selections (field '${node.name}' returns ${field.type} but has no selections. Did you mean '${node.name} { ... }'?)`,
					locations: [{ line: node.line, column: node.column }],
					path: [...path, node.name],
					extensions: { code: 'selectionMismatch', nodeName: `field '${node.name}'`, typeName: field.type },
				});
			} else if (!composite && node.selection !== undefined) {
				this.errors.push({
					// LIVE-VERIFIED (step "graphql selection on a scalar"): the message lists the selected names the way Ruby prints them.
					message: `Selections can't be made on scalars (field '${node.name}' returns ${field.type} but has selections ${JSON.stringify(
						node.selection.map(selected => (selected.kind === 'field' ? selected.name : '...'))
					)})`,
					locations: [{ line: node.line, column: node.column }],
					path: [...path, node.name],
					extensions: { code: 'selectionMismatch', nodeName: `field '${node.name}'`, typeName: field.type },
				});
			} else if (composite && node.selection !== undefined) {
				this.validateSelection(field.type, node.selection, fieldPath, spreading);
			}
		}
	}
}

// ------------------------------------------------------------------------------------------------ execution

type Variables = Record<string, unknown>;

function valueOf(value: Value, variables: Variables): unknown {
	switch (value.k) {
		case 'var':
			return variables[value.name];
		case 'scalar':
			return value.v;
		case 'list':
			return value.items.map(item => valueOf(item, variables));
		default:
			return Object.fromEntries(value.fields.map(field => [field.name, valueOf(field.value, variables)]));
	}
}

function included(directives: Directive[], variables: Variables): boolean {
	for (const directive of directives) {
		if (directive.name !== 'include' && directive.name !== 'skip') continue;
		const arg = directive.args.find(a => a.name === 'if');
		const flag = arg === undefined ? false : valueOf(arg.value, variables) === true;
		if (directive.name === 'include' && !flag) return false;
		if (directive.name === 'skip' && flag) return false;
	}
	return true;
}

class Executor {
	readonly errors: GqlError[] = [];
	constructor(
		private readonly document: Document,
		private readonly variables: Variables,
		private readonly ctx: Ctx
	) {}

	/** The fields to resolve for an object of `typeName`, merged per response key (fragments applied). */
	private collect(typeName: string, selection: SelectionNode[], out: Map<string, FieldNode[]>): void {
		for (const node of selection) {
			if (!included(node.directives, this.variables)) continue;
			if (node.kind === 'field') {
				const key = node.alias ?? node.name;
				out.set(key, [...(out.get(key) ?? []), node]);
			} else if (node.kind === 'inline') {
				if (node.typeCondition === undefined || this.applies(node.typeCondition, typeName))
					this.collect(typeName, node.selection, out);
			} else {
				const fragment = this.document.fragments.get(node.name);
				if (fragment !== undefined && this.applies(fragment.typeCondition, typeName))
					this.collect(typeName, fragment.selection, out);
			}
		}
	}

	private applies(condition: string, typeName: string): boolean {
		return condition === typeName || (condition === 'WorkItemWidget' && isWidgetTypeName(typeName));
	}

	runSelection(
		typeName: string,
		source: unknown,
		selection: SelectionNode[],
		path: Array<string | number>
	): Record<string, unknown> {
		const fields = new Map<string, FieldNode[]>();
		this.collect(typeName, selection, fields);
		const out: Record<string, unknown> = {};
		const def = typeDef(typeName);
		for (const [key, nodes] of fields) {
			const first = nodes[0]!;
			const fieldPath = [...path, key];
			if (first.name === '__typename') {
				out[key] = typeName;
				continue;
			}
			const field = def?.fields[first.name];
			if (field === undefined) continue;
			const args: Record<string, unknown> = {};
			for (const arg of first.args) args[arg.name] = valueOf(arg.value, this.variables);
			try {
				const resolved = field.resolve(source, args, this.ctx);
				const merged = nodes.flatMap(node => node.selection ?? []);
				out[key] = this.complete(field, resolved, merged, fieldPath);
			} catch (error) {
				if (error instanceof GqlFieldError) {
					this.errors.push({
						message: error.message,
						locations: [{ line: first.line, column: first.column }],
						path: fieldPath,
					});
					out[key] = null;
				} else throw error;
			}
		}
		return out;
	}

	private complete(
		field: FieldDef,
		value: unknown,
		selection: SelectionNode[],
		path: Array<string | number>
	): unknown {
		if (value === null || value === undefined) return null;
		if (field.list === true && Array.isArray(value)) {
			return value.map((item, index) => this.completeOne(field, item, selection, [...path, index]));
		}
		return this.completeOne(field, value, selection, path);
	}

	private completeOne(
		field: FieldDef,
		value: unknown,
		selection: SelectionNode[],
		path: Array<string | number>
	): unknown {
		if (value === null || value === undefined) return null;
		if (typeof value === 'object' && 't' in (value as object) && 'v' in (value as object)) {
			const { t, v } = value as Obj;
			return this.runSelection(t, v, selection, path);
		}
		return value;
	}
}

const GID_TYPES = new Set(['WorkItemID', 'WorkItemsTypeID']);
const isGlobalId = (value: unknown): boolean =>
	typeof value === 'string' && /^gid:\/\/gitlab\/[\w:]+\/\d+$/.test(value);
const globalIdProblem = (path: string[], value: unknown): { path: string[]; explanation: string; message: string } => {
	const explanation = `${JSON.stringify(value)} is not a valid Global ID`;
	return { path, explanation, message: explanation };
};

function coerceVariables(operation: OperationNode, provided: Variables): { variables: Variables; errors: GqlError[] } {
	const variables: Variables = {};
	const errors: GqlError[] = [];
	for (const definition of operation.variables) {
		let value = provided[definition.name];
		if (value === undefined && definition.defaultValue !== undefined) value = valueOf(definition.defaultValue, {});
		if ((value === undefined || value === null) && definition.required) {
			errors.push({
				message: `Variable $${definition.name} of type ${definition.type} was provided invalid value`,
				locations: [{ line: 1, column: 1 }],
				extensions: {
					value: value ?? null,
					problems: [{ path: [], explanation: 'Expected value to not be null' }],
				},
			});
			continue;
		}
		const typeName = definition.type.replace(/[![\]]/g, '');
		// LIVE-VERIFIED (steps "read a malformed global id", "graphql variable of the wrong type"): a global id variable that is no global id.
		if (GID_TYPES.has(typeName) && value !== null && value !== undefined && !isGlobalId(value)) {
			const explanation = `${JSON.stringify(value)} is not a valid Global ID`;
			errors.push({
				message: `Variable $${definition.name} of type ${definition.type} was provided invalid value`,
				locations: [{ line: 1, column: 1 }],
				extensions: { value, problems: [{ path: [], explanation, message: explanation }] },
			});
			continue;
		}
		const input = INPUT_TYPES[typeName];
		if (input !== undefined && value !== null && value !== undefined) {
			if (typeof value !== 'object' || Array.isArray(value)) {
				errors.push({
					message: `Variable $${definition.name} of type ${definition.type} was provided invalid value`,
					locations: [{ line: 1, column: 1 }],
					extensions: {
						value,
						problems: [
							{ path: [], explanation: `Could not coerce value ${JSON.stringify(value)} to ${typeName}` },
						],
					},
				});
				continue;
			}
			const problems: Array<{ path: string[]; explanation: string; message?: string }> = [];
			for (const key of Object.keys(value as object)) {
				if (input.fields[key] === undefined)
					problems.push({ path: [key], explanation: `Field is not defined on ${typeName}` });
			}
			for (const [key, rule] of Object.entries(input.fields)) {
				const held = (value as Record<string, unknown>)[key];
				if (rule.required && (held === undefined || held === null))
					problems.push({ path: [key], explanation: 'Expected value to not be null' });
			}
			// LIVE-VERIFIED (steps "workItemUpdate with a malformed id" / "... parent id", "convert with a malformed type id").
			const held = value as Record<string, unknown>;
			for (const key of ['id', 'workItemTypeId']) {
				if (
					input.fields[key] !== undefined &&
					held[key] !== undefined &&
					held[key] !== null &&
					!isGlobalId(held[key])
				)
					problems.push(globalIdProblem([key], held[key]));
			}
			const hierarchy = held['hierarchyWidget'];
			if (hierarchy !== null && typeof hierarchy === 'object') {
				const parentId = (hierarchy as Record<string, unknown>)['parentId'];
				if (parentId !== undefined && parentId !== null && !isGlobalId(parentId))
					problems.push(globalIdProblem(['hierarchyWidget', 'parentId'], parentId));
			}
			if (problems.length > 0) {
				errors.push({
					message: `Variable $${definition.name} of type ${definition.type} was provided invalid value for ${problems.map(p => p.path.join('.')).join(', ')} (${problems.map(p => p.explanation).join(', ')})`,
					locations: [{ line: 1, column: 1 }],
					extensions: { value, problems },
				});
				continue;
			}
		}
		variables[definition.name] = value;
	}
	return { variables, errors };
}

/**
 * Runs one GraphQL request. Returns the JSON body (always HTTP 200 on GitLab, errors are in the body). Throws GqlForbidden when the
 * token lacks the permission of the operation (the caller answers the REST-shaped 403).
 */
export function executeGraphql(
	request: { query?: unknown; variables?: unknown; operationName?: unknown },
	host: GqlHost
): unknown {
	if (typeof request.query !== 'string' || request.query.trim() === '') {
		// LIVE-VERIFIED (steps "graphql without a query", "graphql with an empty query"): both are a parse error at the end of nothing.
		return { errors: [{ message: 'Unexpected end of document', locations: [{ line: 1, column: 1 }] }] };
	}
	let document: Document;
	try {
		document = new Parser(lex(request.query)).parseDocument();
	} catch (error) {
		if (error instanceof GqlSyntaxError) {
			return { errors: [{ message: error.message, locations: [{ line: error.line, column: error.column }] }] };
		}
		throw error;
	}
	const name = typeof request.operationName === 'string' ? request.operationName : undefined;
	const candidates = name === undefined ? document.operations : document.operations.filter(op => op.name === name);
	if (candidates.length === 0) {
		return {
			errors: [
				{ message: name === undefined ? 'No operations in query document' : `No operation named "${name}"` },
			],
		};
	}
	if (candidates.length > 1) {
		return { errors: [{ message: 'An operation name is required' }] };
	}
	const operation = candidates[0]!;
	if (operation.operation === 'subscription') throw new GqlNotModelled('a GraphQL subscription');
	const validator = new Validator(document);
	validator.validateOperation(operation);
	if (validator.errors.length > 0) return { errors: validator.errors };
	const provided =
		typeof request.variables === 'object' && request.variables !== null ? (request.variables as Variables) : {};
	const coerced = coerceVariables(operation, provided);
	if (coerced.errors.length > 0) return { errors: coerced.errors };
	const executor = new Executor(document, coerced.variables, { host });
	const root = operation.operation === 'mutation' ? 'Mutation' : 'Query';
	const data = executor.runSelection(root, undefined, operation.selection, []);
	return executor.errors.length > 0 ? { errors: executor.errors, data } : { data };
}
