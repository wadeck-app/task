// Public barrel for @wadeck-app/task-service.
// Use-case layer shared by task-cli and the task app-module: no console, no process.exit, no argv.
export type { TaskServiceContext } from './context.js';
export { projectEnv } from './context.js';
export {
	TaskServiceError,
	InvalidStatusError,
	InvalidLinkTypeError,
	InvalidTaskTypeError,
	InvalidDeleteFilterError,
	AmbiguousDeletePrefixError,
	DanglingParentError,
	ProjectsRegistryError,
} from './errors.js';
export type {
	TaskProjectEnv,
	TaskCreatedEvent,
	TaskStatusChangeEvent,
	TaskLinkedEvent,
	TaskUnlinkedEvent,
	TaskUnblockedEvent,
	TaskEvent,
	EventSink,
} from './events.js';
export { deliverEvents } from './events.js';
export type { QueueEventSinkOptions } from './queueEventSink.js';
export { createQueueEventSink, resolveQueueJsPath } from './queueEventSink.js';
export { levenshtein, suggest, matchGlob } from './text.js';
export type { CreateTaskInput, CreateTaskResult } from './createTask.js';
export { createTask } from './createTask.js';
export type { ListTasksInput } from './listTasks.js';
export { listTasks, listForest, createStatusFilter } from './listTasks.js';
export type { ShowTaskInput, TaskHistory } from './showTask.js';
export { showTask, getTaskHistory } from './showTask.js';
export type { SetStatusInput, SetStatusResult } from './setStatus.js';
export { setStatus } from './setStatus.js';
export type { LinkTasksInput, LinkTasksResult } from './links.js';
export { ALL_LINK_NAMES, parseLinkType, linkTasks, unlinkTasks, getTaskLinks } from './links.js';
export { setType, addLabel, removeLabel, setMeta } from './taskFields.js';
export { setParent, removeParent, listChildren, listAncestors, getFullTree } from './hierarchy.js';
export type { DeleteFilterField, DeleteSelector, PlanDeleteInput, DeletePlan } from './deleteTasks.js';
export { DELETE_FILTER_FIELDS, parseDeleteFilter, planDelete, executeDelete } from './deleteTasks.js';
export { listTypes, addType, removeType } from './taskTypes.js';
export { getTaskConfigDir } from './configDir.js';
export {
	listRegisteredProjects,
	projectsRegistryPath,
	registerProject,
	unregisterProject,
} from './projectsRegistry.js';
