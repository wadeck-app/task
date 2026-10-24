// Routes that manage the registry from the Projects page: add (register or initialise), edit (relocate), remove.
// None needs a ?project: they act on the registry itself. Errors go through the route() wrapper (typed mapping,
// inline errors for the views, 5xx logging).
import * as path from 'node:path';

import {
	addProject,
	isSameProjectDir,
	listKnownProjects,
	listRegisteredProjects,
	ProjectNotRegisteredError,
	relocateProject,
	removeRegisteredProject,
	validateProjectPath,
} from '@wadeck-app/task-service';
import type { AddProjectMode } from '@wadeck-app/task-service';

import { RequestError, toHttpError } from '../errors.js';
import { addedText, editPromptText, relocatedText, removeConfirmHint, removedText } from '../projectManagement.js';
import { listProjects } from '../projects.js';
import { bodyObject, requiredString } from '../request.js';
import type { RouteKit } from './routeKit.js';

const ADD_USAGE = 'Send a JSON body { "path": string, "mode": "register" | "init", "createDirectory"?: boolean }.';
const RELOCATE_USAGE = 'Send a JSON body { "from": string, "to": string }.';
const REMOVE_USAGE = 'Send a JSON body { "path": string, "confirm": true }.';

/**
 * Rethrows a refusal (4xx) with extra fields in its body. The view stores the answer of the action in place of the row
 * it was given; with the row's fields in the failure too, the Edit form stays open with what was typed.
 * A 5xx is rethrown as is, so that it is logged with its stack.
 */
function failWith(error: unknown, extra: Record<string, unknown>): never {
	const failure = toHttpError(error);
	if (failure.status >= 500) throw error;
	const { error: message, hint, ...rest } = failure.body;
	throw new RequestError(
		failure.status,
		typeof message === 'string' ? message : 'request failed',
		typeof hint === 'string' ? hint : undefined,
		{ ...rest, ...extra }
	);
}

/**
 * The Projects page edits the legacy list (projects.json) only. A project of the shared registry is managed with the project
 * CLI: refuse before touching anything, saying which command does it (the row buttons are shown for every row).
 */
function refuseSharedProject(configDir: string, dir: string, action: 'remove' | 'move'): void {
	const shared = listKnownProjects(configDir).projects.find(
		entry => entry.registered && isSameProjectDir(entry.path, dir)
	);
	if (shared === undefined) return;
	throw new RequestError(
		409,
		`${shared.name} (${shared.id}) is in the shared project registry: the Projects page cannot ${action} it`,
		action === 'remove'
			? `Run: project remove "${shared.name}" (its tasks and .task stay on disk).`
			: `Run: project paths move (see 'project paths --help') to give ${shared.name} its new directory.`
	);
}

export function registerProjectManageRoutes(kit: RouteKit): void {
	const { route, configDir } = kit;

	route('POST', '/projects', req => {
		const body = bodyObject(req.body, ADD_USAGE);
		const createDirectory = body['createDirectory'];
		if (createDirectory !== undefined && typeof createDirectory !== 'boolean') {
			throw new RequestError(
				400,
				'createDirectory must be true or false',
				'Send a JSON boolean, not a text (the text "false" would read as set).'
			);
		}
		const result = addProject(configDir, {
			path: body['path'] as string,
			mode: body['mode'] as AddProjectMode,
			createDirectory: createDirectory === true,
		});
		return {
			status: result.added || result.initialized ? 201 : 200,
			body: { ...result, messageText: addedText(result), projects: listProjects(configDir) },
		};
	});

	route('POST', '/projects/relocate', req => {
		const body = bodyObject(req.body, RELOCATE_USAGE);
		const from = requiredString(body, 'from', RELOCATE_USAGE);
		const to = requiredString(body, 'to', RELOCATE_USAGE);
		let moved: { from: string; to: string };
		try {
			refuseSharedProject(configDir, from, 'move');
			moved = relocateProject(configDir, from, to);
		} catch (error) {
			return failWith(error, { from, to, editPrompt: editPromptText(path.basename(from), from) });
		}
		return {
			status: 200,
			body: { ...moved, messageText: relocatedText(moved.from, moved.to), projects: listProjects(configDir) },
		};
	});

	route('POST', '/projects/remove', req => {
		const body = bodyObject(req.body, REMOVE_USAGE);
		const wanted = validateProjectPath(requiredString(body, 'path', REMOVE_USAGE));
		refuseSharedProject(configDir, wanted, 'remove');
		// Unknown project: say so before asking to confirm anything.
		const stored = listRegisteredProjects(configDir).find(entry => isSameProjectDir(entry, wanted));
		if (stored === undefined) throw new ProjectNotRegisteredError(wanted);
		// Irreversible for the registry (not for the data): only an explicit boolean true goes through.
		if (body['confirm'] !== true) {
			throw new RequestError(
				400,
				'confirm must be true to remove the project: nothing was removed',
				removeConfirmHint(stored),
				{ path: stored }
			);
		}
		const { removed } = removeRegisteredProject(configDir, stored);
		return {
			status: 200,
			body: { removed, messageText: removedText(removed), projects: listProjects(configDir) },
		};
	});
}
