// GET /tasks/board: the data of the Kanban board of ONE project (the stream that tells when it changes is boardEvents.ts).
// A card is moved with the existing POST /tasks/:id/status: the board has no move route of its own. The LAYOUT of the columns
// (the `board` key of config.yml, decision D18) is edited with PUT / DELETE /board/config: a config edit like the types, so no
// queue event.
import { clearBoardColumns, saveBoardColumns } from '@wadeck-app/task-service';

import { RequestError } from '../errors.js';
import { boardBody, listBoardTasks } from '../boardView.js';
import { encodedProject } from '../hrefs.js';
import { BLANK_ANSWER, booleanFlag, bodyObject, isBlankRequest } from '../request.js';
import type { RouteRequest } from '../request.js';
import type { RouteKit } from './routeKit.js';

const CONFIG_USAGE =
	'Send a JSON body { "columns": [{ "name": string, "statuses": [string, ...] }, ...] }; DELETE /board/config resets to one column per status.';

function refuseAllProjects(query: RouteRequest['query']): void {
	if (booleanFlag(query, 'allProjects', 'Use ?project=<id|name|alias>: a board shows one project.')) {
		throw new RequestError(
			400,
			'the board is per project: allProjects is not supported',
			'Use ?project=<id|name|alias> (GET /api/modules/task/projects lists the known ones).'
		);
	}
}

export function registerBoardRoutes(kit: RouteKit): void {
	/** The board of the project as it is now (the project is opened again: a config edit is not in an earlier snapshot). */
	const answerBoard = async (
		req: Parameters<RouteKit['open']>[0]
	): Promise<{ status: 200; body: Record<string, unknown> }> => {
		const ctx = kit.open(req);
		// ONE read of the list (the index for a local project): no task file, no request per task on github or gitlab.
		const tasks = await listBoardTasks(ctx);
		return {
			status: 200,
			body: boardBody(ctx, tasks, { projectParam: encodedProject(ctx.project) }),
		};
	};

	kit.route('GET', '/tasks/board', async req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		refuseAllProjects(req.query);
		return answerBoard(req);
	});

	kit.route('PUT', '/board/config', async req => {
		refuseAllProjects(req.query);
		const ctx = kit.open(req);
		const body = bodyObject(req.body, CONFIG_USAGE);
		for (const key of Object.keys(body)) {
			if (key !== 'columns' && key !== 'finishedFor') {
				throw new RequestError(
					400,
					`unknown key "${key}" in the body (only "columns" and "finishedFor" are allowed)`,
					CONFIG_USAGE
				);
			}
		}
		if (body['columns'] === undefined) {
			throw new RequestError(400, 'columns is missing from the body', CONFIG_USAGE);
		}
		// Validated like a config load (a ConfigSchemaError naming the file and the key); nothing is written when it fails.
		// `finishedFor` null or absent = every finished task is shown.
		saveBoardColumns(ctx, body['columns'], body['finishedFor'] === null ? undefined : body['finishedFor']);
		// The streams of the board check their version at once (no task event is raised).
		await kit.deliver([]);
		return answerBoard(req);
	});

	kit.route('DELETE', '/board/config', async req => {
		refuseAllProjects(req.query);
		const ctx = kit.open(req);
		clearBoardColumns(ctx);
		await kit.deliver([]);
		return answerBoard(req);
	});
}
