// A minimal JSON Schema checker for the subset the queue event declarations use. It exists so that a declaration can be
// tested against the payloads the code really produces without a new dependency. A keyword outside the subset throws:
// a declaration must not rely on a rule nothing checks.

const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
	'type',
	'properties',
	'required',
	'additionalProperties',
	'enum',
	'items',
	'minLength',
	// Annotations, no validation effect.
	'description',
	'title',
	'$schema',
]);

type Json = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case 'string':
		case 'boolean':
			return typeof value === type;
		case 'number':
			return typeof value === 'number';
		case 'integer':
			return typeof value === 'number' && Number.isInteger(value);
		case 'null':
			return value === null;
		case 'array':
			return Array.isArray(value);
		case 'object':
			return isRecord(value);
		default:
			throw new Error(`unsupported JSON Schema type "${type}"`);
	}
}

function visit(schema: Json, value: unknown, at: string, errors: string[]): void {
	if (!isRecord(schema)) throw new Error(`unsupported JSON Schema at ${at}: a schema must be an object`);
	for (const keyword of Object.keys(schema)) {
		if (!SUPPORTED_KEYWORDS.has(keyword)) {
			throw new Error(
				`unsupported JSON Schema keyword "${keyword}" at ${at}: extend jsonSchemaCheck.ts (and test it) first`
			);
		}
	}

	const type = schema['type'];
	if (type !== undefined) {
		const allowed = Array.isArray(type) ? (type as string[]) : [type as string];
		if (!allowed.some(candidate => matchesType(candidate, value))) {
			errors.push(`${at}: expected type ${allowed.join(' or ')}, got ${describeType(value)}`);
			return;
		}
	}

	const allowedValues = schema['enum'];
	if (Array.isArray(allowedValues) && !allowedValues.includes(value)) {
		errors.push(
			`${at}: ${JSON.stringify(value)} is not one of ${allowedValues.map(v => JSON.stringify(v)).join(', ')}`
		);
	}

	const minLength = schema['minLength'];
	if (typeof minLength === 'number' && typeof value === 'string' && value.length < minLength) {
		errors.push(`${at}: shorter than ${minLength} character(s)`);
	}

	if (isRecord(value)) {
		const properties = isRecord(schema['properties']) ? schema['properties'] : {};
		// JSON.stringify drops undefined: a property holding undefined is absent on the wire.
		const present = Object.keys(value).filter(key => value[key] !== undefined);
		const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
		for (const key of required) {
			if (!present.includes(key)) errors.push(`${at}: missing required property "${key}"`);
		}
		for (const key of present) {
			if (key in properties) {
				visit(properties[key], value[key], `${at}.${key}`, errors);
			} else if (schema['additionalProperties'] === false) {
				errors.push(`${at}: property "${key}" is not declared`);
			} else if (isRecord(schema['additionalProperties'])) {
				visit(schema['additionalProperties'], value[key], `${at}.${key}`, errors);
			}
		}
	}

	if (Array.isArray(value) && schema['items'] !== undefined) {
		value.forEach((item, index) => visit(schema['items'], item, `${at}[${index}]`, errors));
	}
}

/** The problems of `value` against `schema` (empty: it conforms). Paths start at `$`. Throws on a schema outside the subset. */
export function checkAgainstSchema(schema: unknown, value: unknown): string[] {
	const errors: string[] = [];
	visit(schema, value, '$', errors);
	return errors;
}
