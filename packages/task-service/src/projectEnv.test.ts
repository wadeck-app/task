import { projectEnv } from './context.js';
import { createTask } from './createTask.js';
import { deliverEvents } from './events.js';
import { checkAgainstSchema } from './jsonSchemaCheck.js';
import { queueEventDeclarations } from './queueEventDeclarations.js';
import { createTestContext } from './testHelpers.js';
import type { TestContext } from './testHelpers.js';

let test: TestContext;

beforeEach(() => {
	test = createTestContext();
});

afterEach(() => {
	test.cleanup();
});

describe('taskProjectId in the event payloads', () => {
	it('is added next to name and path when the project comes from the shared registry', () => {
		test.ctx.project = { id: 'a1b2c3d4', name: 'shop', path: test.rootDir };

		expect(projectEnv(test.ctx)).toEqual({
			taskProjectId: 'a1b2c3d4',
			taskProjectName: 'shop',
			taskProjectPath: test.rootDir,
		});
	});

	it('is absent (not undefined, not empty) for a legacy project', () => {
		const env = projectEnv(test.ctx);

		expect(Object.keys(env).sort()).toEqual(['taskProjectName', 'taskProjectPath']);
	});

	it('reaches the payload of a real operation, and fits the declared schema', () => {
		test.ctx.project = { id: 'a1b2c3d4', name: 'shop', path: test.rootDir };
		const declaration = queueEventDeclarations.find(entry => entry.name === 'onTaskCreated')!;

		const { events } = createTask(test.ctx, { description: 'x' });

		expect(events[0]!.payload).toMatchObject({ taskProjectId: 'a1b2c3d4' });
		expect(checkAgainstSchema(declaration.schema, JSON.parse(JSON.stringify(events[0]!.payload)))).toEqual([]);
	});

	it.each(queueEventDeclarations.map(entry => [entry.name, entry] as const))(
		'%s declares taskProjectId as an optional string and shows it in its example',
		(_name, declaration) => {
			const properties = declaration.schema['properties'] as Record<string, { type?: string }>;
			const required = declaration.schema['required'] as string[];

			expect(properties['taskProjectId']?.type).toBe('string');
			expect(required).not.toContain('taskProjectId');
			expect(declaration.example).toHaveProperty('taskProjectId');
			expect(checkAgainstSchema(declaration.schema, declaration.example)).toEqual([]);
		}
	);
});

describe('a virtual project (registered, no folder)', () => {
	it('has taskProjectId and taskProjectName and NO taskProjectPath key (never the current directory)', () => {
		test.ctx.project = { id: 'a1b2c3d4', name: 'notes' };

		const env = projectEnv(test.ctx);

		expect(env).toEqual({ taskProjectId: 'a1b2c3d4', taskProjectName: 'notes' });
		expect(Object.keys(env)).not.toContain('taskProjectPath');
	});

	it('the operation succeeds and its event carries no path, so the sink answers it undelivered with the virtual-project reason', async () => {
		test.ctx.project = { id: 'a1b2c3d4', name: 'notes' };

		const { task, events } = createTask(test.ctx, { description: 'in a virtual project' });

		expect(task.id).toBeTruthy();
		expect(events).toHaveLength(1);
		expect(Object.keys(events[0]!.payload)).not.toContain('taskProjectPath');
		const outcome = await deliverEvents(
			{ deliver: () => Promise.resolve({ delivered: false, reason: 'unused' }) },
			events
		);
		expect(outcome.delivered).toBe(0);
	});
});
