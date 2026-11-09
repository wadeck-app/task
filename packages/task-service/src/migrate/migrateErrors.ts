import { TaskServiceError } from '../errors.js';

/** The migration cannot start: the request contradicts itself or the state of the projects. Nothing was read or written. */
export class MigrationRefusedError extends TaskServiceError {}

/** The journal or the lock of a migration is in a state the run cannot trust or take over. Nothing was written. */
export class MigrationStateError extends TaskServiceError {}
