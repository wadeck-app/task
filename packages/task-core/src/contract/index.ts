// Barrel of the contract suites: imported by the packages that ship a backend (`@wadeck-app/task-core/contract`). Test-only: it
// imports vitest, so it is not part of the package barrel.
export type { BackendFixture, ContractCase, ContractOptions, Harness, Need } from './backendContract.js';
export {
	BACKEND_CONTRACT_CASES,
	assertDeclaredCapabilities,
	isSupported,
	runBackendContract,
	runContractCase,
} from './backendContract.js';
export type {
	ReadHarness,
	ReadOnlyCase,
	ReadOnlyContractOptions,
	ReadOnlyFixture,
	SeedStatus,
	SeedTask,
} from './readOnlyContract.js';
export {
	READ_ONLY_CASES,
	READ_ONLY_SCENARIO,
	runReadOnlyBackendContract,
	runReadOnlyCase,
} from './readOnlyContract.js';
