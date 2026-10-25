import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where things are. Kept apart from the scripts because those import build tools (esbuild, postcss) that
 * cannot even be loaded inside the jsdom environment the rendering tests run in.
 */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGES_DIR = path.resolve(PACKAGE_DIR, '..');
export const MODULE_DIR = path.join(PACKAGES_DIR, 'app-module-task');
/** The package's sources: the components the generated entries wrap, and what the Tailwind scan reads their classes from. */
export const SRC_DIR = path.join(PACKAGE_DIR, 'src');
export const COMPONENTS_DIR = path.join(SRC_DIR, 'components');
/** Entries generated from src/components by scripts/generate-entries.ts (committed, like any generated source). */
export const LIB_ENTRIES = path.join(SRC_DIR, 'generated', 'entries.tsx');
/** The library's stylesheet source: the utilities its components use. */
export const LIB_CSS = path.join(SRC_DIR, 'styles', 'task.css');
/** The module's views: the source of its pages, and what the Tailwind scan reads their classes from. */
export const MODULE_VIEWS_DIR = path.join(MODULE_DIR, 'src', 'dsl-views');
/** Where `app-core-cli package` looks for the stylesheet it copies as built. */
export const MODULE_STYLE_CSS = path.join(MODULE_DIR, 'src', 'dsl-components', 'style.css');
/** What `app-core-cli package` writes by default. */
export const MODULE_DIST = path.join(MODULE_DIR, 'dist-module');
