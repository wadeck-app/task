import type { TaskServiceContext } from './context.js';

/**
 * Runs `read` on a context whose reads all come from the system itself (the `freshReads` of the strategy context, the mechanism
 * `task migrate` uses), for this call only: the context given is untouched. Only github and gitlab keep a read cache. The local
 * backend reads its own files and the remote backend asks the server on every read (the client keeps no cache), so for those two
 * `fresh` changes nothing and `read` runs on the context as it is.
 */
export async function withFreshReads<T>(
	ctx: TaskServiceContext,
	fresh: boolean | undefined,
	read: (ctx: TaskServiceContext) => Promise<T>
): Promise<T> {
	if (fresh !== true || ctx.store.kind === 'local' || ctx.store.kind === 'remote') return read(ctx);
	if (ctx.openFresh === undefined) {
		throw new Error(
			`fresh reads were asked for on a ${ctx.store.kind} project, but this context cannot reopen the project without its cache (it was not built by openTaskContext)`
		);
	}
	const freshCtx = ctx.openFresh();
	try {
		return await read(freshCtx);
	} finally {
		await freshCtx.dispose?.();
	}
}
