/**
 * Generates src/generated/entries.tsx: one registry entry per component of this package (src/components).
 *
 *   npm run entries --workspace=packages/dsl-lib-task
 *
 * Same generator as any dsl app (dsl-renderer's buildEntriesFile), which is what makes the transfer of these
 * components to dsl-view mechanical: the JSDoc tags (`@registryCategory`, `@registryTags`) and the prop types are
 * the contract. Only OUR components are scanned (the module's views use dsl-ui's built-ins from the shell, not
 * from this bundle). The file is committed, like any generated source; generateEntries.test.ts fails when stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEntriesFile } from '@wadeck-app/dsl-renderer/build/entriesGenerator';
import { COMPONENTS_DIR, LIB_ENTRIES, PACKAGE_DIR } from './paths.js';

/**
 * Runs the generator with fs.readdirSync answering in byte order: dsl-renderer never sorts the component files, so
 * the entries would otherwise come out in the file system's order (case-insensitive on Windows, byte order on Linux
 * and macOS) and a file generated on one machine would differ from what CI generates on another.
 */
function withByteOrderListing<T>(run: () => T): T {
	const real = fs.readdirSync;
	fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
		const result = (real as (...a: unknown[]) => unknown).apply(fs, args);
		// Only plain name lists: a listing with file types (Dirent) is left as it came.
		return Array.isArray(result) && result.every(entry => typeof entry === 'string')
			? [...result].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
			: result;
	}) as typeof fs.readdirSync;
	try {
		return run();
	} finally {
		fs.readdirSync = real;
	}
}

/**
 * The helpers the installed shell (dsl-renderer 175) does not export. The entries import them from the local compat
 * module instead, which uses the shell's own when it has them (see src/compat/dslRenderer.ts).
 */
const COMPAT_NAMES = ['coerceProp', 'resolveExpressionsDeep', 'coerceDate', 'coerceStringList'];
const PACKAGE_IMPORT = /^import \{([^}]*)\} from '@wadeck-app\/dsl-renderer'$/m;

/** Moves the compat helpers out of the `@wadeck-app/dsl-renderer` import into `../compat/dslRenderer.js`. */
export function useCompatHelpers(source: string): string {
	const match = PACKAGE_IMPORT.exec(source);
	if (!match) {
		throw new Error(
			"generate-entries: the generated entries have no `import { ... } from '@wadeck-app/dsl-renderer'` line; the generator's output changed, adapt useCompatHelpers."
		);
	}
	const names = match[1]!.split(',').map(name => name.trim());
	const compat = names.filter(name => COMPAT_NAMES.includes(name));
	const kept = names.filter(name => !COMPAT_NAMES.includes(name));
	const lines = [`import { ${kept.join(', ')} } from '@wadeck-app/dsl-renderer'`];
	if (compat.length > 0) {
		lines.push(`import { ${compat.join(', ')} } from '../compat/dslRenderer.js'`);
	}
	return source.replace(PACKAGE_IMPORT, lines.join('\n'));
}

/**
 * A component's `onAction` defaults to the page handler `ctx.onAction` (`@ctxDefault`). In the installed shell that
 * handler does not publish the action's `resultKey`, so the default becomes `pageActionHandler(ctx)`, which prefers the
 * handler a Form's `onSubmit` uses (see src/compat/actions.ts).
 */
export function usePageActionHandler(source: string): string {
	const ctxDefault = "?? ctx['onAction']";
	if (!source.includes(ctxDefault)) {
		return source;
	}
	const withHandler = source.replaceAll(ctxDefault, '?? pageActionHandler(ctx)');
	const importLine = "import { pageActionHandler } from '../compat/actions.js'\n";
	// Right after the compat import line.
	const compat = withHandler.indexOf("from '../compat/dslRenderer.js'");
	const endOfLine = compat === -1 ? 0 : withHandler.indexOf('\n', compat) + 1;
	return withHandler.slice(0, endOfLine) + importLine + withHandler.slice(endOfLine);
}

/** The content of src/generated/entries.tsx, nothing written. */
export function generateEntries(): string {
	if (!fs.existsSync(COMPONENTS_DIR)) {
		throw new Error(`generate-entries: no components directory at ${COMPONENTS_DIR}.`);
	}
	return usePageActionHandler(
		useCompatHelpers(
			withByteOrderListing(() =>
				buildEntriesFile(PACKAGE_DIR, [{ pkg: 'dsl-lib-task', absDir: COMPONENTS_DIR }], undefined, {
					usePackageImports: true,
				})
			)
		)
	);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	fs.mkdirSync(path.dirname(LIB_ENTRIES), { recursive: true });
	fs.writeFileSync(LIB_ENTRIES, generateEntries(), 'utf8');
	process.stdout.write(`generated ${path.relative(process.cwd(), LIB_ENTRIES)}\n`);
}
