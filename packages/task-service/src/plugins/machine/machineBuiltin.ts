// The built-in `machine` transport plugin: the transport over the real runner (nodeMachineRunner.ts). Kept apart from machinePlugin.ts so
// the unit tests, which inject a fake runner, never import `node:child_process`.
import { createMachinePlugin } from './machinePlugin.js';
import { createNodeMachineRunner } from './nodeMachineRunner.js';

export const machinePlugin = createMachinePlugin(createNodeMachineRunner());
