import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { queueEventDeclarationsHash } from '@wadeck-app/task-service';
import type { DeclareEventsOutcome, EventSink, TaskEvent } from '@wadeck-app/task-service';

import {
	declareBeforeFirstDelivery,
	declareOnce,
	queueEventsMarkerPath,
	runDeclareEvents,
} from './QueueEventsDeclaration.js';

const REGISTERED: DeclareEventsOutcome = { status: 'registered', count: 5 };

const EVENT: TaskEvent = {
	name: 'onTaskLinked',
	payload: { taskId: 'a', linkType: 'blockedBy', targetId: 'b', taskProjectName: 'p', taskProjectPath: '/p' },
};

/** Plain functions, not vi.fn(): the config's mockReset would wipe an implementation set at creation. */
function fakeSink(answer: () => Promise<DeclareEventsOutcome> | DeclareEventsOutcome = () => REGISTERED) {
	const order: string[] = [];
	let declared = 0;
	let flushed = 0;
	const sink: EventSink & { declareEvents(): Promise<DeclareEventsOutcome> } = {
		declareEvents() {
			declared++;
			order.push('declare');
			return Promise.resolve(answer());
		},
		deliver() {
			order.push('deliver');
			return Promise.resolve({ delivered: true });
		},
		flush() {
			flushed++;
			return Promise.resolve();
		},
	};
	return { sink, order, declared: () => declared, flushed: () => flushed };
}

describe('queue events declaration in the CLI', () => {
	let configDir: string;
	let stderr: string[];

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-declare-'));
		stderr = [];
	});
	afterEach(() => fs.rmSync(configDir, { recursive: true, force: true }));

	const options = () => ({
		configDir,
		taskVersion: '2026.10.24-TEST',
		writeStderr: (text: string) => stderr.push(text),
	});
	const readMarker = () =>
		JSON.parse(fs.readFileSync(queueEventsMarkerPath(configDir), 'utf8')) as Record<string, unknown>;
	const logText = (): string => {
		const dir = path.join(configDir, 'logs');
		if (!fs.existsSync(dir)) return '';
		return fs
			.readdirSync(dir)
			.map(file => fs.readFileSync(path.join(dir, file), 'utf8'))
			.join('');
	};

	it('keeps the marker in the task config dir as queue-events.json', () => {
		expect(queueEventsMarkerPath(configDir)).toBe(path.join(configDir, 'queue-events.json'));
	});

	describe('declareOnce', () => {
		it('declares when there is no marker, then writes it with the hash, the CLI version and the time', async () => {
			const fake = fakeSink();

			const result = await declareOnce(fake.sink, options());

			expect(result).toEqual(REGISTERED);
			expect(fake.declared()).toBe(1);
			const marker = readMarker();
			expect(marker['hash']).toBe(queueEventDeclarationsHash());
			expect(marker['taskVersion']).toBe('2026.10.24-TEST');
			expect(new Date(marker['declaredAt'] as string).toISOString()).toBe(marker['declaredAt']);
		});

		it('does not declare a second time while the marker holds the same hash', async () => {
			const fake = fakeSink();
			await declareOnce(fake.sink, options());

			const second = await declareOnce(fake.sink, { ...options(), taskVersion: 'another-version' });

			expect(second).toBe('up-to-date');
			expect(fake.declared()).toBe(1);
		});

		it('declares again when the declaration changed (another hash in the marker) and rewrites the marker', async () => {
			fs.writeFileSync(
				queueEventsMarkerPath(configDir),
				JSON.stringify({
					hash: 'an-older-declaration',
					taskVersion: 'old',
					declaredAt: '2020-01-01T00:00:00.000Z',
				})
			);
			const fake = fakeSink();

			await declareOnce(fake.sink, options());

			expect(fake.declared()).toBe(1);
			expect(readMarker()['hash']).toBe(queueEventDeclarationsHash());
		});

		it.each(['rejected', 'unsupported', 'dropped', 'unknown'] as const)(
			'writes no marker after %s, so the next process tries again',
			async status => {
				const failing: DeclareEventsOutcome =
					status === 'rejected' ? { status, reason: 'r', problems: [] } : { status, reason: 'r' };
				const fake = fakeSink(() => failing);

				const result = await declareOnce(fake.sink, options());

				expect(result).toEqual(failing);
				expect(fs.existsSync(queueEventsMarkerPath(configDir))).toBe(false);
				await declareOnce(fake.sink, options());
				expect(fake.declared()).toBe(2);
			}
		);

		it('declares again, saying why, when the marker is corrupt, and replaces it', async () => {
			fs.writeFileSync(queueEventsMarkerPath(configDir), '{not json');
			const fake = fakeSink();

			await declareOnce(fake.sink, options());

			expect(fake.declared()).toBe(1);
			expect(readMarker()['hash']).toBe(queueEventDeclarationsHash());
			expect(logText()).toContain('queue-events.json');
		});

		it('declares again when the marker has the wrong shape (no hash)', async () => {
			fs.writeFileSync(queueEventsMarkerPath(configDir), JSON.stringify({ taskVersion: 'x' }));
			const fake = fakeSink();

			await declareOnce(fake.sink, options());

			expect(fake.declared()).toBe(1);
		});

		it('says so on stderr, without throwing, when the marker cannot be written (declared again next time)', async () => {
			// A directory where the file must go.
			fs.mkdirSync(queueEventsMarkerPath(configDir));
			const fake = fakeSink();

			const result = await declareOnce(fake.sink, options());

			expect(result).toEqual(REGISTERED);
			expect(stderr.join('')).toContain('queue-events.json');
			expect(stderr.join('')).toContain('declared again');
		});

		it('creates the config dir when it does not exist yet', async () => {
			const nested = path.join(configDir, 'does', 'not', 'exist');
			const fake = fakeSink();

			await declareOnce(fake.sink, { ...options(), configDir: nested });

			expect(fs.existsSync(queueEventsMarkerPath(nested))).toBe(true);
		});

		it('never throws: a sink whose declareEvents rejects counts as an unknown outcome and writes no marker', async () => {
			const broken = fakeSink();
			broken.sink.declareEvents = () => Promise.reject(new Error('sink exploded'));

			const result = await declareOnce(broken.sink, options());

			expect(result).toMatchObject({ status: 'unknown' });
			expect(JSON.stringify(result)).toContain('sink exploded');
			expect(fs.existsSync(queueEventsMarkerPath(configDir))).toBe(false);
		});
	});

	describe('declareBeforeFirstDelivery', () => {
		it('declares before the first event is delivered, and only once for a process delivering several', async () => {
			const fake = fakeSink();
			const sink = declareBeforeFirstDelivery(fake.sink, options());

			await sink.deliver(EVENT);
			await sink.deliver(EVENT);

			expect(fake.order).toEqual(['declare', 'deliver', 'deliver']);
		});

		it('declares nothing for a command that delivers no event', async () => {
			const fake = fakeSink();
			const sink = declareBeforeFirstDelivery(fake.sink, options());

			await sink.flush?.();

			expect(fake.declared()).toBe(0);
			expect(fs.existsSync(queueEventsMarkerPath(configDir))).toBe(false);
		});

		it('does not declare again in the next process once the marker exists', async () => {
			const first = fakeSink();
			await declareBeforeFirstDelivery(first.sink, options()).deliver(EVENT);
			const second = fakeSink();

			await declareBeforeFirstDelivery(second.sink, options()).deliver(EVENT);

			expect(first.declared()).toBe(1);
			expect(second.declared()).toBe(0);
			expect(second.order).toEqual(['deliver']);
		});

		it('still delivers the event, and tries again in the next process, when the declaration failed', async () => {
			const fake = fakeSink(() => ({ status: 'dropped', reason: 'queue down' }));

			const delivery = await declareBeforeFirstDelivery(fake.sink, options()).deliver(EVENT);

			expect(delivery).toEqual({ delivered: true });
			expect(fs.existsSync(queueEventsMarkerPath(configDir))).toBe(false);
		});

		it('still delivers the event when the declaration rejects', async () => {
			const broken = fakeSink();
			broken.sink.declareEvents = () => Promise.reject(new Error('sink exploded'));

			const delivery = await declareBeforeFirstDelivery(broken.sink, options()).deliver(EVENT);

			expect(delivery).toEqual({ delivered: true });
		});

		it('passes flush through to the sink', async () => {
			const fake = fakeSink();

			await declareBeforeFirstDelivery(fake.sink, options()).flush?.();

			expect(fake.flushed()).toBe(1);
		});
	});

	describe('runDeclareEvents (task cli declare-events: forced, whatever the marker says)', () => {
		it('declares even when the marker is up to date, rewrites it, and says how many events', async () => {
			const fake = fakeSink();
			await declareOnce(fake.sink, options());

			const result = await runDeclareEvents(fake.sink, false, options());

			expect(fake.declared()).toBe(2);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('5 events');
			expect(readMarker()['hash']).toBe(queueEventDeclarationsHash());
		});

		it('prints the JSON status in --json mode', async () => {
			const result = await runDeclareEvents(fakeSink().sink, true, options());

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ status: 'registered', count: 5 });
		});

		it('exits 1 with an actionable message when the queue is too old', async () => {
			const fake = fakeSink(() => ({ status: 'unsupported', reason: 'daemon speaks 1.0.0' }));

			const result = await runDeclareEvents(fake.sink, false, options());

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('daemon speaks 1.0.0');
			expect(result.output).toMatch(/queue-cli/);
			expect(fs.existsSync(queueEventsMarkerPath(configDir))).toBe(false);
		});

		it('exits 1 naming the problem paths when the queue refuses the declaration', async () => {
			const fake = fakeSink(() => ({
				status: 'rejected',
				reason: 'r',
				problems: [{ path: 'events[1].name', message: 'bad' }],
			}));

			const text = await runDeclareEvents(fake.sink, false, options());
			const json = await runDeclareEvents(fake.sink, true, options());

			expect(text.exitCode).toBe(1);
			expect(text.output).toContain('events[1].name');
			expect(json.exitCode).toBe(1);
			expect(JSON.parse(json.output)).toMatchObject({
				status: 'rejected',
				problems: [{ path: 'events[1].name' }],
			});
		});

		it.each(['dropped', 'unknown'] as const)('exits 1 with the reason for %s', async status => {
			const fake = fakeSink(() => ({ status, reason: 'because' }));

			const result = await runDeclareEvents(fake.sink, false, options());

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('because');
		});
	});
});
