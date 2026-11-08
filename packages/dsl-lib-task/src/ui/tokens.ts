/**
 * Shared look of the interactive controls of the task page. Every pill, chip, button and input that can sit in one
 * row takes its height, radius, border, text and icon size from here, so a row of mixed controls lines up. Literal
 * class strings (the stylesheet scan is static). `controlTokens.test.ts` fails when a component hard-codes another
 * control height.
 *
 * Rhythm: gaps between controls are `gap-2`, between blocks `gap-4`, nothing else.
 */

/** The ONE height of a control (pill, chip, button, input, select). */
export const CONTROL_H = 'h-8';
/** Square icon-only button of the same height. */
export const CONTROL_SQUARE = 'h-8 w-8';
/** Radius of a rectangular control (input, button, popover). */
export const CONTROL_RADIUS = 'rounded-md';
/** Radius of a pill or a chip. */
export const PILL_RADIUS = 'rounded-full';
/** Border of a neutral control. */
export const CONTROL_BORDER = 'border border-border';
/** Font of the text inside a control. */
export const CONTROL_TEXT = 'text-sm';
/** Font of the label of a pill or a chip. */
export const PILL_TEXT = 'text-sm font-medium';
/** Focus ring of every control. */
export const FOCUS_RING = 'focus-visible:ring-2 focus-visible:ring-primary';
/** Focus ring of a text field (also while typing). */
export const FIELD_FOCUS = 'outline-none focus:ring-2 focus:ring-primary';
/** Size of the icons inside a control, in pixels. */
export const ICON_SIZE = 14;
/** Vertical rhythm: between controls of a row or a stack. */
export const GAP_CONTROLS = 'gap-2';
/** Vertical rhythm: between blocks. */
export const GAP_BLOCKS = 'gap-4';

// @formatter:off
/** A text input or select: height, radius, border, background, text, focus. */
export const FIELD_CLASS = `${CONTROL_H} ${CONTROL_RADIUS} ${CONTROL_BORDER} ${CONTROL_TEXT} bg-surface px-2 text-content ${FIELD_FOCUS} placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60 read-only:opacity-70`;
/** A bordered neutral pill or button (text only or text and icon). */
export const PILL_NEUTRAL_CLASS = `inline-flex ${CONTROL_H} items-center ${GAP_CONTROLS} ${PILL_RADIUS} ${CONTROL_BORDER} bg-surface px-3 ${PILL_TEXT} text-content ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60`;
/** A dashed pill that adds something ("+ Add"). */
export const PILL_ADD_CLASS = `inline-flex ${CONTROL_H} items-center ${GAP_CONTROLS} ${PILL_RADIUS} border border-dashed border-border bg-transparent px-3 ${PILL_TEXT} text-muted hover:border-primary hover:text-content ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60`;
/** A filled primary button (Save inside a popover). */
export const BUTTON_PRIMARY_CLASS = `inline-flex ${CONTROL_H} items-center justify-center ${CONTROL_RADIUS} bg-primary px-3 ${PILL_TEXT} text-white hover:opacity-90 ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60`;
/** A square icon button (check, cross, x). */
export const ICON_BUTTON_CLASS = `inline-flex ${CONTROL_SQUARE} shrink-0 items-center justify-center ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface text-muted hover:text-content ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-60`;
/** The panel of a popover: a bordered box that grows with its content up to a height, then scrolls inside; a bottom sheet below 640 px. */
export const POPOVER_PANEL_CLASS = `absolute left-0 top-full z-30 mt-1 flex max-h-[min(70vh,28rem)] min-w-[12rem] max-w-[calc(100vw-1rem)] flex-col overflow-y-auto ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface p-2 shadow-lg max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:mt-0 max-sm:max-w-none max-sm:rounded-b-none`;
/** The results of a search, drawn in the flow BELOW its input. */
export const RESULTS_CLASS = `mt-1 max-h-64 overflow-y-auto ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface py-1`;
/** The input of a search inside a popover stays on top while the results scroll (bottom sheet). */
export const SEARCH_STICKY_CLASS = 'sticky top-0 z-10 bg-surface';
// @formatter:on
