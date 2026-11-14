import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectWriteLock, WriteLockTimeoutError } from './projectLock';

describe('ProjectWriteLock', () => {
	let root: string;
	let lockPath: string;
	let clock: number;
	let warnings: string[];

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-write-lock-'));
		lockPath = path.join(root, 'data', '.write-lock');
		clock = Date.parse('2026-11-14T10:00:00.000Z');
		warnings = [];
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	// A fake clock: sleeping advances it, so no test waits for real.
	const lock = (extra: Partial<ConstructorParameters<typeof ProjectWriteLock>[1]> = {}) =>
		new ProjectWriteLock(lockPath, {
			timeoutMs: 1000,
			now: () => clock,
			sleep: ms => {
				clock += ms;
			},
			pid: 4242,
			hostname: 'host-a',
			isProcessAlive: () => true,
			onWarning: message => warnings.push(message),
			...extra,
		});

	const plantLock = (holder: { pid: number; host: string; at: string }) => {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, JSON.stringify({ ...holder, token: 'planted' }));
	};

	it('creates the lock for the duration of the operation and removes it afterwards', () => {
		let during: { pid: number; host: string; at: string } | undefined;
		const result = lock().run(() => {
			during = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; host: string; at: string };
			return 'done';
		});
		expect(result).toBe('done');
		expect(during).toMatchObject({ pid: 4242, host: 'host-a', at: '2026-11-14T10:00:00.000Z' });
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it('releases the lock when the operation throws, and rethrows the original error', () => {
		expect(() =>
			lock().run(() => {
				throw new Error('boom');
			})
		).toThrow('boom');
		expect(fs.existsSync(lockPath)).toBe(false);
		// And it can be taken again at once.
		expect(lock().run(() => 1)).toBe(1);
	});

	it('is reentrant: a nested run on the same lock takes it once and does not deadlock', () => {
		const sleeps: number[] = [];
		const l = lock({ sleep: ms => sleeps.push(ms) });
		const result = l.run(() => l.run(() => 'inner'));
		expect(result).toBe('inner');
		expect(sleeps).toEqual([]);
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it('keeps the lock until the outermost run ends', () => {
		const l = lock();
		l.run(() => {
			l.run(() => undefined);
			expect(fs.existsSync(lockPath)).toBe(true);
		});
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it('a second holder waits, then proceeds once the first has released', () => {
		plantLock({ pid: 7, host: 'host-a', at: '2026-11-14T09:59:59.000Z' });
		let sleeps = 0;
		const second = lock({
			sleep: ms => {
				clock += ms;
				sleeps++;
				// The first holder finishes during the second wait.
				if (sleeps === 2) fs.rmSync(lockPath);
			},
		});
		expect(second.run(() => 'proceeded')).toBe('proceeded');
		expect(sleeps).toBe(2);
		expect(warnings).toEqual([]);
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it('backs off between polls and never sleeps past the timeout', () => {
		plantLock({ pid: 7, host: 'host-a', at: '2026-11-14T09:59:59.000Z' });
		const slept: number[] = [];
		const l = lock({
			timeoutMs: 500,
			sleep: ms => {
				slept.push(ms);
				clock += ms;
			},
		});
		expect(() => l.run(() => 1)).toThrow(WriteLockTimeoutError);
		expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(500);
		expect(slept.length).toBeGreaterThan(2);
		expect(slept[1]!).toBeGreaterThanOrEqual(slept[0]!);
	});

	it('times out with a message naming the holder pid and host, how long it held the lock and what to do', () => {
		plantLock({ pid: 7, host: 'host-a', at: '2026-11-14T09:59:30.000Z' });
		let caught: unknown;
		try {
			lock({ timeoutMs: 200 }).run(() => 1);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WriteLockTimeoutError);
		const error = caught as WriteLockTimeoutError;
		expect(error.holder).toMatchObject({ pid: 7, host: 'host-a' });
		expect(error.message).toContain('pid 7');
		expect(error.message).toContain('host-a');
		expect(error.message).toContain('30s');
		expect(error.message).toContain('waited');
		expect(error.hint).toContain(lockPath);
		expect(error.hint).toContain('delete');
		// Nothing of the other holder was touched.
		expect(fs.existsSync(lockPath)).toBe(true);
	});

	it('a lock of another host is never judged stale, whatever its pid', () => {
		plantLock({ pid: 7, host: 'host-b', at: '2026-11-14T09:00:00.000Z' });
		const l = lock({ timeoutMs: 100, isProcessAlive: () => false });
		expect(() => l.run(() => 1)).toThrow(/host-b/);
		expect(warnings).toEqual([]);
	});

	it('takes over a lock whose process is dead on this host, with a warning', () => {
		plantLock({ pid: 7, host: 'host-a', at: '2026-11-14T09:00:00.000Z' });
		const l = lock({ isProcessAlive: pid => pid !== 7 });
		expect(l.run(() => 'taken')).toBe('taken');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('pid 7');
		expect(warnings[0]).toContain('host-a');
		expect(warnings[0]).toContain('not running');
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it('never removes a live lock another contender created between the stale read and the takeover', () => {
		plantLock({ pid: 7, host: 'host-a', at: '2026-11-14T09:00:00.000Z' });
		let replaced = false;
		const l = lock({
			timeoutMs: 100,
			isProcessAlive: pid => pid !== 7,
			afterStaleRead: () => {
				if (replaced) return;
				replaced = true;
				// Another contender took over and now holds a live lock.
				fs.writeFileSync(lockPath, JSON.stringify({ pid: 9, host: 'host-a', at: 'x', token: 'live' }));
			},
		});
		expect(() => l.run(() => 1)).toThrow(WriteLockTimeoutError);
		expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({ token: 'live' });
		expect(warnings).toEqual([]);
		expect(fs.existsSync(`${lockPath}.takeover`)).toBe(false);
	});

	it('two contenders taking over the same dead lock: exactly one takes it, and they never overlap', () => {
		plantLock({ pid: 7, host: 'host-a', at: '2026-11-14T09:00:00.000Z' });
		let inside = 0;
		let maxInside = 0;
		const work = () => {
			inside++;
			maxInside = Math.max(maxInside, inside);
			inside--;
		};
		const a = lock({ pid: 1111, isProcessAlive: pid => pid !== 7 });
		let nested = false;
		const b = lock({
			pid: 2222,
			isProcessAlive: pid => pid !== 7,
			// Both judged the lock dead; A takes it over, works and releases before B starts its takeover.
			afterStaleRead: () => {
				if (nested) return;
				nested = true;
				a.run(work);
			},
		});
		b.run(work);
		expect(maxInside).toBe(1);
		// Only A's takeover removed the dead lock.
		expect(warnings.filter(w => w.includes('Took over'))).toHaveLength(1);
		expect(fs.existsSync(lockPath)).toBe(false);
		expect(fs.existsSync(`${lockPath}.takeover`)).toBe(false);
	});

	it('waits while another contender holds the takeover guard, and leaves the dead lock alone', () => {
		plantLock({ pid: 7, host: 'host-a', at: '2026-11-14T09:00:00.000Z' });
		fs.writeFileSync(
			`${lockPath}.takeover`,
			JSON.stringify({ pid: 5, host: 'host-a', at: new Date(clock).toISOString(), token: 'guard' })
		);
		const l = lock({ timeoutMs: 100, isProcessAlive: pid => pid !== 7 });
		expect(() => l.run(() => 1)).toThrow(WriteLockTimeoutError);
		expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({ token: 'planted' });
	});

	it('replaces a takeover guard left by a crash', () => {
		plantLock({ pid: 7, host: 'host-a', at: '2026-11-14T09:00:00.000Z' });
		fs.writeFileSync(
			`${lockPath}.takeover`,
			JSON.stringify({ pid: 5, host: 'host-a', at: '2026-11-14T09:00:00.000Z', token: 'guard' })
		);
		const l = lock({ isProcessAlive: pid => pid !== 7 });
		expect(l.run(() => 'taken')).toBe('taken');
		expect(fs.existsSync(`${lockPath}.takeover`)).toBe(false);
	});

	it('an unreadable lock file is waited for, never taken over, and the timeout names the file', () => {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, 'not json');
		let caught: unknown;
		try {
			lock({ timeoutMs: 100, isProcessAlive: () => false }).run(() => 1);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WriteLockTimeoutError);
		expect((caught as WriteLockTimeoutError).holder).toBeUndefined();
		expect((caught as Error).message).toContain('unreadable');
		expect(fs.readFileSync(lockPath, 'utf8')).toBe('not json');
	});

	it('does not remove a lock that is no longer its own and says so', () => {
		const l = lock();
		l.run(() => {
			fs.writeFileSync(lockPath, JSON.stringify({ pid: 9, host: 'host-a', at: 'x', token: 'someone-else' }));
		});
		expect(fs.existsSync(lockPath)).toBe(true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('no longer');
	});

	it('warns instead of failing when the lock file vanished during the operation', () => {
		const l = lock();
		expect(l.run(() => fs.rmSync(lockPath))).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('vanished');
	});

	it('the real sleep waits without spinning (a few milliseconds)', () => {
		plantLock({ pid: 7, host: 'host-a', at: '2026-11-14T09:59:59.000Z' });
		const started = Date.now();
		const l = new ProjectWriteLock(lockPath, {
			timeoutMs: 40,
			pollMs: 5,
			pid: 4242,
			hostname: 'host-a',
			isProcessAlive: () => true,
			onWarning: message => warnings.push(message),
		});
		expect(() => l.run(() => 1)).toThrow(WriteLockTimeoutError);
		expect(Date.now() - started).toBeGreaterThanOrEqual(30);
	});
});
