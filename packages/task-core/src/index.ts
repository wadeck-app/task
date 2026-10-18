// Public barrel for @wadeck-app/task-core.
// Exposes the symbols consumed across the package boundary by task-cli.
export type {
	TaskHookValue,
	TaskStatusEntry,
	TaskGlobalConfig,
	TaskProjectConfig,
	TaskResolvedConfig,
} from './TaskConfigLoader.js';
export { TaskConfigLoader } from './TaskConfigLoader.js';
export type {
	TaskStatus,
	TaskSummary,
	TaskRecord,
	TaskTreeNode,
	LinkType,
	InverseLinkName,
	TaskLink,
	TaskLinks,
} from './TaskStore.js';
export { TaskStore, LINK_TYPES, INVERSE_LINK_NAMES } from './TaskStore.js';
export type {
	TypeValidationResult,
	TypeValidationError,
	TypeValidationOutcome,
	TypeValidationStrategy,
} from './TypeValidationStrategy.js';
export { OpenTypeStrategy, FixedListTypeStrategy, resolveTypeValidationStrategy } from './TypeValidationStrategy.js';
export { TaskNotFoundError, AmbiguousTaskPrefixError, TaskConflictError } from './errors.js';
