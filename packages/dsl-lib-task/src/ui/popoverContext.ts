import { createContext } from 'react';

/**
 * True inside the panel of a PropertyPopover. A popover opened there (the "+ Add" of a chip field) stays in the flow
 * of the outer panel, which grows and scrolls, instead of floating over it and being clipped by it.
 */
export const InsidePopoverContext = createContext(false);
