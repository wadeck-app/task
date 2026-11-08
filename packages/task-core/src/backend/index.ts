// Barrel of the backend port (re-exported by ../index.ts).
export type {
	ActivitySupport,
	BackendCapabilities,
	BackendKind,
	ConcurrencySupport,
	DeleteSupport,
	HierarchySupport,
	HistorySupport,
	IdSupport,
	SearchSupport,
	StatusSupport,
	WriteSupport,
} from './capabilities.js';
export { BACKEND_CAPABILITY_NAMES, BACKEND_KINDS, LOCAL_CAPABILITIES } from './capabilities.js';
export {
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendTimeoutError,
	BackendUnreachableError,
	RateLimitedError,
	StaleRevisionError,
	UnsupportedByBackendError,
} from './backendErrors.js';
export type {
	BackendCommentChange,
	BackendCommentEdit,
	CreateTaskInput,
	LabelCount,
	ListQuery,
	Page,
	TaskBackend,
	VersionedRecord,
	WriteOptions,
} from './TaskBackend.js';
export { LocalFileBackend, createLocalBackend, revisionOf } from './LocalFileBackend.js';
