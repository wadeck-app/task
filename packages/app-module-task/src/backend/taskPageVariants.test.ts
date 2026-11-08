import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_VIEWS_DIR, generateTaskPage, taskPageFile } from '../../../../scripts/generate-task-page.mjs';

/*
 * The task page is an experiment between THREE designs (issue, bar, flow): task-page.yaml is GENERATED from
 * src/dsl-views/variants/* and holds one AbTest. These tests are the contract every design keeps, so that no design
 * silently drops a control of the page or shows a fact twice. See variants/_page.yaml.
 */

type Node = Record<string, unknown>;
const packageDir = join(import.meta.dirname, '../..');
const viewsDir = join(packageDir, 'src/dsl-views');

const parse = (text: string): Node => yaml.load(text) as Node;
const page = parse(readFileSync(taskPageFile(), 'utf8'));

const isNode = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);
const sections = page.sections as Node[];
// The experiment is the last section of the PageContent; the nodes before it are the notices shared by every design.
const switcher = sections[sections.length - 1] as Node;
const notices = sections.slice(0, -1);
interface Fragment {
	label: string;
	hint: string;
	view: unknown;
}
const variants = switcher.variants as Record<string, Fragment>;
const designNames = Object.keys(variants);

function walk(value: unknown, visit: (node: Node, ancestors: Node[]) => void, ancestors: Node[] = []): void {
	if (Array.isArray(value)) {
		value.forEach(item => walk(item, visit, ancestors));
	} else if (isNode(value)) {
		visit(value, ancestors);
		Object.values(value).forEach(item => walk(item, visit, [...ancestors, value]));
	}
}

const nodesOf = (tree: unknown): Node[] => {
	const found: Node[] = [];
	walk(tree, node => found.push(node));
	return found;
};
const stringsOf = (tree: unknown): string[] => {
	const found: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === 'string') found.push(value);
		else if (Array.isArray(value)) value.forEach(collect);
		else if (isNode(value)) Object.values(value).forEach(collect);
	};
	collect(tree);
	return found;
};

const designs = designNames.map(name => [name, variants[name]!.view] as const);

describe('the generated task-page.yaml', () => {
	it('is what the generator produces now (run "npm run views --workspace=packages/app-module-task" if not)', () => {
		expect(readFileSync(taskPageFile(), 'utf8').replace(/\r\n/g, '\n')).toBe(generateTaskPage());
	});

	it('has no YAML anchors or aliases (the compiler would have to expand them)', () => {
		expect(readFileSync(taskPageFile(), 'utf8')).not.toMatch(/(^|\s)[&*][A-Za-z0-9_-]+(\s|$)/m);
	});

	it('stays small: the three designs are not multiplied by option rows any more (the eleven designs were 1 MB)', () => {
		expect(readFileSync(taskPageFile(), 'utf8').length).toBeLessThan(150_000);
	});
});

describe('the experiment', () => {
	it('is ONE AbTest "Task page" at the page root: issue (initial), bar, flow, in that order', () => {
		expect(sections.filter(s => s.$type === 'AbTest')).toHaveLength(1);
		expect(switcher.$type).toBe('AbTest');
		expect(switcher.id).toBe('task-design');
		expect(switcher.label).toBe('Task page');
		expect(switcher.initial).toBe('issue');
		expect(designNames).toEqual(['issue', 'bar', 'flow']);
		// The PageContent must not cap the designs at its own 72rem centred column: each design sets its width.
		expect(page.maxWidth).toBe('full');
	});

	it('has no other row in the dock: none of the old dimensions and no nested option (the designs are decided, not tuned)', () => {
		const ids: unknown[] = [];
		walk(
			designs.map(d => d[1]),
			node => {
				if (node.$type === 'AbTest') ids.push(node.id);
			}
		);
		expect(ids).toEqual([]);
		const text = readFileSync(taskPageFile(), 'utf8');
		for (const gone of [
			'task-title',
			'task-header',
			'task-controls',
			'task-width',
			'dim.title',
			'VariantSwitcher',
		]) {
			expect(text, gone).not.toContain(gone);
		}
		// The eleven old designs.
		for (const gone of ['github-a', 'github-b', 'gitlab-a', 'jira-b', 'linear-a', 'notion-b', 'current']) {
			expect(designNames).not.toContain(gone);
		}
	});

	it('names every design with a label and a hint', () => {
		for (const name of designNames) {
			expect(variants[name]!.label, `${name} label`).toMatch(/\S/);
			expect(variants[name]!.hint, `${name} hint`).toMatch(/\S/);
		}
	});

	it('draws nothing until the task is loaded (the notices say why when there is no task), and sets its own width', () => {
		for (const [name, view] of designs) {
			const root = view as Node;
			expect(root.$if, `${name}: the root needs $if: $sources.detail.task`).toBe('$sources.detail.task');
			const frame = nodesOf(root).find(n => n.$type === 'task:WidthFrame');
			expect(frame, `${name}: no WidthFrame`).toBeDefined();
			expect(['wide', 'reading'], `${name}: width`).toContain(frame!.width);
		}
		// Issue is the wide document (sidebar); bar and flow are one narrow column.
		const widthOf = (name: string): unknown =>
			nodesOf(variants[name]!.view).find(n => n.$type === 'task:WidthFrame')!.width;
		expect([widthOf('issue'), widthOf('bar'), widthOf('flow')]).toEqual(['wide', 'reading', 'reading']);
	});

	// The extension point task:project-header sits OUTSIDE the switcher: every design has it by construction.
	it('has the slot task:project-header outside the switcher, once, whatever the design', () => {
		const slots = nodesOf(notices).filter(n => n.$type === 'ExtensionSlot');
		expect(slots).toEqual([
			{ $type: 'ExtensionSlot', $if: '$sources.projectHeader', items: '$sources.projectHeader' },
		]);
		expect(notices[0]).toMatchObject({ $type: 'task:ChipRow', $if: '$route.project' });
		expect(page.$sources).toHaveProperty('projectHeader.url', 'GET /api/slots/task:project-header');
		for (const [name, view] of designs) {
			expect(
				nodesOf(view).filter(n => n.$type === 'ExtensionSlot' && n.items === '$sources.projectHeader'),
				name
			).toEqual([]);
		}
	});

	it('keeps the notices OUTSIDE the switcher, so every design has the same error and empty states (and the delete answer survives the task)', () => {
		const labels = notices.slice(1).map(s => `${String(s.$type)}:${String(s.label)}`);
		expect(labels).toEqual([
			'Badge:$sources.projects.noProjectsText',
			'Badge:$sources.projects.selectedProblem',
			'Badge:$sources.projects.unknownProjectText',
			'Badge:$sources.detail.errorText',
			'Badge:$sources.detail.warningText',
			'task:Notice:$ctx.deleteResult.errorText',
			'task:Notice:$ctx.deleteResult.deletedText',
			'task:Notice:$ctx.deleteResult.undeliveredText',
		]);
		expect(notices.slice(1).map(s => s.$if)).toEqual([
			'$sources.projects.noProjects',
			'$sources.projects.selectedProblem',
			'$sources.projects.unknownProjectText',
			'$sources.detail.errorText',
			'$sources.detail.warningText',
			'$ctx.deleteResult.errorText',
			'$ctx.deleteResult.deletedText',
			'$ctx.deleteResult.undeliveredText',
		]);
	});
});

// Each fact is shown ONCE per design, where it is edited: the id in the header, the status in one control, and so on. A binding
// counts when a node DISPLAYS it (a prop other than $if, params, initialData, or the `value` that marks the current choice of a popover).
describe('every fact is shown once per design (single source of truth)', () => {
	const SKIP = new Set(['$type', '$if', 'params', 'initialData']);
	const shows = (node: Node, bindings: string[]): boolean =>
		Object.entries(node).some(
			([key, value]) =>
				!SKIP.has(key) &&
				!(node.$type === 'task:PropertyPopover' && key === 'value') &&
				typeof value === 'string' &&
				bindings.includes(value)
		);
	// Two nodes that can never be on screen together (a project with and without configured types, a body that adds information or not).
	const PARTITIONS = [
		'$sources.detail.hasTypes',
		'$sources.detail.noTypes',
		'$sources.detail.bodyAddsInfo',
		'$sources.detail.noBodyInfo',
	];
	const partitionOf = (ancestors: Node[], node: Node): string =>
		([...ancestors, node].map(n => n.$if).find(cond => PARTITIONS.includes(String(cond))) as string | undefined) ??
		'';
	const countsOf = (tree: unknown, bindings: string[]): Map<string, number> => {
		const counts = new Map<string, number>();
		walk(tree, (node, ancestors) => {
			if (!shows(node, bindings)) return;
			const key = partitionOf(ancestors, node);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		});
		return counts;
	};

	const FACTS: Array<{ fact: string; bindings: string[]; exactlyOnce: boolean }> = [
		{ fact: 'id', bindings: ['$sources.detail.task.id'], exactlyOnce: true },
		{ fact: 'title', bindings: ['$sources.detail.headline'], exactlyOnce: true },
		{
			fact: 'status',
			bindings: ['$sources.detail.task.status', '$sources.detail.pillTexts.status'],
			exactlyOnce: true,
		},
		{
			fact: 'labels',
			bindings: ['$sources.detail.labelList', '$sources.detail.pillTexts.labels'],
			exactlyOnce: true,
		},
		{
			fact: 'parent',
			bindings: [
				'$sources.detail.parentRow.titleText',
				'$sources.detail.pillTexts.parent',
				'$sources.detail.parentRow',
			],
			exactlyOnce: true,
		},
		{ fact: 'created', bindings: ['$sources.detail.createdAt', '$sources.detail.createdText'], exactlyOnce: true },
		{ fact: 'updated', bindings: ['$sources.detail.updatedAt', '$sources.detail.updatedText'], exactlyOnce: true },
		{
			fact: 'sub-tasks',
			bindings: ['$sources.detail.checklistRows', '$sources.detail.children'],
			exactlyOnce: true,
		},
		{
			fact: 'metadata',
			bindings: ['$sources.detail.metaEntries', '$sources.detail.metaList', '$sources.detail.metaRows'],
			exactlyOnce: true,
		},
		{ fact: 'activity', bindings: ['$sources.detail.activity'], exactlyOnce: true },
		{
			fact: 'blocked',
			bindings: ['$sources.detail.blockedText', '$sources.detail.pillTexts.blocked'],
			exactlyOnce: false,
		},
		// The project is in the shell crumb; the whole task is the title and the body.
		{ fact: 'project', bindings: ['$sources.detail.projectText', '$sources.detail.project'], exactlyOnce: false },
		{ fact: 'whole title', bindings: ['$sources.detail.task.title'], exactlyOnce: false },
	];

	it.each(designs)(
		'%s: each fact is bound by one node (two only when they cannot be on screen together)',
		(name, view) => {
			for (const { fact, bindings, exactlyOnce } of FACTS) {
				const counts = countsOf(view, bindings);
				for (const [partition, count] of counts) {
					expect(
						count,
						`${name}: "${fact}" is shown ${count} times (partition ${partition || 'always'})`
					).toBeLessThanOrEqual(1);
				}
				const total = [...counts.values()].reduce((a, b) => a + b, 0);
				if (exactlyOnce) expect(total, `${name}: "${fact}" is not shown`).toBeGreaterThanOrEqual(1);
			}
		}
	);

	it.each(designs)(
		'%s: the project and the whole title are not repeated (the crumb names the project, the headline is the title)',
		(name, view) => {
			const text = JSON.stringify(view);
			for (const gone of [
				'detail.projectText',
				'detail.task.title',
				'titleShort',
				'hasShortTitle',
				'descriptionText',
				'hasDescription',
			]) {
				expect(text, `${name}: ${gone}`).not.toContain(gone);
			}
		}
	);

	it.each(designs)(
		'%s: the status is edited where it is shown, the type too (a type with a "None" choice)',
		(name, view) => {
			const nodes = nodesOf(view);
			const statusControls = nodes.filter(
				n => ['setStatus', 'setStatusTo'].includes(String(n.action)) && String(n.$type).startsWith('task:')
			);
			expect(
				statusControls.map(n => n.$type),
				name
			).toHaveLength(1);
			const typePopovers = nodes.filter(n => n.$type === 'task:PropertyPopover' && n.action === 'setType');
			for (const popover of typePopovers) expect(popover.options, name).toBe('$sources.detail.typeOptions');
		}
	);
});

// A logical control of the page -> the props that can provide it. A design keeps every control.
describe.each(designs)('design %s keeps every control of the task page', (name, view) => {
	const nodes = nodesOf(view);
	const strings = new Set(stringsOf(view));
	const actionProps = ['action', 'addAction', 'removeAction', 'setAction', 'doneAction', 'reopenAction'];
	const actionsRun = new Set<string>();
	for (const node of nodes) {
		for (const prop of actionProps) if (typeof node[prop] === 'string') actionsRun.add(node[prop] as string);
		if (Array.isArray(node.closeOnActions)) (node.closeOnActions as string[]).forEach(a => actionsRun.add(a));
		if (typeof node.onSubmit === 'string' && node.onSubmit.startsWith('$ctx.'))
			actionsRun.add(node.onSubmit.slice(5));
	}
	// removeLinkRow is run by the x of the rows the links route builds (dslNodes.ts), which the design draws as a slot.
	if (strings.has('$sources.links.groupSections')) actionsRun.add('removeLinkRow');

	it.each([
		['change the status', ['setStatus', 'setStatusTo']],
		['change the type (or clear it)', ['setType']],
		['add a label', ['addLabel']],
		['remove a label', ['removeLabelChip']],
		['add or edit a metadata entry', ['setMeta']],
		['remove a metadata entry', ['removeMetaKey']],
		['set the parent', ['setParent']],
		['detach the parent', ['removeParent']],
		['add a link', ['addLink']],
		['remove a link', ['removeLinkRow']],
		['edit the title and the body', ['setText']],
		['add a sub-task', ['createSubtask']],
		['tick a sub-task', ['setChildStatus']],
		['delete the task', ['deleteTask']],
	])('can %s', (_feature, names) => {
		expect(
			names.filter(n => actionsRun.has(n)),
			`${name} cannot ${_feature}`
		).not.toEqual([]);
	});

	it('edits the title (body.title) and the description (body.description) with setText', () => {
		const edits = nodes.filter(n => n.$type === 'task:InlineText' && n.action === 'setText');
		expect(edits.map(n => n.valueParam).sort()).toEqual(expect.arrayContaining(['description', 'title']));
		const titleEdit = edits.find(n => n.valueParam === 'title')!;
		expect(titleEdit.value).toBe('$sources.detail.headline');
	});

	it('shows the body only when it adds information, and offers to add one otherwise', () => {
		const description = nodes.filter(n => n.$type === 'task:InlineText' && n.valueParam === 'description');
		expect(description.map(n => n.$if).sort()).toEqual([
			'$sources.detail.bodyAddsInfo',
			'$sources.detail.noBodyInfo',
		]);
		expect(description.find(n => n.$if === '$sources.detail.bodyAddsInfo')!.value).toBe('$sources.detail.body');
		expect(description.find(n => n.$if === '$sources.detail.noBodyInfo')!.value).toBe('');
	});

	it('uses the pickers: parent and link through the task search, labels through the combobox, metadata through the editor', () => {
		const pickers = nodes.filter(n => n.$type === 'task:TaskPicker');
		const parent = pickers.find(n => n.action === 'setParent')!;
		expect(parent, `${name}: parent picker`).toBeDefined();
		// A parent cannot be the task itself or one of its descendants.
		expect(parent.excludeDescendantsOf).toBe('$route.id');
		const link = pickers.find(n => n.action === 'addLink')!;
		expect(link, `${name}: link picker`).toBeDefined();
		expect(link.choices).toBe('$sources.detail.linkTypeOptions');
		expect(link.choiceKey).toBe('type');
		expect(link.bodyKey).toBe('target');
		expect(link.excludeIds).toEqual(['$route.id']);
		for (const picker of pickers)
			expect(picker.projectParam, `${name}: picker without a project`).toBe('$sources.detail.projectParam');
		expect(nodes.filter(n => n.$type === 'task:LabelCombobox')).toHaveLength(1);
		expect(nodes.filter(n => n.$type === 'task:MetaEditor')).toHaveLength(1);
		expect(nodes.find(n => n.$type === 'task:MetaEditor')).toMatchObject({
			setAction: 'setMeta',
			removeAction: 'removeMetaKey',
			entries: '$sources.detail.metaEntries',
		});
		// The popovers that hold a picker close when its action has finished.
		for (const popover of nodes.filter(
			n => n.$type === 'task:PropertyPopover' && n.items !== undefined && n.options === undefined
		)) {
			const ran = nodesOf(popover.items).flatMap(n => [
				n.action,
				n.onSubmit && String(n.onSubmit).slice('$ctx.'.length),
			]);
			const closing = (popover.closeOnActions ?? []) as string[];
			for (const action of ran.filter((a): a is string => typeof a === 'string' && closing.length > 0)) {
				expect(closing, `${name}: ${String(popover.label)} popover does not close after ${action}`).toContain(
					action
				);
			}
		}
	});

	it('sub-tasks: a checklist with an add row (title and parent in the body) and the statuses of the config', () => {
		const list = nodes.filter(n => n.$type === 'task:TaskChecklist');
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			rows: '$sources.detail.checklistRows',
			doneAction: 'setChildStatus',
			reopenAction: 'setChildStatus',
			terminalStatus: '$sources.detail.terminalStatus',
			reopenStatus: '$sources.detail.reopenStatus',
			addAction: 'createSubtask',
			parentId: '$route.id',
			titleKey: 'title',
		});
	});

	it('the relations are the groups of the links route (an x per row), never a second remove form', () => {
		expect(strings.has('$sources.links.groupSections'), name).toBe(true);
		expect(nodes.filter(n => n.$type === 'Form' && n.onSubmit === '$ctx.removeLink')).toEqual([]);
	});

	it('the delete dialog shows the consequences, offers the cascade only with descendants, and never asks for the id', () => {
		const dialog = nodes.find(n => n.$type === 'Dialog')!;
		expect(dialog, `${name}: no delete dialog`).toBeDefined();
		const inside = nodesOf(dialog);
		expect(inside.some(n => n.label === '$sources.detail.deleteImpactText')).toBe(true);
		const form = inside.find(n => n.$type === 'Form')!;
		expect(form).toMatchObject({ onSubmit: '$ctx.deleteTask', initialData: '$sources.detail.forms.delete' });
		const fields = inside.filter(n => n.bind !== undefined);
		expect(fields).toEqual([
			{
				$type: 'Switch',
				$if: '$sources.detail.hasDescendants',
				label: '$sources.detail.deleteCascadeLabel',
				bind: 'cascade',
			},
		]);
		const submit = inside.find(n => n.$type === 'ButtonAction' && n.type === 'submit')!;
		expect(submit).toMatchObject({ variant: 'danger' });
		// The dialog sits behind a menu, not in the toolbar.
		expect(nodes.some(n => n.$type === 'Popover' && nodesOf(n).includes(dialog))).toBe(true);
		expect(nodes.filter(n => n.$type === 'ButtonLink' && n.to === '$sources.detail.taskHrefs.deleteTasks')).toEqual(
			[]
		);
	});

	it('an empty Parent never stands over nothing: it says "none"', () => {
		const parents = nodes.filter(n => n.$type === 'task:PropertyPopover' && n.label === 'Parent');
		expect(parents.length).toBe(1);
		const pill = parents[0]!;
		// A pill carries "Parent: none" itself (pillTexts); a row says `empty: none`.
		expect(pill.empty === 'none' || pill.valueText === '$sources.detail.pillTexts.parent', name).toBe(true);
	});
});

describe('feedback: the error and the undelivered events of every action are shown, once, in a node that wraps', () => {
	const RESULT_KEYS = [
		'statusResult',
		'typeResult',
		'labelResult',
		'metaResult',
		'parentResult',
		'linkResult',
		'linkRowResult',
		'textResult',
		'subtaskResult',
	];
	it.each(designs)(
		'%s: one task:Notice for the error and one for the undelivered events of each result key',
		(name, view) => {
			const notices = nodesOf(view).filter(n => n.$type === 'task:Notice' || n.$type === 'Badge');
			for (const key of RESULT_KEYS) {
				for (const [field, variant] of [
					['errorText', 'danger'],
					['undeliveredText', 'warning'],
				] as const) {
					const shown = notices.filter(n => n.label === `$ctx.${key}.${field}`);
					expect(shown, `${name}: $ctx.${key}.${field}`).toHaveLength(1);
					expect(shown[0], `${name}: ${key} ${field}`).toMatchObject({
						$type: 'task:Notice',
						$if: `$ctx.${key}.${field}`,
						variant,
					});
				}
			}
			// Nothing else reads a result key: the delete answer is read by the page-level notices only.
			expect(JSON.stringify(view)).not.toContain('$ctx.deleteResult');
		}
	);

	it.each(designs)(
		'%s: no plain Badge shows an answer of an action (a Badge keeps one line; the replay command is long)',
		(name, view) => {
			const result = /^\$ctx\.\w+\.(undeliveredText|errorText)$/;
			const plain = nodesOf(view).filter(
				n => n.$type !== 'task:Notice' && typeof n.label === 'string' && result.test(n.label)
			);
			expect(
				plain.map(n => `${String(n.$type)} ${String(n.label)}`),
				name
			).toEqual([]);
		}
	);

	it('every action has its answer shown by some design or notice (no action without a resultKey)', () => {
		const actions = page.$actions as Record<string, { resultKey?: string }>;
		for (const [action, spec] of Object.entries(actions)) {
			expect(spec.resultKey, action).toMatch(/\w+Result$/);
		}
	});
});

describe('actions', () => {
	const actions = page.$actions as Record<string, { url: string; resultKey: string; reloadSources?: boolean }>;
	const everything = [...designs.map(d => d[1]), notices];
	const used = new Set<string>();
	for (const tree of everything) {
		for (const node of nodesOf(tree)) {
			for (const prop of ['action', 'addAction', 'removeAction', 'setAction', 'doneAction', 'reopenAction']) {
				if (typeof node[prop] === 'string') used.add(node[prop] as string);
			}
			if (Array.isArray(node.closeOnActions)) (node.closeOnActions as string[]).forEach(a => used.add(a));
		}
		for (const s of stringsOf(tree)) {
			const m = /^\$ctx\.([A-Za-z]+)$/.exec(s);
			if (m && /^(set|add|remove|create|delete)[A-Z]/.test(m[1]!)) used.add(m[1]!);
		}
	}
	used.add('removeLinkRow');

	it('declares exactly the actions the designs run: none missing, none left over from the old designs', () => {
		for (const name of used) expect(Object.keys(actions), `${name} is run but not declared`).toContain(name);
		expect(Object.keys(actions).sort()).toEqual([...used].sort());
	});

	it('every action asks for inline errors on the project of the page and reloads the sources (the delete too: the task is gone)', () => {
		for (const [name, action] of Object.entries(actions)) {
			expect(action.url, name).toContain('project={projectParam}');
			expect(action.url, name).toContain('inlineErrors=true');
			expect(action.reloadSources, name).toBe(true);
		}
	});

	it.each([
		[
			'setStatus',
			'POST /api/modules/task/tasks/{id}/status?project={projectParam}&inlineErrors=true',
			'statusResult',
		],
		['setType', 'POST /api/modules/task/tasks/{id}/type?project={projectParam}&inlineErrors=true', 'typeResult'],
		[
			'addLabel',
			'POST /api/modules/task/tasks/{id}/labels?project={projectParam}&inlineErrors=true',
			'labelResult',
		],
		[
			'removeLabelChip',
			'DELETE /api/modules/task/tasks/{id}/label-keys/{labelKey}?project={projectParam}&inlineErrors=true',
			'labelResult',
		],
		['setMeta', 'POST /api/modules/task/tasks/{id}/meta?project={projectParam}&inlineErrors=true', 'metaResult'],
		[
			'removeMetaKey',
			'DELETE /api/modules/task/tasks/{id}/meta-keys/{keyKey}?project={projectParam}&inlineErrors=true',
			'metaResult',
		],
		[
			'setParent',
			'POST /api/modules/task/tasks/{id}/parent?project={projectParam}&inlineErrors=true',
			'parentResult',
		],
		[
			'removeParent',
			'DELETE /api/modules/task/tasks/{id}/parent?project={projectParam}&inlineErrors=true',
			'parentResult',
		],
		['addLink', 'POST /api/modules/task/tasks/{id}/links?project={projectParam}&inlineErrors=true', 'linkResult'],
		[
			'removeLinkRow',
			'DELETE /api/modules/task/tasks/{id}/links?project={projectParam}&type={type}&target={targetEncoded}&inlineErrors=true',
			'linkRowResult',
		],
		['setText', 'PATCH /api/modules/task/tasks/{id}?project={projectParam}&inlineErrors=true', 'textResult'],
		['createSubtask', 'POST /api/modules/task/tasks?project={projectParam}&inlineErrors=true', 'subtaskResult'],
		[
			'setChildStatus',
			'POST /api/modules/task/tasks/{id}/status?project={projectParam}&inlineErrors=true',
			'subtaskResult',
		],
		['deleteTask', 'POST /api/modules/task/tasks/delete?project={projectParam}&inlineErrors=true', 'deleteResult'],
		// The stepper: the shell sends no body from task:SegmentedControl, so the status is in the path.
		[
			'setStatusTo',
			'POST /api/modules/task/tasks/{id}/status/{statusEncoded}?project={projectParam}&inlineErrors=true',
			'statusResult',
		],
	])('%s calls %s and publishes %s', (name, url, resultKey) => {
		expect(actions[name]!.url).toBe(url);
		expect(actions[name]!.resultKey).toBe(resultKey);
	});

	it('removing a label or a metadata key goes by base64url key (a "/" or "%" cannot travel in a path), and the components are given the keys', () => {
		const nodes = designs.flatMap(d => nodesOf(d[1]));
		for (const combo of nodes.filter(n => n.$type === 'task:LabelCombobox')) {
			expect(combo).toMatchObject({
				removeAction: 'removeLabelChip',
				labelKeys: '$sources.detail.labelKeys',
				labelParam: 'label',
			});
		}
		for (const editor of nodes.filter(n => n.$type === 'task:MetaEditor')) {
			expect(editor.keyParam).toBe('key');
		}
	});
});

describe('sources', () => {
	it('are the project list, the task, its links and the slot; the three read through projectQuery (never an empty query: the shell keeps the last answer of a skipped source)', () => {
		const sources = page.$sources as Record<string, { params?: Record<string, unknown> }>;
		expect(Object.keys(sources)).toEqual(['projects', 'detail', 'links', 'projectHeader']);
		for (const name of ['detail', 'links']) {
			expect(sources[name]!.params?.query, name).toBe('$source.projects.projectQuery');
		}
	});

	it.each(designs)('%s: reads its data only from the sources of the page', (name, view) => {
		for (const s of stringsOf(view)) {
			const m = /^\$sources\.([A-Za-z]+)/.exec(s);
			if (m) expect(['projects', 'detail', 'links'], `${name}: ${s}`).toContain(m[1]);
		}
		expect(
			nodesOf(view).some(n => '$sources' in n || '$actions' in n),
			name
		).toBe(false);
	});
});

describe('links and tabs: the tab strip carries History / Tasks / Tree, the breadcrumb the context', () => {
	it.each(designs)(
		'%s: the only link is "Open parent" (a forward feature); none leads back or repeats a tab',
		(name, view) => {
			const links = nodesOf(view).filter(n => n.$type === 'ButtonLink' || n.$type === 'BackLink');
			expect(
				links.map(n => [n.label, n.to]),
				name
			).toEqual([['Open parent', '$sources.detail.parentRow.href']]);
			const text = stringsOf(view).join('\n');
			for (const gone of [
				'taskHrefs.history',
				'taskHrefs.childrenList',
				'taskHrefs.deleteTasks',
				'hrefs.tree',
				'hrefs.tasks',
				'allProjectsHref',
				'globalHrefs',
				'tasksHref',
				'taskHrefs.detail',
			]) {
				expect(text, `${name}: ${gone}`).not.toContain(gone);
			}
		}
	);

	it.each(designs)('%s: no PageHeader (the title is the InlineText) and no giant heading', (name, view) => {
		const nodes = nodesOf(view);
		expect(
			nodes.filter(n => n.$type === 'PageHeader'),
			name
		).toEqual([]);
		const title = nodes.find(n => n.$type === 'task:InlineText' && n.valueParam === 'title')!;
		expect(String(title.textClass)).toContain('text-xl');
		expect(String(title.textClass)).not.toMatch(/text-(2xl|3xl|4xl)/);
	});
});

describe('constructs of the shell', () => {
	it.each(designs)(
		'%s: forms and fields are valid for the shell (bind only inside a Form, no negation, no empty-array tests)',
		(name, view) => {
			walk(view, (node, ancestors) => {
				if ('bind' in node) {
					expect(
						ancestors.some(a => a.$type === 'Form'),
						`${name}: bind outside a Form`
					).toBe(true);
				}
				if (node.$type === 'FieldSelect') {
					const form = [...ancestors].reverse().find(a => a.$type === 'Form');
					expect(
						form?.$if,
						`${name}: FieldSelect "${String(node.label)}" is not inside a Form with $if`
					).toBeTruthy();
				}
			});
			for (const s of stringsOf(view)) {
				if (s.startsWith('$')) expect(s, `${name}: negation expression`).not.toMatch(/(^|[\s(&|])!(?!=)/);
			}
		}
	);

	it.each(designs)(
		'%s: the title and the long texts cannot widen the page (everything sits in a WidthFrame, which breaks words)',
		(name, view) => {
			const root = nodesOf(view).find(n => n.$type === 'task:WidthFrame')!;
			const outside = nodesOf(view).filter(n => !nodesOf(root).includes(n) && n.$type !== undefined);
			// Only the guard stack around the frame is outside it.
			expect(
				outside.map(n => n.$type),
				name
			).toEqual(['VerticalStack']);
		}
	);

	it.each(designs)('%s: a row of several chips is a task:ChipRow (a HorizontalStack never wraps)', (name, view) => {
		const CHIPS = ['Badge', 'task:StatusBadge', 'RelativeDate', 'Tag'];
		for (const node of nodesOf(view)) {
			if (node.$type !== 'HorizontalStack' || !Array.isArray(node.items)) continue;
			const chips = (node.items as Node[]).filter(item => CHIPS.includes(String(item.$type)));
			expect(chips.length, name).toBeLessThanOrEqual(1);
		}
	});
});

// Built-in node types the installed shell is known to render: the ones the pages already use plus those checked in the shell
// (dsl-ui >= 318). Adding a type here is a decision: check it in the shell first.
const BUILTIN = new Set([
	'AbTest',
	'PageContent',
	'Section',
	'Card',
	'HorizontalStack',
	'VerticalStack',
	'Collapsible',
	'Divider',
	'Badge',
	'Tag',
	'RelativeDate',
	'Popover',
	'Dialog',
	'ExtensionSlot',
	'Form',
	'FieldSelect',
	'FieldText',
	'Switch',
	'ButtonAction',
	'ButtonLink',
]);

describe('node types', () => {
	const libExpected = ((): string[] | null => {
		const file = join(import.meta.dirname, '../../../dsl-lib-task/test/libEntries.test.ts');
		if (!existsSync(file)) return null;
		const match = /const EXPECTED = \[([\s\S]*?)\];/.exec(readFileSync(file, 'utf8'));
		return match ? [...match[1]!.matchAll(/'(\w+)'/g)].map(m => m[1]!) : null;
	})();

	it('every $type is a built-in known to the shell or a task:<Name> the dsl-lib exports', () => {
		expect(libExpected, 'packages/dsl-lib-task/test/libEntries.test.ts EXPECTED list not found').not.toBeNull();
		const problems: string[] = [];
		for (const [name, view] of [...designs, ['notices', notices] as const]) {
			for (const node of nodesOf(view)) {
				const type = node.$type;
				if (typeof type !== 'string') continue;
				if (type.startsWith('task:')) {
					if (!libExpected!.includes(type.slice(5)))
						problems.push(
							`${name}: ${type} is not exported by dsl-lib-task (EXPECTED: ${libExpected!.join(', ')})`
						);
				} else if (!BUILTIN.has(type) && !(type === 'PageContent' || type === 'ExtensionSlot')) {
					problems.push(`${name}: ${type} is not a known built-in (see BUILTIN in this test)`);
				}
			}
		}
		expect([...new Set(problems)]).toEqual([]);
	});

	it('uses the new components with the props they declare (a typo would be ignored by the shell)', () => {
		const known: Record<string, string[]> = {};
		const entries = readFileSync(
			join(import.meta.dirname, '../../../dsl-lib-task/src/generated/entries.tsx'),
			'utf8'
		);
		for (const m of entries.matchAll(/(\w+)Entry\.knownKeys = (\[[^\]]*\])/g))
			known[m[1]!] = JSON.parse(m[2]!) as string[];
		const problems: string[] = [];
		for (const [name, view] of designs) {
			for (const node of nodesOf(view)) {
				const type = String(node.$type);
				if (!type.startsWith('task:')) continue;
				const keys = known[type.slice(5)];
				if (!keys) continue;
				for (const key of Object.keys(node)) {
					if (!['$type', '$if'].includes(key) && !keys.includes(key))
						problems.push(`${name}: ${type} has no prop "${key}"`);
				}
			}
		}
		expect(problems).toEqual([]);
	});
});

describe('the generator reports what is wrong, with the fix', () => {
	const scratchDirs: string[] = [];
	afterAll(() => scratchDirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));
	function scratch(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), 'task-variants-'));
		scratchDirs.push(dir);
		mkdirSync(join(dir, 'variants'));
		const base: Record<string, string> = {
			'_page.yaml':
				'$sources: {}\n$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a] }\n',
			'_shared.yaml': 'x: { $type: Badge, label: x }\n',
			'a.yaml': 'label: A\nhint: h\nview: { $use: x }\n',
			...files,
		};
		for (const [name, text] of Object.entries(base)) writeFileSync(join(dir, 'variants', name), text);
		return dir;
	}

	it('expands $use, keeps the verbatim head, and draws nothing until the task is loaded', () => {
		const out = generateTaskPage(scratch({}));
		expect(out).toContain('$sources: {}');
		expect(parse(out).sections).toEqual([
			{
				$type: 'AbTest',
				id: 't',
				label: 'T',
				initial: 'a',
				variants: {
					a: {
						label: 'A',
						hint: 'h',
						view: {
							$type: 'VerticalStack',
							$if: '$sources.detail.task',
							gap: 'gap-0',
							items: [{ $type: 'Badge', label: 'x' }],
						},
					},
				},
			},
		]);
	});

	it('expands a $use that is a list or an object inside a props, not only a node', () => {
		const out = parse(
			generateTaskPage(
				scratch({
					'_shared.yaml':
						'x: { $type: Badge, label: x }\nlist:\n  - { $type: Badge, label: l1 }\np: { id: 1 }\n',
					'a.yaml': 'label: A\nhint: h\nview: { $type: Y, params: { $use: p }, items: { $use: list } }\n',
				})
			)
		);
		const view = ((out.sections as Node[])[0]!.variants as Record<string, Fragment>).a!.view as Node;
		const inner = (view.items as Node[])[0]!;
		expect(inner.params).toEqual({ id: 1 });
		expect(inner.items).toEqual([{ $type: 'Badge', label: 'l1' }]);
	});

	it('puts the experiment in the `items` of $wrap and merges $page into the PageContent', () => {
		const out = parse(
			generateTaskPage(
				scratch({
					'_page.yaml':
						'$type: PageContent\n$page: { maxWidth: full }\n$wrap: { $type: task:WidthFrame }\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a] }\n',
				})
			)
		);
		expect(out.maxWidth).toBe('full');
		const [wrapper] = out.sections as Node[];
		expect(wrapper).toMatchObject({ $type: 'task:WidthFrame' });
		expect((wrapper!.items as Node[]).map(n => n.$type)).toEqual(['AbTest']);
	});

	it.each([
		[
			'an unknown $use',
			{ 'a.yaml': 'label: A\nhint: h\nview: { $use: nope }\n' },
			/unknown \$use "nope".*Shared fragments: x/s,
		],
		[
			'a $use cycle',
			{ '_shared.yaml': 'x: { $use: y }\ny: { $use: x }\n', 'a.yaml': 'label: A\nhint: h\nview: { $use: x }\n' },
			/cycle x -> y -> x/,
		],
		['a $use with other keys', { 'a.yaml': 'label: A\nhint: h\nview: { $use: x, label: z }\n' }, /no other key/],
		['a fragment without hint', { 'a.yaml': 'label: A\nview: { $type: Badge }\n' }, /missing: hint/],
		[
			'a missing design file',
			{
				'_page.yaml':
					'$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a, b] }\n',
			},
			/b\.yaml.*is missing/s,
		],
		[
			'a duplicate design',
			{
				'_page.yaml':
					'$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a, a] }\n',
			},
			/listed twice/,
		],
		['an unlisted fragment file', { 'zzz.yaml': 'label: Z\nhint: h\nview: {}\n' }, /zzz\.yaml.*not listed/s],
		[
			'an initial that is not a design',
			{
				'_page.yaml':
					'$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: q, variants: [a] }\n',
			},
			/initial "q"/,
		],
	])('%s', (_label, files, message) => {
		expect(() => generateTaskPage(scratch(files))).toThrow(message);
	});

	it('every error tells where to read how a design is added', () => {
		expect(() => generateTaskPage(scratch({ 'a.yaml': 'label: A\n' }))).toThrow(/_page\.yaml/);
	});

	it('the real folder lists exactly the fragment files it contains', () => {
		const files = readdirSync(join(DEFAULT_VIEWS_DIR, 'variants')).filter(f => f.endsWith('.yaml'));
		expect(files.sort()).toEqual(['_page.yaml', '_shared.yaml', ...designNames.map(n => `${n}.yaml`)].sort());
		expect(viewsDir).toContain('dsl-views');
	});
});
