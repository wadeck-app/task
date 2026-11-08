// The contexts a request opens are released when the request ends (stage 1 of the storage design): a strategy may hold a
// connection or a cache (the github one), and a module serving many requests must not leak them. Every context opened while a
// request runs is remembered by its request (AsyncLocalStorage: two requests at once never see each other's), then disposed
// once, whether the handler answered or failed. What the reads want the user to know (data served from the cache after a
// failure) is collected from the same contexts just before.
import { AsyncLocalStorage } from 'node:async_hooks';

import type { ReadNotice, TaskServiceContext } from '@wadeck-app/task-service';

const opened = new AsyncLocalStorage<Set<TaskServiceContext>>();

/** Remembers `ctx` for the request that is running (nothing when called outside one: the caller releases it itself). */
export function trackContext<T extends TaskServiceContext>(ctx: T): T {
	opened.getStore()?.add(ctx);
	return ctx;
}

/**
 * Runs `run` as one request. The result carries the notices of the reads. Contexts are disposed in the order they were opened;
 * a dispose that fails is reported through `report` (never silent) and does not change the answer.
 */
export async function runInRequestScope<T>(
	run: () => T | Promise<T>,
	report: (message: string) => void
): Promise<{ value: T; notices: ReadNotice[] }> {
	const contexts = new Set<TaskServiceContext>();
	let notices: ReadNotice[] = [];
	try {
		const value = await opened.run(contexts, run);
		notices = [...contexts].flatMap(ctx => ctx.takeNotices?.() ?? []);
		return { value, notices };
	} finally {
		await releaseAll(contexts, report);
	}
}

/** Disposes contexts one after the other; the reason of a failure goes to `report`. */
export async function releaseAll(
	contexts: Iterable<TaskServiceContext>,
	report: (message: string) => void
): Promise<void> {
	for (const ctx of contexts) {
		try {
			await ctx.dispose?.();
		} catch (error) {
			report(
				`could not release the storage of project ${ctx.project.name}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}
