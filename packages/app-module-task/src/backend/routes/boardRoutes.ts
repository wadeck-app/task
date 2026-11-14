// GET /tasks/board: the data of the Kanban board of ONE project (the stream that tells when it changes is boardEvents.ts).
// A card is moved with the existing POST /tasks/:id/status: the board has no write route of its own.
import { RequestError } from '../errors.js';
import { abSwitcherEnabled, boardBody, listBoardTasks } from '../boardView.js';
import { encodedProject } from '../hrefs.js';
import { BLANK_ANSWER, booleanFlag, isBlankRequest } from '../request.js';
import type { RouteKit } from './routeKit.js';

export function registerBoardRoutes(kit: RouteKit): void {
	kit.route('GET', '/tasks/board', async req => {
		if (isBlankRequest(req.query)) return BLANK_ANSWER;
		if (booleanFlag(req.query, 'allProjects', 'Use ?project=<id|name|alias>: a board shows one project.')) {
			throw new RequestError(
				400,
				'the board is per project: allProjects is not supported',
				'Use ?project=<id|name|alias> (GET /api/modules/task/projects lists the known ones).'
			);
		}
		const ctx = kit.open(req);
		// ONE read of the list (the index for a local project): no task file, no request per task on github or gitlab.
		const tasks = await listBoardTasks(ctx);
		return {
			status: 200,
			body: boardBody(ctx, tasks, { abSwitcher: abSwitcherEnabled(), projectParam: encodedProject(ctx.project) }),
		};
	});
}
