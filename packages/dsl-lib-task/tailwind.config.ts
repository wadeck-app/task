import type { Config } from 'tailwindcss';
// @ts-expect-error - plain JS preset shipped by dsl-ui, no type declarations
import dslUiPreset, { dslUiContent } from '@wadeck-app/dsl-ui/tailwind-preset';

/**
 * Tailwind config of the library's stylesheet (scripts/build-css.ts, which also sets the content globs to absolute
 * paths). The preset owns the colour mapping (primary, bg, surface, border, content, muted, success, danger,
 * warning, ...) and the dark-mode selector: nothing is restated here, so the components stay inside the design system.
 */
export default {
	presets: [dslUiPreset],
	content: [
		'./src/**/*.{ts,tsx}',
		// Required, not optional: Tailwind reads `content` from the top-level config only, so the preset cannot
		// contribute scan paths. Without this the build still succeeds and every dsl-ui component renders unstyled.
		...(dslUiContent as string[]),
	],
	theme: {
		extend: {
			colors: {
				// LabelChips palette: tokens in src/styles/task.css, light and dark.
				'task-chip-1': 'var(--color-task-chip-1)',
				'task-chip-2': 'var(--color-task-chip-2)',
				'task-chip-3': 'var(--color-task-chip-3)',
				'task-chip-4': 'var(--color-task-chip-4)',
				'task-chip-5': 'var(--color-task-chip-5)',
				'task-chip-6': 'var(--color-task-chip-6)',
				'task-chip-1-bg': 'var(--color-task-chip-1-bg)',
				'task-chip-2-bg': 'var(--color-task-chip-2-bg)',
				'task-chip-3-bg': 'var(--color-task-chip-3-bg)',
				'task-chip-4-bg': 'var(--color-task-chip-4-bg)',
				'task-chip-5-bg': 'var(--color-task-chip-5-bg)',
				'task-chip-6-bg': 'var(--color-task-chip-6-bg)',
			},
		},
	},
	plugins: [],
} satisfies Config;
