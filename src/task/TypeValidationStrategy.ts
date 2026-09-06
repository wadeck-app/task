/**
 * Pluggable type validation strategies for `task set-type`.
 *
 * - OpenTypeStrategy: no validation, any string is accepted (default when no types configured)
 * - FixedListTypeStrategy: value must be in the configured list
 */

export interface TypeValidationResult {
	valid: true;
}

export interface TypeValidationError {
	valid: false;
	error: string;
}

export type TypeValidationOutcome = TypeValidationResult | TypeValidationError;

export interface TypeValidationStrategy {
	name: string;
	validate(value: string): TypeValidationOutcome;
}

/**
 * Default strategy: accepts any string without validation.
 * Used when no types are configured in .task/config.yml.
 */
export class OpenTypeStrategy implements TypeValidationStrategy {
	readonly name = 'open';

	validate(_value: string): TypeValidationOutcome {
		return { valid: true };
	}
}

/**
 * Fixed-list strategy: value must be one of the configured types.
 * Used when a non-empty `types` list is present in .task/config.yml.
 */
export class FixedListTypeStrategy implements TypeValidationStrategy {
	readonly name = 'fixed-list';

	constructor(private readonly allowedTypes: string[]) {}

	validate(value: string): TypeValidationOutcome {
		if (this.allowedTypes.includes(value)) {
			return { valid: true };
		}
		return {
			valid: false,
			error: `unknown type "${value}". Valid types: ${this.allowedTypes.join(', ')}`,
		};
	}
}

/**
 * Select the appropriate strategy based on the resolved config types list.
 * Returns FixedListTypeStrategy when types are configured, OpenTypeStrategy otherwise.
 */
export function resolveTypeValidationStrategy(configuredTypes: string[]): TypeValidationStrategy {
	if (configuredTypes.length > 0) {
		return new FixedListTypeStrategy(configuredTypes);
	}
	return new OpenTypeStrategy();
}
