import type { TaskServiceContext } from './context.js';
import { refuseTaskField } from './plugins/kinds.js';
import type { TaskFieldOperation } from './plugins/kinds.js';

/**
 * Refuses, before anything is read or written, an operation the project's backend does not carry (capability false or absent, or the
 * optional method missing): an UnsupportedByBackendError naming the storage strategy and what to use instead. The backends answer the
 * same when called directly; this keeps the use case from reading the task first (a forge read costs requests).
 */
export async function requireTaskField(
	ctx: TaskServiceContext,
	capability: 'priority' | 'assignee' | 'claim',
	operation: TaskFieldOperation
): Promise<void> {
	if (ctx.store.capabilities[capability] !== true || typeof ctx.store[operation] !== 'function') {
		await refuseTaskField(ctx.store.kind, operation);
	}
}
