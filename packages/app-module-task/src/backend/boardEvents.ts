// GET /board/events: the Server-Sent Events stream behind the live Kanban board. The shell has no push bus, so the module opens its
// own stream (the convention of the app-core example module); the browser's EventSource reconnects by itself.
//
// What it sends: `event: version` with `{version}` at once and then only when the version of the board changes (see
// boardVersion: it changes if and only if a card or a column does), `event: problem` with `{error, hint}` when the version cannot
// be read (once per distinct problem; the next good read sends the version again), and a comment line every 20 seconds so a proxy
// does not close an idle stream.
//
// How it notices a change: a write made through THIS module triggers a check at once (BoardHub.notify, called by the route kit when
// a write delivered its events). A write made by another process (the CLI) is found by the timer: for a local project a stat of
// the task index every tick (2 s: the index is rewritten by every change; the content is read only when it changed), for a github,
// gitlab or remote project a read of the (cached) list every 30 s. A local project is also re-read every 30 s whatever the stat
// says, because a config edit changes the columns without touching the index.
//
// Timers are the module's (`ctx.setInterval`): app-core clears them when the module goes, nothing here keeps the process alive.
// One interval of 2 s per open stream, cleared when the client leaves or the module is torn down (closeAll).
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import type { BackendKind } from '@wadeck-app/task-core';

import { boardVersion, listBoardTasks } from './boardView.js';
import { RequestError, toHttpError } from './errors.js';
import { allProjectsFlag } from './request.js';
import { runInRequestScope } from './requestScope.js';
import type { RouteKit } from './routes/routeKit.js';

/** The module clock of a stream. */
export const BOARD_TICK_MS = 2000;
/** A comment line every 20 s. */
export const BOARD_HEARTBEAT_TICKS = 10;
/** A read of the list every 30 s (forge and remote strategies, and the safety read of a local project). */
export const BOARD_CHECK_TICKS = 15;

/** The browser waits this long before it reconnects after a break. */
const RETRY_MS = 5000;

/** How often the version is read, in ticks: every tick for the local strategy (a stat), 30 s for the others (a request). */
export function checkEveryTicks(kind: BackendKind): number {
	return kind === 'local' ? 1 : BOARD_CHECK_TICKS;
}

interface LiveStream {
	/** Reads the version now and sends it when it changed. */
	checkNow(): void;
	close(): void;
}

/** The streams open in this module: a write notifies them, the teardown closes them. */
export interface BoardHub {
	notify(): void;
	closeAll(): void;
	/** Remembers a stream; the returned function forgets it. */
	add(stream: LiveStream): () => void;
}

export function createBoardHub(): BoardHub {
	const streams = new Set<LiveStream>();
	return {
		notify() {
			for (const stream of [...streams]) stream.checkNow();
		},
		closeAll() {
			for (const stream of [...streams]) stream.close();
		},
		add(stream) {
			streams.add(stream);
			return () => void streams.delete(stream);
		},
	};
}

/** "mtime:size" of the task index of a local project; "none" while the project has no task yet (the index is created by the first write). */
function indexSignature(indexFile: string): string {
	try {
		const stat = fs.statSync(indexFile);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
		throw error;
	}
}

function versionBlock(version: string): string {
	return `event: version\ndata: ${JSON.stringify({ version })}\n\n`;
}

export function registerBoardEventRoutes(
	kit: RouteKit,
	ctx: ModuleContext,
	hub: BoardHub,
	report: (text: string) => void
): void {
	// The project, once per request: a stream keeps the registry id and reopens it for every check (a config edit must be seen).
	const readVersion = async (ref: string): Promise<string> =>
		(
			await runInRequestScope(async () => {
				const opened = kit.open({ query: { project: ref } });
				return boardVersion(opened, await listBoardTasks(opened));
			}, report)
		).value;

	kit.stream(
		'/board/events',
		async req => {
			if (allProjectsFlag(req.query, 'the board')) {
				throw new RequestError(
					400,
					'the board is per project: allProjects is not supported',
					'Use ?project=<id|name|alias>.'
				);
			}
			const opened = kit.open(req);
			const version = boardVersion(opened, await listBoardTasks(opened));
			return {
				ref: opened.project.id,
				kind: opened.store.kind,
				indexFile: path.join(opened.storage.dataDir, 'task-index.json'),
				version,
			};
		},
		(prepared, io) => {
			const everyTicks = checkEveryTicks(prepared.kind);
			let lastVersion: string | null = prepared.version;
			let lastProblem: string | null = null;
			let signature: string | null = null;
			try {
				signature = prepared.kind === 'local' ? indexSignature(prepared.indexFile) : null;
			} catch (error) {
				report(
					`board stream: cannot stat ${prepared.indexFile}: ${error instanceof Error ? error.message : String(error)}\n`
				);
			}
			let ticks = 0;
			let busy = false;
			let again = false;

			io.write(`retry: ${RETRY_MS}\n\n`);
			io.write(versionBlock(prepared.version));

			const check = async (forced: boolean): Promise<void> => {
				if (!io.isOpen()) return;
				if (busy) {
					// A change arrived while a read runs: that read may predate it, so read once more afterwards.
					again = again || forced;
					return;
				}
				busy = true;
				try {
					let run = true;
					let force = forced;
					while (run && io.isOpen()) {
						run = false;
						if (!force && prepared.kind === 'local') {
							// Taken BEFORE the read: a write during the read changes it again and is found by the next tick.
							const now = indexSignature(prepared.indexFile);
							if (now === signature) return;
							signature = now;
						}
						try {
							const version = await readVersion(prepared.ref);
							lastProblem = null;
							if (version !== lastVersion) {
								lastVersion = version;
								io.write(versionBlock(version));
							}
						} catch (error) {
							const body = JSON.stringify(toHttpError(error).body);
							// `lastVersion` forgotten: the version is sent again once the problem is fixed, even if it is the same.
							lastVersion = null;
							if (body !== lastProblem) {
								lastProblem = body;
								io.write(`event: problem\ndata: ${body}\n\n`);
							}
						}
						if (again) {
							again = false;
							run = true;
							force = true;
						}
					}
				} finally {
					busy = false;
				}
			};
			const checkSafely = (forced: boolean): void => {
				check(forced).catch((error: unknown) => {
					// Only a failure of the stat itself reaches here (the read has its own handler): said, and the stream goes on.
					report(`board stream: ${error instanceof Error ? error.message : String(error)}\n`);
				});
			};

			const forget = hub.add({ checkNow: () => checkSafely(true), close: io.end });
			const timer = ctx.setInterval(() => {
				ticks++;
				if (ticks % BOARD_HEARTBEAT_TICKS === 0) io.write(': keepalive\n\n');
				if (ticks % everyTicks === 0) {
					// The forge and remote reads are always real reads; a local one is a stat, plus a real read every 30 s.
					checkSafely(prepared.kind !== 'local' || ticks % BOARD_CHECK_TICKS === 0);
				}
			}, BOARD_TICK_MS);
			io.onClose(() => {
				ctx.clearInterval(timer);
				forget();
			});
		}
	);
}
