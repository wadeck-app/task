// Public barrel for @wadeck-app/task-core.
// Exposes the symbols consumed across the package boundary by task-cli.
export type {
	TaskHookValue,
	TaskStatusEntry,
	TaskGlobalConfig,
	TaskProjectConfig,
	TaskResolvedConfig,
	StatusOutcome,
} from './TaskConfigLoader.js';
export { TaskConfigLoader, statusOutcomeProblem } from './TaskConfigLoader.js';
export type {
	TaskStatus,
	TaskSummary,
	TaskRecord,
	ActivityEntry,
	ActivityKind,
	TaskTreeNode,
	LinkType,
	InverseLinkName,
	TaskLink,
	TaskLinks,
} from './TaskStore.js';
export type { TaskStoreOptions } from './TaskStore.js';
export { TaskStore, LINK_TYPES, INVERSE_LINK_NAMES, ACTIVITY_PREVIEW_MAX, activityPreview } from './TaskStore.js';
export type {
	TypeValidationResult,
	TypeValidationError,
	TypeValidationOutcome,
	TypeValidationStrategy,
} from './TypeValidationStrategy.js';
export { OpenTypeStrategy, FixedListTypeStrategy, resolveTypeValidationStrategy } from './TypeValidationStrategy.js';
export { TaskNotFoundError, AmbiguousTaskPrefixError, TaskConflictError } from './errors.js';
export type { CommentChange, CommentEdit, TaskComment } from './taskComments.js';
export { COMMENT_AUTHOR_MAX, COMMENT_TEXT_MAX, CommentNotFoundError, InvalidCommentTextError } from './taskComments.js';
// The async port (stage 0 of the storage-strategies design): not used by any caller yet.
export type {
	ActivitySupport,
	BackendCapabilities,
	BackendCommentChange,
	BackendCommentEdit,
	BackendKind,
	ConcurrencySupport,
	CreateTaskInput,
	DeleteSupport,
	HierarchySupport,
	HistorySupport,
	IdSupport,
	LabelCount,
	ListQuery,
	Page,
	SearchSupport,
	StatusSupport,
	TaskBackend,
	VersionedRecord,
	WriteOptions,
} from './backend/index.js';
export {
	LOCAL_CAPABILITIES,
	LocalFileBackend,
	StaleRevisionError,
	UnsupportedByBackendError,
	revisionOf,
} from './backend/index.js';
