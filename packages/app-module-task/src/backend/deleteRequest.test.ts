import { RequestError } from './errors.js';
import { deleteInput, outcomeBody, planBody } from './deleteRequest.js';

function rejection(body: Record<string, unknown>): string {
	try {
		deleteInput(body);
	} catch (error) {
		expect(error).toBeInstanceOf(RequestError);
		expect((error as RequestError).status).toBe(400);
		return (error as RequestError).message;
	}
	throw new Error(`expected deleteInput to reject ${JSON.stringify(body)}`);
}

describe('deleteInput', () => {
	it('reads ids as an array or as a comma-separated string, dropping blanks', () => {
		expect(deleteInput({ ids: ['a1', 'b2'] })).toEqual({
			selector: { kind: 'ids', ids: ['a1', 'b2'] },
			cascade: false,
		});
		expect(deleteInput({ ids: 'a1,,b2' }).selector).toEqual({ kind: 'ids', ids: ['a1', 'b2'] });
	});

	// Found in a real browser: "nc5r, ix7w" in the text field (the label says comma separated) reported "Not found: ix7w."
	it('ignores the spaces around the ids of a comma-separated string, as typed in a form', () => {
		expect(deleteInput({ ids: 'a1, b2 ,  c3' }).selector).toEqual({ kind: 'ids', ids: ['a1', 'b2', 'c3'] });
		expect(deleteInput({ ids: ' a1 , ' }).selector).toEqual({ kind: 'ids', ids: ['a1'] });
		expect(deleteInput({ ids: ['a1', ' b2'] }).selector).toEqual({ kind: 'ids', ids: ['a1', 'b2'] });
	});

	it('reads all, a filter and cascade', () => {
		expect(deleteInput({ all: true, cascade: true })).toEqual({ selector: { kind: 'all' }, cascade: true });
		expect(deleteInput({ filter: 'status=done' }).selector).toEqual({
			kind: 'filter',
			field: 'status',
			values: ['done'],
		});
	});

	it('treats blank form fields as not given', () => {
		expect(deleteInput({ ids: '', filter: 'status=done', all: false }).selector.kind).toBe('filter');
	});

	it('rejects a request without selector', () => {
		expect(rejection({})).toBe('no selector given: nothing to delete');
		expect(rejection({ ids: '', filter: '', all: false })).toBe('no selector given: nothing to delete');
	});

	it('rejects several selectors', () => {
		expect(rejection({ all: true, filter: 'status=done' })).toBe('give exactly one selector (ids, all or filter)');
		expect(rejection({ ids: ['a'], all: true })).toBe('give exactly one selector (ids, all or filter)');
	});

	it('rejects ids that hold nothing', () => {
		expect(rejection({ ids: [] })).toBe('ids is empty: nothing to delete');
		expect(rejection({ ids: ',' })).toBe('ids is empty: nothing to delete');
	});

	it('rejects ids of the wrong type, but reports the one-selector rule first', () => {
		expect(rejection({ ids: 12 })).toBe('ids must be an array of strings or a comma-separated string');
		expect(rejection({ ids: 12, all: true })).toBe('give exactly one selector (ids, all or filter)');
	});

	it('rejects flags and filter of the wrong type', () => {
		expect(rejection({ all: 'yes' })).toBe('all must be true or false');
		expect(rejection({ ids: 'a', cascade: 1 })).toBe('cascade must be true or false');
		expect(rejection({ filter: 3 })).toBe('filter must be a non-empty "field=glob" string');
	});
});

describe('delete bodies', () => {
	const project = { name: 'proj', path: '/p/proj' };
	const plan = { tasks: [], notFound: ['zz'], orphanCount: 1, danglingLinkCount: 2 };

	it('the preview summary names the side effects and the unknown ids', () => {
		const body = planBody(
			project,
			{ ...plan, tasks: [{ id: 'a', title: 'A', status: 'done', createdAt: '2026-01-01T00:00:00.000Z' }] },
			{ ids: 'a,zz' }
		);
		expect(body['summary']).toBe(
			'Would delete 1 task(s). 1 child task(s) would become root tasks (their parent is deleted). 2 link(s) pointing to deleted tasks would be removed. Not found: zz.'
		);
		expect(body['canConfirm']).toBe(true);
		expect(body['confirmRequest']).toEqual({
			projectParam: '%2Fp%2Fproj',
			ids: 'a,zz',
			cascade: false,
			confirm: true,
		});
	});

	it('an empty preview cannot be confirmed', () => {
		const body = planBody(project, plan, { ids: 'zz' });
		expect(body['summary']).toBe(
			'Nothing to delete. 1 child task(s) would become root tasks (their parent is deleted). 2 link(s) pointing to deleted tasks would be removed. Not found: zz.'
		);
		expect(body['canConfirm']).toBe(false);
		expect(body['confirmRequest']).toBeNull();
	});

	it('the outcome summary is in the past tense', () => {
		expect(outcomeBody(project, plan, 3)['summary']).toBe(
			'Deleted 3 task(s) from project proj. 1 child task(s) became root tasks (their parent was deleted). 2 link(s) pointing to deleted tasks were removed. Not found: zz.'
		);
	});
});
