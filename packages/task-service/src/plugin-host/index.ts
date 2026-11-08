// The plugin host seam: generic registry, slot resolution and instance lifecycle. Imports nothing from task (architecture rule
// SEAM_IMPORTS_NOTHING_OF_TASK), so the folder can be extracted into a shared package unchanged.
export type { AnyPlugin, Plugin, PluginDescription, PluginInstance } from './Plugin.js';
export { PLUGIN_ID_PATTERN, isPlugin, pluginProblem } from './Plugin.js';
export type { BuiltinPluginEntry, PluginRegistry, RegisteredPlugin } from './PluginRegistry.js';
export { PluginLookupError, PluginRegistrationError, createPluginRegistry } from './PluginRegistry.js';
export type { ResolvedSlot, SlotLocation } from './resolveSlot.js';
export { PluginSlotError, resolveSlot } from './resolveSlot.js';
export { DEFAULT_CREATE_TIMEOUT_MS, PluginCreateError, createInstance } from './createInstance.js';
