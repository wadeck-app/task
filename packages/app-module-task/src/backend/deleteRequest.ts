// The delete routes: reading the request (query string or body) and shaping the preview and outcome bodies.
import { describeDeleteEffects, selectDeleteTargets } from '@wadeck-app/task-service';
import type { DeletePlan, PlanDeleteInput } from '@wadeck-app/task-service';

import { RequestError } from './errors.js';
import { encodedProject } from './hrefs.js';
import { bodyObject, queryValue } from './request.js';
import type { RouteRequest } from './request.js';
import { withRowLinks } from './rowViews.js';

export const DELETE_USAGE =
	'Give exactly one selector, in the query string (?ids=a1,b2 | ?all=true | ?filter=<id|title|status|parentId>=<glob>[,<glob>]) or in a JSON body ({ "ids": string[] | "id1,id2" } | { "all": true } | { "filter": "..." }), plus an optional cascade=true. DELETE /tasks also needs confirm=true.';

const DELETE_FIELDS = ['ids', 'all', 'filter', 'cascade', 'confirm'] as const;
const DELETE_FLAGS = new Set<string>(['all', 'cascade', 'confirm']);

/**
 * The fields of a delete request. REST: the selection of the collection is in the query string (`DELETE /tasks?ids=a1,b2&confirm=true`,
 * like a Kubernetes DeleteCollection); a JSON body is accepted too, because the shell's forms send their fields as a body. A field given
 * in both places is a 400: no precedence to guess.
 */
export function deleteFields(req: RouteRequest): Record<string, unknown> {
	const body = req.body === undefined || req.body === null ? {} : bodyObject(req.body, DELETE_USAGE);
	const fields: Record<string, unknown> = { ...body };
	for (const name of DELETE_FIELDS) {
		const raw = queryValue(req.query, name);
		if (raw === undefined) continue;
		if (name in body) {
			throw new RequestError(400, `${name} is given in the query and in the body: give it once`, DELETE_USAGE);
		}
		if (!DELETE_FLAGS.has(name)) {
			fields[name] = raw;
		} else if (raw === 'true' || raw === 'false') {
			fields[name] = raw === 'true';
		} else {
			throw new RequestError(400, `${name} must be true or false`, DELETE_USAGE);
		}
	}
	return fields;
}

type ProjectRef = { id: string; name: string; path: string };

/**
 * The ids of a request: an array, or a comma-separated string (blank entries dropped, spaces around an id ignored: a
 * person types "a1, b2" in a text field); null when it is neither.
 */
function idList(ids: unknown): string[] | null {
	const list = typeof ids === 'string' ? ids.split(',') : ids;
	if (!Array.isArray(list) || list.some(entry => typeof entry !== 'string')) return null;
	return (list as string[]).map(entry => entry.trim()).filter(entry => entry.length > 0);
}

/** The selector of a delete request: exactly one of ids / all / filter. */
export function deleteInput(body: Record<string, unknown>): PlanDeleteInput {
	// A form sends every field: a blank text is "not given".
	const ids = body['ids'] === '' ? undefined : body['ids'];
	const filter = body['filter'] === '' ? undefined : body['filter'];
	const { all, cascade } = body;
	if (all !== undefined && typeof all !== 'boolean') {
		throw new RequestError(400, 'all must be true or false', DELETE_USAGE);
	}
	if (cascade !== undefined && typeof cascade !== 'boolean') {
		throw new RequestError(400, 'cascade must be true or false', DELETE_USAGE);
	}
	if (filter !== undefined && (typeof filter !== 'string' || filter === '')) {
		throw new RequestError(400, 'filter must be a non-empty "field=glob" string', DELETE_USAGE);
	}
	const parsedIds = ids === undefined ? undefined : idList(ids);
	const selection = selectDeleteTargets({
		// Ids of the wrong type still count as "given" for the one-selector rule: they are reported below, once it is satisfied.
		ids: parsedIds === null ? [] : parsedIds,
		all,
		filter,
	});
	if ('problem' in selection) {
		switch (selection.problem) {
			case 'none':
				throw new RequestError(400, 'no selector given: nothing to delete', DELETE_USAGE);
			case 'empty-ids':
				if (parsedIds === null) {
					throw new RequestError(
						400,
						'ids must be an array of strings or a comma-separated string',
						DELETE_USAGE
					);
				}
				throw new RequestError(400, 'ids is empty: nothing to delete', DELETE_USAGE);
			case 'all-and-filter':
			case 'ids-with-all-or-filter':
				throw new RequestError(400, 'give exactly one selector (ids, all or filter)', DELETE_USAGE);
		}
	}
	return { selector: selection.selector, cascade: cascade === true };
}

/** The selector actually given in a delete request (blank form fields dropped). */
function givenSelector(request: Record<string, unknown>): Record<string, unknown> {
	const given: Record<string, unknown> = {};
	if (request['all'] === true) given['all'] = true;
	for (const key of ['ids', 'filter']) {
		if (request[key] !== undefined && request[key] !== '') given[key] = request[key];
	}
	return given;
}

/** The answer of a delete preview; `request` is the body it was asked with. */
export function planBody(
	project: ProjectRef,
	plan: DeletePlan,
	request: Record<string, unknown>
): Record<string, unknown> {
	const count = plan.tasks.length;
	const headline = count === 0 ? 'Nothing to delete.' : `Would delete ${count} task(s).`;
	const summary = [headline, ...effectsWithNotFound(plan, 'would')].join(' ');
	return {
		canConfirm: count > 0,
		// The banner of the confirm form and its button: a delete is never global, the project is named where it is confirmed.
		projectText: `Project ${project.name} (${project.path}): only its tasks listed above will be deleted.`,
		confirmLabel: `Delete these tasks from ${project.name}`,
		// The body that confirms exactly this preview: the confirm form of the page submits it as is.
		confirmRequest:
			count === 0
				? null
				: {
						projectParam: encodedProject(project),
						...givenSelector(request),
						cascade: request['cascade'] === true,
						confirm: true,
					},
		project,
		count,
		tasks: withRowLinks(project, plan.tasks),
		notFound: plan.notFound,
		orphanCount: plan.orphanCount,
		danglingLinkCount: plan.danglingLinkCount,
		summary,
		// What the preview area of the page shows; an executed delete has none, which clears a stale preview.
		previewText: `Project ${project.name}: ${summary}`,
	};
}

/** The answer of an executed delete. */
export function outcomeBody(project: ProjectRef, plan: DeletePlan, deletedCount: number): Record<string, unknown> {
	const summary = [
		`Deleted ${deletedCount} task(s) from project ${project.name}.`,
		...effectsWithNotFound(plan, 'did'),
	].join(' ');
	return {
		project,
		deletedCount,
		orphanCount: plan.orphanCount,
		danglingLinkCount: plan.danglingLinkCount,
		notFound: plan.notFound,
		summary,
		deletedText: summary,
		// Shares the page state of the preview: the confirm form of the executed preview must disappear.
		canConfirm: false,
	};
}

/** The side effects of the deletion, then the ids that matched no task. */
function effectsWithNotFound(plan: DeletePlan, tense: 'would' | 'did'): string[] {
	const notes = describeDeleteEffects(plan, tense);
	if (plan.notFound.length > 0) {
		notes.push(`Not found: ${plan.notFound.join(', ')}.`);
	}
	return notes;
}
