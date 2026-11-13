// task strategy show|check: arguments and printing over the task-service use cases `showStrategy` / `checkStrategy`.
import { checkStrategy, showStrategy } from '@wadeck-app/task-service';
import type {
	CapabilityRow,
	CheckLine,
	ResolvedProject,
	StrategyCheck,
	StrategyReport,
	StrategyTarget,
} from '@wadeck-app/task-service';

import { STRATEGY_HELP } from '../cli/help.js';
import { errorOutput, failure, jsonResult } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

export type StrategySubcommand = 'show' | 'check';

const USAGE: Record<StrategySubcommand, string> = {
	show: 'Usage: task strategy show [-p <project>] [--json]',
	check: 'Usage: task strategy check [-p <project>] [--json]',
};

/** `task strategy` / `task strategy --help` need no project: the dispatcher answers them before resolving one. */
export function isStrategyHelp(rest: readonly string[]): boolean {
	return rest[0] === undefined || rest[0] === '--help';
}

export function strategyHelp(): CommandResult {
	return { exitCode: 0, output: STRATEGY_HELP };
}

/** The subcommand, or the error to print: checked before any project is looked up, so a typo fails the same in any folder. */
export function parseStrategyInvocation(
	rest: readonly string[],
	jsonMode: boolean
): { sub: StrategySubcommand } | CommandResult {
	const [sub, ...args] = rest;
	if (sub !== 'show' && sub !== 'check') {
		return errorOutput(jsonMode, `unknown task strategy subcommand: ${sub}`, 'Valid subcommands: show, check');
	}
	if (args.length > 0) {
		return errorOutput(jsonMode, `unexpected argument: ${args[0]}`, USAGE[sub]);
	}
	return { sub };
}

const PAD = 11;

function field(label: string, lines: readonly string[]): string[] {
	const [first = '', ...more] = lines;
	return [`${label.padEnd(PAD)}${first}`, ...more.map(line => `${' '.repeat(PAD)}${line}`)];
}

function capabilityTable(rows: readonly CapabilityRow[]): string[] {
	const nameWidth = Math.max(...rows.map(row => row.capability.length));
	const stateWidth = Math.max(...rows.map(row => row.state.length));
	return rows.map(row => `  ${row.capability.padEnd(nameWidth)}  ${row.state.padEnd(stateWidth)}  ${row.detail}`);
}

export function formatReport(report: StrategyReport): string {
	const lines: string[] = [
		...field('Project:', [
			`${report.project.name}${report.project.id === undefined ? '' : ` (${report.project.id})`}`,
		]),
		...field('Strategy:', [
			`${report.type === report.ref ? report.ref : `${report.type} (${report.ref})`}, ${
				report.declared ? `configured in ${report.source}` : 'default: the config has no strategy section'
			}`,
		]),
		...field('Fidelity:', [report.fidelity]),
		...field('Data:', [report.dataDir]),
		...field('Config:', [report.source]),
		...field('Summary:', [report.summary]),
		...field(
			'Fills:',
			report.fills.length === 0
				? ['none']
				: report.fills.map(
						fill => `${fill.capability} via ${fill.technique} (${fill.quality}, fidelity ${fill.fidelity})`
					)
		),
		...field(
			'Tokens:',
			report.tokens.length === 0
				? ['none']
				: report.tokens.map(token =>
						token.source === 'env'
							? `${token.key}: ${token.name} (environment variable, ${token.present === true ? 'set' : 'NOT SET'})`
							: `${token.key}: ${token.name} (file, checked by: task strategy check)`
					)
		),
	];
	if (report.transport !== undefined) {
		lines.push(...field('Transport:', [`${report.transport.ref} ${JSON.stringify(report.transport.options)}`]));
	}
	lines.push('', 'Capabilities:', ...capabilityTable(report.capabilities));
	return lines.join('\n');
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function formatLines(lines: readonly CheckLine[]): string[] {
	const nameWidth = Math.max(...lines.map(line => line.name.length));
	const statusWidth = Math.max(...lines.map(line => line.status.length));
	return lines.flatMap(line => [
		`  ${line.name.padEnd(nameWidth)}  ${line.status.padEnd(statusWidth)}  ${line.text}`,
		...(line.fix === undefined ? [] : [`  ${' '.repeat(nameWidth)}  ${' '.repeat(statusWidth)}  fix: ${line.fix}`]),
	]);
}

export function formatCheck(target: StrategyTarget, result: StrategyCheck): string {
	const { project } = target;
	const lines = [
		`Strategy check for ${project.name}${project.id === undefined ? '' : ` (${project.id})`}`,
		...formatLines(result.lines),
		'',
		`Result: ${result.ok ? 'ok' : 'FAILED'} (${plural(result.errors, 'error')}, ${plural(result.warnings, 'warning')})`,
	];
	if (result.report !== undefined) lines.push('', 'Capabilities:', ...capabilityTable(result.report.capabilities));
	return lines.join('\n');
}

/** Runs the subcommand on the resolved project. `configDir` is the global task config directory (`--config`). */
export async function runStrategy(
	sub: StrategySubcommand,
	jsonMode: boolean,
	resolved: ResolvedProject,
	configDir: string | undefined
): Promise<CommandResult> {
	const target: StrategyTarget = {
		storage: resolved.storage,
		project: { id: resolved.id, name: resolved.name, path: resolved.path },
		globalConfigDir: configDir,
	};
	try {
		if (sub === 'show') {
			const report = showStrategy(target);
			return jsonMode ? jsonResult(report) : { exitCode: 0, output: formatReport(report) };
		}
		const result = await checkStrategy(target);
		const exitCode = result.ok ? 0 : 1;
		return { exitCode, output: jsonMode ? JSON.stringify(result, null, 2) : formatCheck(target, result) };
	} catch (error) {
		return failure(jsonMode, error);
	}
}
