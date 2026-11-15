// Creates the instance of a resolved strategy: the one place that hands a plugin its transport and, for a meta-plugin, the strategies
// its options hold (`openStrategy`), and that releases what it opened when the instance is disposed. Used by the context of a project
// and by `task strategy check`, so both open a strategy the same way.
import * as path from 'node:path';

import { createInstance } from './plugin-host/index.js';
import type { OpenStrategyOptions, StrategyContext, StrategyInstance } from './plugins/kinds.js';
import { subStrategyViews } from './strategyResolve.js';
import type { ResolvedStrategy } from './strategyResolve.js';
import { transportOpener } from './strategyTransport.js';

/** What the host adds to a context: the transport and the sub-strategies. The caller gives the rest. */
export type BaseStrategyContext = Omit<StrategyContext, 'openTransport' | 'openStrategy' | 'subStrategies'>;

interface SubOpener {
	open: (slot: string, options?: OpenStrategyOptions) => Promise<StrategyInstance>;
	/** Disposes every instance opened, in the order they were opened; every one is tried, a failure is reported once all were. */
	disposeAll: () => Promise<void>;
}

/** The folder of a sub-strategy under the project data folder: relative, and never leaving it. */
function subDataDir(dataDir: string, subdir: string | undefined): string {
	if (subdir === undefined) return dataDir;
	const resolved = path.resolve(dataDir, subdir);
	const relative = path.relative(dataDir, resolved);
	if (
		subdir === '' ||
		path.isAbsolute(subdir) ||
		relative === '' ||
		relative.startsWith('..') ||
		path.isAbsolute(relative)
	) {
		throw new Error(
			`the data folder of a sub-strategy must be a folder inside the project data folder, found "${subdir}"`
		);
	}
	return resolved;
}

function subOpener(strategy: ResolvedStrategy, base: BaseStrategyContext): SubOpener | undefined {
	const subs = strategy.subs;
	if (subs === undefined) return undefined;
	const opened = new Map<string, Promise<StrategyInstance>>();
	const open = (slot: string, options: OpenStrategyOptions = {}): Promise<StrategyInstance> => {
		const sub = subs[slot];
		if (sub === undefined) {
			return Promise.reject(
				new Error(
					`strategy slot "${slot}" is not an option of this strategy that holds a strategy (available: ${Object.keys(subs).join(', ')})`
				)
			);
		}
		const key = `${slot}\u0000${options.dataSubdir ?? ''}`;
		const known = opened.get(key);
		if (known !== undefined) return known;
		const dataDir = subDataDir(base.dataDir, options.dataSubdir);
		const created = createStrategyInstance(sub, {
			...base,
			// The block as written under the slot, not the project's: its fidelity, fills and options.
			fidelity: sub.fidelity,
			fills: sub.fills,
			dataDir,
			tasksDir: path.join(dataDir, 'tasks'),
		});
		opened.set(key, created);
		return created;
	};
	const disposeAll = async (): Promise<void> => {
		const failures: string[] = [];
		for (const [key, pending] of opened) {
			const slot = key.split('\u0000')[0]!;
			try {
				await (await pending).dispose();
			} catch (error) {
				failures.push(
					`could not release the strategy "${slot}": ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
		if (failures.length > 0) throw new Error(failures.join('; '));
	};
	return { open, disposeAll };
}

/**
 * Creates the instance of `strategy` with its transport and, when its plugin holds strategies, `openStrategy`: each block is created
 * when first asked for and released with the instance (after it). A creation that fails releases what it had opened.
 */
export async function createStrategyInstance(
	strategy: ResolvedStrategy,
	base: BaseStrategyContext
): Promise<StrategyInstance> {
	const opener = transportOpener(strategy, base.env);
	const subs = subOpener(strategy, base);
	const views = subs === undefined ? undefined : subStrategyViews(strategy);
	let instance: StrategyInstance;
	try {
		instance = await createInstance(strategy, {
			...base,
			...(opener === undefined ? {} : { openTransport: opener }),
			...(subs === undefined || views === undefined ? {} : { openStrategy: subs.open, subStrategies: views }),
		});
	} catch (error) {
		if (subs !== undefined) await subs.disposeAll().catch(() => undefined);
		throw error;
	}
	if (subs === undefined) return instance;
	const own = instance.dispose.bind(instance);
	let disposal: Promise<void> | undefined;
	const releaseAll = async (): Promise<void> => {
		const errors: Error[] = [];
		for (const release of [own, subs.disposeAll]) {
			try {
				await release();
			} catch (error) {
				errors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
	};
	// Once, whatever the number of calls (the host disposes per command and at teardown).
	Object.defineProperty(instance, 'dispose', { value: () => (disposal ??= releaseAll()), configurable: true });
	return instance;
}
