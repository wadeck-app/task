import {
	API_PREFIX,
	PORT_OPERATIONS,
	PROTOCOL_HEADER,
	PROTOCOL_MAX,
	PROTOCOL_MIN,
	PROTOCOL_VERSION,
	ProtocolPathError,
	ROUTES,
	buildRequest,
	matchRoute,
	routeFor,
} from './protocol';

// Sample values for every placeholder, awkward on purpose: a slash, a percent, a space, a non-ASCII letter.
const AWKWARD: Record<string, string> = {
	id: 'a1b2c3d4',
	prefix: 'a1b2',
	label: 'area/ui 100% ok \u00e9',
	key: 'build key/1',
	type: 'blockedBy',
	target: 'e5f6a7b8',
	commentId: 'c0ffee01',
};

function paramsOf(path: string): Record<string, string> {
	const params: Record<string, string> = {};
	for (const name of path.match(/:\w+/g) ?? []) params[name.slice(1)] = AWKWARD[name.slice(1)]!;
	return params;
}

describe('the protocol constants', () => {
	it('speaks version 1, and the supported range is exactly that version', () => {
		expect(PROTOCOL_VERSION).toBe(1);
		expect(PROTOCOL_MIN).toBe(1);
		expect(PROTOCOL_MAX).toBe(1);
		expect(PROTOCOL_HEADER).toBe('X-Task-Protocol');
		expect(API_PREFIX).toBe('/v1');
	});
});

describe('the route table', () => {
	it('has one route for every operation of the TaskBackend port, and one for info', () => {
		const ops = ROUTES.map(route => route.op).sort();
		expect(ops).toEqual([...PORT_OPERATIONS, 'info'].sort());
	});

	it('has no two routes with the same method and path', () => {
		const keys = ROUTES.map(route => `${route.method} ${route.path}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('marks as writes exactly the operations that change a task (reads never go through the write queue)', () => {
		const writes = ROUTES.filter(route => route.write)
			.map(route => route.op)
			.sort();
		expect(writes).toEqual(
			[
				'create',
				'updateStatus',
				'setTitle',
				'setDescription',
				'setType',
				'clearType',
				'addLabel',
				'removeLabel',
				'setMeta',
				'removeMeta',
				'setParent',
				'removeParent',
				'addLink',
				'removeLink',
				'addComment',
				'editComment',
				'removeComment',
				'deleteTask',
			].sort()
		);
		for (const route of ROUTES.filter(r => r.method === 'GET')) expect(route.write).toBe(false);
	});

	it('every path lives under /v1', () => {
		for (const route of ROUTES) expect(route.path.startsWith('/v1/')).toBe(true);
	});

	it('routeFor answers the route of an operation and refuses an unknown one with the list', () => {
		expect(routeFor('get').path).toBe('/v1/tasks/:id');
		expect(() => routeFor('nope' as never)).toThrow(/nope/);
	});
});

describe('buildRequest and matchRoute', () => {
	it('round-trips every route, awkward parameters included', () => {
		for (const route of ROUTES) {
			const params = paramsOf(route.path);
			const built = buildRequest(route.op, params);
			expect(built.method).toBe(route.method);
			const matched = matchRoute(built.method, built.path);
			expect(matched, `${route.method} ${route.path}`).toMatchObject({ op: route.op, params });
		}
	});

	it('encodes a slash and a percent in a path parameter, so it cannot be taken for a path separator', () => {
		const built = buildRequest('removeLabel', { id: 'a1', label: 'a/b%c d' });

		expect(built).toEqual({ method: 'DELETE', path: '/v1/tasks/a1/labels/a%2Fb%25c%20d' });
	});

	it('adds the query of a route that takes one, leaving out the absent values', () => {
		expect(buildRequest('getForest', {}, { parentId: 'p1' }).path).toBe('/v1/forest?parentId=p1');
		expect(buildRequest('getForest', {}, { parentId: undefined }).path).toBe('/v1/forest');
	});

	it('refuses a missing path parameter by name (a bug of the caller, never a silent empty segment)', () => {
		expect(() => buildRequest('get', {})).toThrow(/id/);
	});

	it('the route ending in a literal (links/lenient) is not mistaken for a link type', () => {
		expect(matchRoute('GET', '/v1/tasks/a1/links/lenient')).toMatchObject({ op: 'getLinksLenient' });
		expect(matchRoute('DELETE', '/v1/tasks/a1/links/blockedBy/b2')).toMatchObject({
			op: 'removeLink',
			params: { id: 'a1', type: 'blockedBy', target: 'b2' },
		});
	});

	it('answers undefined for an unknown path and the allowed methods for a known path with the wrong method', () => {
		expect(matchRoute('GET', '/v1/nothing')).toBeUndefined();
		expect(matchRoute('GET', '/v2/tasks')).toBeUndefined();
		expect(matchRoute('PATCH', '/v1/tasks/a1')).toEqual({ methodNotAllowed: ['DELETE', 'GET'] });
	});

	it('ignores a trailing query string and refuses a malformed percent sequence', () => {
		expect(matchRoute('GET', '/v1/tasks/a1?x=1')).toMatchObject({ op: 'get', params: { id: 'a1' } });
		expect(() => matchRoute('GET', '/v1/tasks/%E0%A4%A')).toThrow(ProtocolPathError);
	});

	it('does not match an empty segment', () => {
		expect(matchRoute('GET', '/v1/tasks//children')).toBeUndefined();
	});
});
