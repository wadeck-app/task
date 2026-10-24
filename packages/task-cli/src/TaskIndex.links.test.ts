import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTaskCommand } from './TaskIndex.js';
import { registerTestProject } from './testHelpers.js';

interface Created {
	id: string;
	links?: Array<{ type: string; target: string }>;
}
interface Summary {
	id: string;
	title: string;
	status: string;
}
type LinksView = Record<'blockedBy' | 'blocks' | 'duplicateOf' | 'duplicates' | 'causedBy' | 'causes', Summary[]>;

let tmpDir: string;

async function newTask(title: string): Promise<Created> {
	const result = await runTaskCommand(['new', title], tmpDir);
	expect(result.exitCode, result.output).toBe(0);
	return JSON.parse(result.output) as Created;
}

async function show(id: string): Promise<Created> {
	return JSON.parse((await runTaskCommand(['show', id], tmpDir)).output) as Created;
}

async function linksOf(id: string): Promise<LinksView> {
	const result = await runTaskCommand(['links', id], tmpDir);
	expect(result.exitCode, result.output).toBe(0);
	return JSON.parse(result.output) as LinksView;
}

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-links-cli-test-'));
	await registerTestProject(tmpDir);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runTaskCommand — link', () => {
	it.each(['blockedBy', 'duplicateOf', 'causedBy'])(
		'adds a %s link and returns the updated source task',
		async type => {
			const a = await newTask('a');
			const b = await newTask('b');
			const result = await runTaskCommand(['link', a.id, type, b.id], tmpDir);
			expect(result.exitCode, result.output).toBe(0);
			const updated = JSON.parse(result.output) as Created;
			expect(updated.id).toBe(a.id);
			expect(updated.links).toEqual([{ type, target: b.id }]);
		}
	);

	it('accepts id prefixes for both tasks and stores full ids', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		const result = await runTaskCommand(['link', a.id.slice(0, 4), 'blockedBy', b.id.slice(0, 4)], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect((JSON.parse(result.output) as Created).links).toEqual([{ type: 'blockedBy', target: b.id }]);
	});

	it.each([
		['blocks', 'blockedBy'],
		['duplicates', 'duplicateOf'],
		['causes', 'causedBy'],
	])('accepts the inverse spelling "%s": "A %s B" stores "B %s A" and returns B', async (inverse, stored) => {
		const a = await newTask('a');
		const b = await newTask('b');
		const result = await runTaskCommand(['link', a.id, inverse, b.id], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		const updated = JSON.parse(result.output) as Created;
		expect(updated.id).toBe(b.id);
		expect(updated.links).toEqual([{ type: stored, target: a.id }]);
		expect((await show(a.id)).links).toBeUndefined();
	});

	it('fails with usage when arguments are missing', async () => {
		const result = await runTaskCommand(['link', 'abc', 'blockedBy'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Usage: task link <id> <type> <target-id>');
	});

	it('rejects an unknown type, lists the valid ones and suggests the closest', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		const result = await runTaskCommand(['link', a.id, 'blockedby', b.id], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('unknown link type "blockedby"');
		expect(result.output).toContain('blockedBy, duplicateOf, causedBy, blocks, duplicates, causes');
		expect(result.output).toContain('Did you mean: blockedBy?');
	});

	it('fails when a task does not exist', async () => {
		const a = await newTask('a');
		const unknownTarget = await runTaskCommand(['link', a.id, 'blockedBy', 'zzzzzz'], tmpDir);
		expect(unknownTarget.exitCode).toBe(1);
		expect(unknownTarget.output).toContain('not found');
		const unknownSource = await runTaskCommand(['link', 'zzzzzz', 'blockedBy', a.id], tmpDir);
		expect(unknownSource.exitCode).toBe(1);
		expect(unknownSource.output).toContain('not found');
	});

	it('rejects self-links', async () => {
		const a = await newTask('a');
		const result = await runTaskCommand(['link', a.id, 'blockedBy', a.id], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('itself');
	});

	it('rejects an exact duplicate link and a second duplicateOf target', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		const c = await newTask('c');
		await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		const again = await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		expect(again.exitCode).toBe(1);
		expect(again.output).toContain('already blockedBy');
		await runTaskCommand(['link', a.id, 'duplicateOf', b.id], tmpDir);
		const second = await runTaskCommand(['link', a.id, 'duplicateOf', c.id], tmpDir);
		expect(second.exitCode).toBe(1);
		expect(second.output).toContain('task unlink');
	});

	it('--json mode returns a JSON error', async () => {
		const a = await newTask('a');
		const result = await runTaskCommand(['--json', 'link', a.id, 'blockedBy', a.id], tmpDir);
		expect(result.exitCode).toBe(1);
		expect((JSON.parse(result.output) as { error: string }).error).toContain('itself');
	});
});

describe.each(['blockedBy', 'duplicateOf', 'causedBy'])('runTaskCommand — %s cycles over the full graph', type => {
	it('A => B => C then C => A fails, leaves C untouched, and names the cycle', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		const c = await newTask('c');
		expect((await runTaskCommand(['link', a.id, type, b.id], tmpDir)).exitCode).toBe(0);
		expect((await runTaskCommand(['link', b.id, type, c.id], tmpDir)).exitCode).toBe(0);

		const result = await runTaskCommand(['link', c.id, type, a.id], tmpDir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('cycle');
		expect(result.output).toContain(`${c.id} → ${a.id} → ${b.id} → ${c.id}`);
		expect((await show(c.id)).links).toBeUndefined();
	});

	it('is also detected through id prefixes', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		const c = await newTask('c');
		await runTaskCommand(['link', a.id, type, b.id], tmpDir);
		await runTaskCommand(['link', b.id, type, c.id], tmpDir);
		const result = await runTaskCommand(['link', c.id.slice(0, 4), type, a.id.slice(0, 4)], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('cycle');
	});
});

describe('runTaskCommand — cycles are detected across both spellings', () => {
	it('builds a chain with inverse spellings, then rejects closing it either way', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		const c = await newTask('c');
		// "B blocks A" => A blockedBy B ; "C blocks B" => B blockedBy C ; chain: A => B => C
		expect((await runTaskCommand(['link', b.id, 'blocks', a.id], tmpDir)).exitCode).toBe(0);
		expect((await runTaskCommand(['link', c.id, 'blocks', b.id], tmpDir)).exitCode).toBe(0);

		const direct = await runTaskCommand(['link', c.id, 'blockedBy', a.id], tmpDir);
		expect(direct.exitCode).toBe(1);
		expect(direct.output).toContain('cycle');

		// "A blocks C" => C blockedBy A: the same closing edge, written the other way round.
		const inverse = await runTaskCommand(['link', a.id, 'blocks', c.id], tmpDir);
		expect(inverse.exitCode).toBe(1);
		expect(inverse.output).toContain('cycle');
	});

	it('does not mix graphs of different link types', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		expect((await runTaskCommand(['link', b.id, 'causedBy', a.id], tmpDir)).exitCode).toBe(0);
		expect((await runTaskCommand(['link', b.id, 'blockedBy', a.id], tmpDir)).exitCode).toBe(1);
	});
});

describe('runTaskCommand — unlink', () => {
	it('removes a link, and the same link can then be added in the reverse direction', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		const result = await runTaskCommand(['unlink', a.id, 'blockedBy', b.id], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect((JSON.parse(result.output) as Created).links).toBeUndefined();
		expect((await runTaskCommand(['link', b.id, 'blockedBy', a.id], tmpDir)).exitCode).toBe(0);
	});

	it('accepts the inverse spelling', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		const result = await runTaskCommand(['unlink', b.id, 'blocks', a.id], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect((await show(a.id)).links).toBeUndefined();
	});

	it('fails with a clear message when the link does not exist', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		const result = await runTaskCommand(['unlink', a.id, 'blockedBy', b.id], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('is not blockedBy');
	});

	it('fails with usage when arguments are missing', async () => {
		const result = await runTaskCommand(['unlink', 'abc'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Usage: task unlink <id> <type> <target-id>');
	});
});

describe('runTaskCommand — links', () => {
	it('shows outgoing links and derived inverses with summaries', async () => {
		const a = await newTask('task a');
		const b = await newTask('task b');
		const c = await newTask('task c');
		const d = await newTask('task d');
		await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		await runTaskCommand(['link', c.id, 'blockedBy', a.id], tmpDir);
		await runTaskCommand(['link', a.id, 'duplicateOf', d.id], tmpDir);
		await runTaskCommand(['link', c.id, 'causedBy', a.id], tmpDir);

		const view = await linksOf(a.id.slice(0, 4));

		expect(view.blockedBy).toEqual([expect.objectContaining({ id: b.id, title: 'task b', status: 'backlog' })]);
		expect(view.blocks.map(t => t.id)).toEqual([c.id]);
		expect(view.duplicateOf.map(t => t.id)).toEqual([d.id]);
		expect(view.duplicates).toEqual([]);
		expect(view.causedBy).toEqual([]);
		expect(view.causes.map(t => t.id)).toEqual([c.id]);
	});

	it('returns the six keys, all empty, for an unlinked task', async () => {
		const a = await newTask('a');
		expect(await linksOf(a.id)).toEqual({
			blockedBy: [],
			blocks: [],
			duplicateOf: [],
			duplicates: [],
			causedBy: [],
			causes: [],
		});
	});

	it('fails with usage when the id is missing, and when the task does not exist', async () => {
		const missing = await runTaskCommand(['links'], tmpDir);
		expect(missing.exitCode).toBe(1);
		expect(missing.output).toContain('Usage: task links <id>');
		const unknown = await runTaskCommand(['links', 'zzzzzz'], tmpDir);
		expect(unknown.exitCode).toBe(1);
		expect(unknown.output).toContain('not found');
	});
});

describe('runTaskCommand — links in show and list', () => {
	it('show returns the outgoing links of the record', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		expect((await show(a.id)).links).toEqual([{ type: 'blockedBy', target: b.id }]);
	});

	it('list entries carry links only for tasks that have some', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		const list = JSON.parse((await runTaskCommand(['list'], tmpDir)).output) as Created[];
		expect(list.find(t => t.id === a.id)!.links).toEqual([{ type: 'blockedBy', target: b.id }]);
		expect(list.find(t => t.id === b.id)!.links).toBeUndefined();
	});
});

describe('runTaskCommand — delete and links', () => {
	it('removes links pointing to deleted tasks and tells the user', async () => {
		const a = await newTask('a');
		const gone = await newTask('gone');
		const result = await runTaskCommand(['link', a.id, 'blockedBy', gone.id], tmpDir);
		expect(result.exitCode, result.output).toBe(0);

		const deleted = await runTaskCommand(['delete', gone.id], tmpDir);

		expect(deleted.exitCode, deleted.output).toBe(0);
		expect(deleted.output).toContain('Deleted 1 task(s)');
		expect(deleted.output).toContain('1 link(s) pointing to deleted tasks were removed');
		expect((await show(a.id)).links).toBeUndefined();
	});

	it('does not mention links when everything linked is deleted together', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		const result = await runTaskCommand(['delete', '--all'], tmpDir);
		expect(result.output).toContain('Deleted 2 task(s)');
		expect(result.output).not.toContain('link(s)');
	});

	it('--dry-run warns about the links that would be removed and deletes nothing', async () => {
		const a = await newTask('a');
		const gone = await newTask('gone');
		await runTaskCommand(['link', a.id, 'blockedBy', gone.id], tmpDir);
		const result = await runTaskCommand(['delete', '--dry-run', gone.id], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('1 link(s) pointing to deleted tasks would be removed');
		expect((await show(a.id)).links).toHaveLength(1);
	});
});

describe('runTaskCommand — help', () => {
	it('documents the link commands and types', async () => {
		const result = await runTaskCommand(['--help'], tmpDir);
		for (const snippet of ['task link', 'task unlink', 'task links', 'blockedBy', 'duplicateOf', 'causedBy']) {
			expect(result.output, snippet).toContain(snippet);
		}
	});

	it('lists the link commands among the valid commands on an unknown command', async () => {
		const result = await runTaskCommand(['nope'], tmpDir);
		expect(result.output).toContain('link, unlink, links');
	});
});
