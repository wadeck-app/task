import * as fs from 'node:fs';
import * as path from 'node:path';

import { TaskConfigLoader } from '@wadeck-app/task-core';

import { InvalidProjectPathError, ProjectsRegistryError } from './errors.js';
import { initProject } from './initProject.js';
import { assertExistingDirectory, validateProjectPath } from './projectPaths.js';
import { registerInitializedProject } from './registerInitializedProject.js';

export const ADD_PROJECT_MODES = ['register', 'init'] as const;
export type AddProjectMode = (typeof ADD_PROJECT_MODES)[number];

export interface AddProjectInput {
	/** Absolute directory of the project. */
	path: string;
	/** `register`: the directory already holds a task project. `init`: create `.task` there first (`task init`). */
	mode: AddProjectMode;
	/**
	 * `init` only: create the directory when it does not exist, ONE level (its parent must exist). Without it a
	 * missing directory is refused: a typo in a path must not leave a stray directory tree behind.
	 */
	createDirectory?: boolean;
}

export interface AddProjectResult {
	path: string;
	mode: AddProjectMode;
	/** False when the project was already registered. */
	added: boolean;
	/** True when `.task` was created by this call. */
	initialized: boolean;
	createdDirectory: boolean;
}

/**
 * The "add a project" use case of the UI (CLI equivalents: `task projects add`, `task init`). Every path is validated
 * (absolute, no relative segment, no NUL), an existing directory is required (`createDirectory` aside), and a project is
 * only registered once it holds a `.task`. Nothing is created before everything is validated.
 */
export function addProject(configDir: string, input: AddProjectInput): AddProjectResult {
	if (!ADD_PROJECT_MODES.includes(input.mode)) {
		throw new InvalidProjectPathError(
			`mode must be one of: ${ADD_PROJECT_MODES.join(', ')} (got "${String(input.mode)}")`,
			'Use "register" for a directory that already holds a task project, "init" to create one there.'
		);
	}
	const dir = validateProjectPath(input.path);
	const createDirectory = input.createDirectory === true;
	if (createDirectory && input.mode !== 'init') {
		throw new InvalidProjectPathError(
			'createDirectory applies only with the initialise mode',
			'Registering needs a directory that already holds a task project.'
		);
	}
	if (input.mode === 'register') {
		assertExistingDirectory(dir);
		if (!TaskConfigLoader.isInitialized(dir)) {
			throw new InvalidProjectPathError(
				`${dir} is not an initialized task project (no .task directory)`,
				'To start a new task project there, choose "initialise a new task project here".'
			);
		}
		const { added } = registerInitializedProject(configDir, dir);
		return { path: dir, mode: 'register', added, initialized: false, createdDirectory: false };
	}
	const createdDirectory = prepareDirectory(dir, createDirectory);
	const result = initProject(dir, configDir);
	if (!result.registration.ok) {
		// The project exists on disk: say so, so that nobody initialises it again, and how to finish.
		throw new ProjectsRegistryError(
			`the project was initialized in ${dir} but is not registered:${result.registration.message}`,
			result.registration.hint ?? 'Fix the registry, then add the project again with "register".'
		);
	}
	return { path: dir, mode: 'init', added: result.registration.added, initialized: result.created, createdDirectory };
}

/** The directory `init` works in must exist; with `createDirectory` it is created (one level). True when created. */
function prepareDirectory(dir: string, createDirectory: boolean): boolean {
	if (fs.existsSync(dir)) {
		assertExistingDirectory(dir);
		return false;
	}
	if (!createDirectory) {
		throw new InvalidProjectPathError(
			`directory ${dir} does not exist`,
			'Check the spelling of the path. Create the directory yourself, or tick "Create the directory" (its parent must exist).'
		);
	}
	const parent = path.dirname(dir);
	try {
		assertExistingDirectory(parent);
	} catch {
		throw new InvalidProjectPathError(
			`cannot create ${dir}: its parent ${parent} does not exist`,
			'Check the path for a typo, or create the parent directory first (only one level is created).'
		);
	}
	fs.mkdirSync(dir);
	return true;
}
