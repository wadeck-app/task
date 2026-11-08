// `task strategy check`: validates the project's strategy configuration end to end and reports every finding as a line with its
// fix. A config problem is a line (never a throw), so the command can print it in the block it prints everything else in.
import { describeError } from './describeError.js';
import { createInstance } from './plugin-host/index.js';
import type { CheckLine, ProjectFacts } from './plugins/kinds.js';
import { loadProjectSetup, projectFactsOf } from './projectConfig.js';
import { techniquesOf } from './strategyFills.js';
import { collectTokenKeys, fillRows, showStrategy } from './strategyReport.js';
import type { StrategyReport, StrategyTarget } from './strategyReport.js';
import { taskLogWriter } from './strategyLog.js';
import { tasksDirOf } from './storage.js';
import { checkTokenEnv, checkTokenFile } from './tokenCheck.js';
import type { ResolvedStrategy } from './strategyResolve.js';

export interface StrategyCheck {
	/** True when no line is an error (warnings do not fail the check). */
	ok: boolean;
	errors: number;
	warnings: number;
	lines: CheckLine[];
	/** The strategy as `show` reports it; absent when the config could not be used. */
	report?: StrategyReport;
}

function summarize(lines: CheckLine[], report?: StrategyReport): StrategyCheck {
	const errors = lines.filter(line => line.status === 'error').length;
	const warnings = lines.filter(line => line.status === 'warn').length;
	return { ok: errors === 0, errors, warnings, lines, ...(report === undefined ? {} : { report }) };
}

function isLoopback(hostname: string): boolean {
	return (
		hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(\.\d{1,3}){3}$/.test(hostname)
	);
}

/** The `url` of the transport slot, when the strategy has one. */
function transportUrl(strategy: ResolvedStrategy): string | undefined {
	const url = strategy.transport?.options['url'];
	return typeof url === 'string' ? url : undefined;
}

function fillWarnings(strategy: ResolvedStrategy): CheckLine[] {
	return fillRows(strategy)
		.filter(fill => fill.quality !== 'exact')
		.map(fill => {
			const exact = Object.entries(techniquesOf(fill.capability) ?? {})
				.filter(
					([technique, quality]) =>
						quality === 'exact' &&
						(strategy.plugin.fillTechniques[fill.capability] ?? []).includes(technique)
				)
				.map(([technique]) => technique);
			return {
				name: 'fills',
				status: 'warn' as const,
				text: `${fill.capability} is emulated via ${fill.technique} (${fill.quality}): edits made on the forge may overwrite it`,
				fix:
					exact.length === 0
						? 'Accepted by fidelity: degrade; no exact technique exists for this capability on this backend'
						: `Accepted by fidelity: degrade; use an exact technique (${exact.join(', ')}) to remove this warning`,
			};
		});
}

function tokenLines(strategy: ResolvedStrategy, env: NodeJS.ProcessEnv): CheckLine[] {
	return collectTokenKeys(strategy.options).map(token =>
		token.source === 'env' ? checkTokenEnv(token.key, token.name, env) : checkTokenFile(token.key, token.name)
	);
}

function securityLines(strategy: ResolvedStrategy): CheckLine[] {
	const url = transportUrl(strategy);
	if (url === undefined) return [];
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' || isLoopback(parsed.hostname)) return [];
	return [
		{
			name: 'security',
			status: 'warn',
			text: `plain HTTP to a non-loopback host: traffic and the token are readable on the network; trusted LAN only (${url})`,
			fix: 'Serve over https:// through a wrapper, or keep the server on a network you trust',
		},
	];
}

/** Opens the backend like a command would, asks the plugin for its lines, and always disposes what it opened. */
async function backendLines(
	strategy: ResolvedStrategy,
	target: StrategyTarget,
	facts: ProjectFacts
): Promise<CheckLine[]> {
	let instance: Awaited<ReturnType<typeof createInstance<typeof strategy.plugin>>>;
	try {
		instance = await createInstance(strategy, {
			source: strategy.source,
			statuses: facts.statuses,
			types: facts.types,
			project: target.project,
			tasksDir: tasksDirOf(target.storage),
			dataDir: target.storage.dataDir,
			// A check never writes a task.
			writeFile: () => {
				throw new Error('strategy check must not write');
			},
			env: target.env ?? process.env,
			fidelity: strategy.fidelity,
			fills: strategy.fills,
			log: taskLogWriter(),
		});
	} catch (error) {
		const hint = describeError(error).hint;
		return [
			{
				name: 'backend',
				status: 'error',
				text: error instanceof Error ? error.message : String(error),
				...(hint === undefined ? {} : { fix: hint }),
			},
		];
	}
	try {
		return await instance.check();
	} catch (error) {
		return [
			{
				name: 'backend',
				status: 'error',
				text: `the check itself failed: ${error instanceof Error ? error.message : String(error)}`,
				fix: 'Run the command again; if it keeps failing, task cli logs shows the cause',
			},
		];
	} finally {
		await instance.dispose();
	}
}

/**
 * Checks the strategy of a project. Never throws for a problem of the project: the config error, a missing token, an unreachable
 * backend are lines. Creates nothing and writes no task.
 */
export async function checkStrategy(target: StrategyTarget): Promise<StrategyCheck> {
	let strategy: ResolvedStrategy;
	let report: StrategyReport;
	let facts: ProjectFacts;
	try {
		const setup = loadProjectSetup(target.storage, {
			globalConfigDir: target.globalConfigDir,
			registry: target.registry,
		});
		strategy = setup.strategy;
		facts = projectFactsOf(setup.config);
		report = showStrategy(target);
	} catch (error) {
		const { message, hint } = describeError(error);
		return summarize([
			{ name: 'config', status: 'error', text: message, ...(hint === undefined ? {} : { fix: hint }) },
		]);
	}
	const tokens = tokenLines(strategy, target.env ?? process.env);
	const lines: CheckLine[] = [
		{
			name: 'config',
			status: 'ok',
			text: `${strategy.source}: ${strategy.declared ? 'strategy section valid' : 'no strategy section, local by default'}`,
		},
		{ name: 'strategy', status: 'ok', text: `${strategy.type} (${strategy.ref}), fidelity ${strategy.fidelity}` },
		...fillWarnings(strategy),
		...tokens,
		...securityLines(strategy),
		...(await backendLines(strategy, target, facts)),
	];
	return summarize(lines, report);
}
