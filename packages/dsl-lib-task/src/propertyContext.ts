import { createContext } from 'react';

export type PropertyDensity = 'compact' | 'comfortable';
export type PropertyLabelPlacement = 'stacked' | 'inline';
export type PropertyLabelWidth = 'narrow' | 'normal' | 'wide';

export interface PropertyLayout {
	density: PropertyDensity;
	labelPlacement: PropertyLabelPlacement;
	labelWidth: PropertyLabelWidth;
}

/** What a PropertyList tells its rows; a row alone uses the defaults. */
export const PropertyLayoutContext = createContext<PropertyLayout>({
	density: 'comfortable',
	labelPlacement: 'stacked',
	labelWidth: 'normal',
});
