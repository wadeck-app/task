// The log writer a strategy plugin gets: lines go to the task log (`task cli logs`), where the other diagnostics already are.
import { getTaskLogDir } from './configDir.js';
import type { StrategyContext } from './plugins/kinds.js';
import { appendTaskLog } from './taskLog.js';

/** Never throws: a log that cannot be written must not fail a read. */
export function taskLogWriter(): StrategyContext['log'] {
	return (level, message) => {
		appendTaskLog(getTaskLogDir(), level, message);
	};
}
