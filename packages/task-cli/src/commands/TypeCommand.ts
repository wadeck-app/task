// task type list|add|remove: the valid task types of the project.
import { addType, listTypes, removeType } from '@wadeck-app/task-service';

import type { ProjectCommand } from '../cli/env.js';
import { TYPE_HELP } from '../cli/help.js';
import { errorOutput } from '../cli/output.js';

export const runType: ProjectCommand = (rest, { jsonMode, ctx }) => {
	const subCmd = rest[0];
	if (!subCmd || subCmd === '--help') {
		return { exitCode: 0, output: TYPE_HELP };
	}
	switch (subCmd) {
		case 'list': {
			const types = listTypes(ctx);
			if (types.length === 0) {
				return { exitCode: 0, output: '(no types configured -- any string is accepted)' };
			}
			return { exitCode: 0, output: types.join('\n') };
		}
		case 'add': {
			const typeName = rest[1];
			if (!typeName) {
				return errorOutput(jsonMode, 'missing type name', 'Usage: task type add <name>');
			}
			addType(ctx, { name: typeName });
			return { exitCode: 0, output: `Added type: ${typeName}` };
		}
		case 'remove': {
			const typeName = rest[1];
			if (!typeName) {
				return errorOutput(jsonMode, 'missing type name', 'Usage: task type remove <name>');
			}
			removeType(ctx, { name: typeName });
			return { exitCode: 0, output: `Removed type: ${typeName}` };
		}
		// violations-suppress: ts/no-switch-default-break returns a user-facing error, not a silent fallback
		default:
			return errorOutput(
				jsonMode,
				`unknown task type subcommand: ${subCmd}`,
				'Valid subcommands: list, add, remove'
			);
	}
};
