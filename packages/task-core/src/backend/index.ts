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
} from './capabilities.js';
export { LOCAL_CAPABILITIES } from './capabilities.js';
export { StaleRevisionError, UnsupportedByBackendError } from './backendErrors.js';
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
export { LocalFileBackend, revisionOf } from './LocalFileBackend.js';
