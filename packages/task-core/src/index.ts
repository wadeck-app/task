// Public barrel for @wadeck-app/task-core.
// Exposes the symbols consumed across the package boundary by task-cli.
export type {
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
// The synchronous TaskStore class is NOT exported: it is the local backend's rules engine, reached through
// createLocalBackend / LocalFileBackend only (architecture.test.ts, NO_TASK_STORE_OUTSIDE_CORE).
export { LINK_TYPES, INVERSE_LINK_NAMES, ACTIVITY_PREVIEW_MAX, activityPreview } from './TaskStore.js';
export type {
	TypeValidationResult,
	TypeValidationError,
	TypeValidationOutcome,
	TypeValidationStrategy,
} from './TypeValidationStrategy.js';
export { OpenTypeStrategy, FixedListTypeStrategy, resolveTypeValidationStrategy } from './TypeValidationStrategy.js';
export { TaskNotFoundError, AmbiguousTaskPrefixError, TaskConflictError } from './errors.js';
export type { CommentChange, CommentEdit, TaskComment } from './taskComments.js';
export {
	COMMENT_AUTHOR_MAX,
	COMMENT_TEXT_MAX,
	CommentNotFoundError,
	InvalidCommentTextError,
	normalizeCommentText,
} from './taskComments.js';
// The async port (stage 0 of the storage-strategies design): every caller reads and writes tasks through it.
export type {
	ActivitySupport,
	BackendCapabilities,
	BackendCommentChange,
	BackendCommentEdit,
	BackendTraits,
	LabelSyncEntry,
	LabelSyncReport,
	BackendKind,
	ConcurrencySupport,
	CreateTaskInput,
	DeleteSupport,
	EventSupport,
	HierarchySupport,
	HistorySupport,
	IdSupport,
	LabelCount,
	ListQuery,
	Page,
	ResolvedTask,
	SearchSupport,
	StatusSupport,
	TaskBackend,
	VersionedRecord,
	WriteOptions,
	WriteSupport,
} from './backend/index.js';
export {
	BACKEND_CAPABILITY_NAMES,
	BACKEND_KINDS,
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendRejectedError,
	BackendTimeoutError,
	BackendUnreachableError,
	LOCAL_CAPABILITIES,
	REMOTE_CAPABILITIES,
	LOCAL_TRAITS,
	NO_TRAITS,
	LocalFileBackend,
	PartialWriteError,
	RateLimitedError,
	RemoteIncompatibleError,
	RemoteProjectMismatchError,
	RemoteTimeoutError,
	RemoteUnauthorizedError,
	RemoteUnreachableError,
	createLocalBackend,
	StaleRevisionError,
	UnsupportedByBackendError,
	revisionOf,
} from './backend/index.js';
// The wire protocol of `task serve` and the remote strategy (stage 4): route table and typed errors on the wire.
export {
	API_PREFIX,
	EVENTS_HEADER,
	EVENTS_SUPPRESS,
	PORT_OPERATIONS,
	PROTOCOL_HEADER,
	PROTOCOL_MAX,
	PROTOCOL_MIN,
	PROTOCOL_VERSION,
	ProtocolPathError,
	ROUTES,
	WireProtocolError,
	buildRequest,
	decodeWireError,
	encodeWireError,
	matchRoute,
	routeFor,
} from './remote/index.js';
export type {
	DecodeContext,
	EncodeOptions,
	EventsOutcome,
	HttpMethod,
	PortOperation,
	ProtocolFailureType,
	ProtocolOperation,
	RouteMatch,
	RouteSpec,
	ServerInfo,
	WireErrorBody,
	WireErrorType,
	WriteEnvelope,
} from './remote/index.js';
