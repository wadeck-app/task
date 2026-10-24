// Public barrel for @wadeck-app/task-service.
// Use-case layer shared by task-cli and the task app-module: no console, no process.exit, no argv.
export type { TaskServiceContext } from './context.js';
export type { OpenTaskContextInput } from './openContext.js';
export { openTaskContext } from './openContext.js';
export {
	TaskServiceError,
	InvalidStatusError,
	InvalidLinkTypeError,
	InvalidTaskTypeError,
	InvalidDeleteFilterError,
	AmbiguousDeletePrefixError,
	DanglingParentError,
	ProjectsRegistryError,
	InvalidProjectPathError,
	ProjectNotRegisteredError,
	ProjectAlreadyRegisteredError,
	NoReadableProjectsError,
} from './errors.js';
export type { ProjectFailure } from './errors.js';
export type { ErrorDescription, ErrorKind } from './describeError.js';
export { describeError } from './describeError.js';
export type {
	TaskProjectEnv,
	TaskCreatedEvent,
	TaskStatusChangeEvent,
	TaskLinkedEvent,
	TaskUnlinkedEvent,
	TaskUnblockedEvent,
	TaskTypeChangedEvent,
	TaskLabelAddedEvent,
	TaskLabelRemovedEvent,
	TaskMetaChangedEvent,
	TaskParentChangedEvent,
	TaskDeletedEvent,
	TaskEvent,
	EventSink,
	EventDelivery,
	UndeliveredEvent,
	UndeliveredStatus,
	DeliveryOutcome,
} from './events.js';
export { deliverEvents } from './events.js';
export type {
	EventPublisher,
	PublishOutcome,
	PublisherHooks,
	QueueEventSink,
	QueueEventSinkOptions,
	RegisterEventsOutcome,
} from './queueEventSink.js';
export { createQueueEventSink } from './queueEventSink.js';
export type { QueueEventDeclaration } from './queueEventDeclarations.js';
export { TASK_QUEUE_SOURCE, queueEventDeclarations, queueEventDeclarationsHash } from './queueEventDeclarations.js';
export type { DeclareEventsOutcome, DeclareTaskEventsOptions } from './declareTaskEvents.js';
export { declareTaskEvents } from './declareTaskEvents.js';
export { appendTaskLog } from './taskLog.js';
export type { CreateTaskInput, CreateTaskResult } from './createTask.js';
export { createTask } from './createTask.js';
export type { ListTasksInput } from './listTasks.js';
export { listTasks, listForest, createStatusFilter } from './listTasks.js';
export type { ShowTaskInput, TaskHistory, TaskWithRelations } from './showTask.js';
export { showTask, showTaskWithRelations, getTaskHistory } from './showTask.js';
export type { SetStatusInput, SetStatusResult } from './setStatus.js';
export { setStatus } from './setStatus.js';
export type { LinkTasksInput, LinkTasksResult } from './links.js';
export { ALL_LINK_NAMES, linkTasks, unlinkTasks, getTaskLinks } from './links.js';
export type { TaskChangeResult } from './taskFields.js';
export { setType, addLabel, removeLabel, setMeta } from './taskFields.js';
export { setParent, removeParent, listChildren, listAncestors, getFullTree } from './hierarchy.js';
export type {
	DeleteFilterField,
	DeleteSelector,
	PlanDeleteInput,
	DeletePlan,
	ExecuteDeleteResult,
} from './deleteTasks.js';
export { parseDeleteFilter, planDelete, executeDelete } from './deleteTasks.js';
export type { DeleteSelection, DeleteSelectionProblem } from './deleteSelection.js';
export { selectDeleteTargets, describeDeleteEffects } from './deleteSelection.js';
export type { StatusCount } from './taskStats.js';
export { countTasksByStatus } from './taskStats.js';
export { listTypes, addType, removeType } from './taskTypes.js';
export { getTaskConfigDir, getTaskLogDir } from './configDir.js';
export {
	isSameProjectDir,
	listRegisteredProjects,
	projectsRegistryPath,
	pruneMissingProjects,
	registerProject,
	relocateProject,
	removeRegisteredProject,
	unregisterProject,
} from './projectsRegistry.js';
export { registerInitializedProject } from './registerInitializedProject.js';
export type { InitProjectResult, InitRegistration } from './initProject.js';
export { initProject } from './initProject.js';
export type { AddProjectInput, AddProjectMode, AddProjectResult } from './addProject.js';
export { ADD_PROJECT_MODES, addProject } from './addProject.js';
export { assertExistingDirectory, validateProjectPath } from './projectPaths.js';
export type { ProjectHealth } from './projectsHealth.js';
export { inspectRegisteredProjects } from './projectsHealth.js';
export type {
	ProjectOverview,
	ProjectsSummary,
	ProjectTask,
	ListTasksAcrossProjectsInput,
	TasksAcrossProjects,
} from './projectsOverview.js';
export { summarizeProject, summarizeProjects, listTasksAcrossProjects } from './projectsOverview.js';
