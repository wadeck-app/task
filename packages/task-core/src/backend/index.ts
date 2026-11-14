// Barrel of the backend port (re-exported by ../index.ts).
export type {
	ActivitySupport,
	BackendCapabilities,
	BackendKind,
	ConcurrencySupport,
	DeleteSupport,
	EventSupport,
	HierarchySupport,
	HistorySupport,
	IdSupport,
	SearchSupport,
	StatusSupport,
	WriteSupport,
} from './capabilities.js';
export { BACKEND_CAPABILITY_NAMES, BACKEND_KINDS, LOCAL_CAPABILITIES, REMOTE_CAPABILITIES } from './capabilities.js';
export {
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendRejectedError,
	BackendTimeoutError,
	BackendUnreachableError,
	PartialWriteError,
	RateLimitedError,
	RemoteIncompatibleError,
	RemoteProjectMismatchError,
	RemoteTimeoutError,
	RemoteUnauthorizedError,
	RemoteUnreachableError,
	StaleRevisionError,
	UnsupportedByBackendError,
} from './backendErrors.js';
export type {
	BackendClaimInput,
	BackendClaimResult,
	BackendReleaseResult,
	ReleaseOptions,
	BackendCommentChange,
	BackendCommentEdit,
	LabelSyncEntry,
	LabelSyncReport,
	CreateTaskInput,
	LabelCount,
	ListQuery,
	Page,
	ResolvedTask,
	TaskBackend,
	VersionedRecord,
	WriteOptions,
} from './TaskBackend.js';
export type { BackendTraits } from './traits.js';
export { LOCAL_TRAITS, NO_TRAITS } from './traits.js';
export { LocalFileBackend, createLocalBackend, revisionOf } from './LocalFileBackend.js';
