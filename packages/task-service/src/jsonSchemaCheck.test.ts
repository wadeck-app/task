import { checkAgainstSchema } from './jsonSchemaCheck.js';

describe('checkAgainstSchema (the subset of JSON Schema the event declarations use)', () => {
	it('accepts a value matching type, properties, required and enum', () => {
		const schema = {
			type: 'object',
			properties: { a: { type: 'string' }, b: { enum: ['x', 'y'] } },
			required: ['a'],
		};
		expect(checkAgainstSchema(schema, { a: 'hi', b: 'x' })).toEqual([]);
		expect(checkAgainstSchema(schema, { a: 'hi' })).toEqual([]);
	});

	it('reports a wrong type with the path', () => {
		const schema = { type: 'object', properties: { a: { type: 'string' } } };
		expect(checkAgainstSchema(schema, { a: 3 })).toEqual(['$.a: expected type string, got number']);
	});

	it('reports a missing required property', () => {
		const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
		expect(checkAgainstSchema(schema, {})).toEqual(['$: missing required property "a"']);
	});

	it('treats a property holding undefined as absent (JSON drops it)', () => {
		const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
		expect(checkAgainstSchema(schema, { a: undefined })).toEqual(['$: missing required property "a"']);
		const optional = { type: 'object', properties: { a: { type: 'string' } } };
		expect(checkAgainstSchema(optional, { a: undefined })).toEqual([]);
	});

	it('refuses a property the schema does not list when additionalProperties is false', () => {
		const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
		expect(checkAgainstSchema(schema, { a: 'x', extra: 1 })).toEqual(['$: property "extra" is not declared']);
		expect(checkAgainstSchema({ type: 'object', properties: {} }, { extra: 1 })).toEqual([]);
	});

	it('checks array items and enum values', () => {
		const schema = { type: 'array', items: { enum: ['a', 'b'] } };
		expect(checkAgainstSchema(schema, ['a', 'b'])).toEqual([]);
		expect(checkAgainstSchema(schema, ['a', 'c'])).toEqual(['$[1]: "c" is not one of "a", "b"']);
	});

	it('distinguishes integer from number and an array or null from an object', () => {
		expect(checkAgainstSchema({ type: 'integer' }, 1.5)).toEqual(['$: expected type integer, got number']);
		expect(checkAgainstSchema({ type: 'object' }, [])).toEqual(['$: expected type object, got array']);
		expect(checkAgainstSchema({ type: 'object' }, null)).toEqual(['$: expected type object, got null']);
	});

	it('checks minLength', () => {
		expect(checkAgainstSchema({ type: 'string', minLength: 1 }, '')).toEqual(['$: shorter than 1 character(s)']);
	});

	it('throws on a keyword it does not implement, so a declaration cannot rely on an unchecked rule', () => {
		expect(() => checkAgainstSchema({ type: 'string', pattern: '^a' }, 'a')).toThrow(/unsupported.*pattern/);
	});
});
