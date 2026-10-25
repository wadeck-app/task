// Built by `app-core-cli package` into dist-module/dsl-lib/entries.mjs. The default export lists the components the
// shell registers as "task:<name>" (so the views say `$type: task:SplitLayout`).
// The components themselves live in @wadeck-app/dsl-lib-task; this only tells them where the module is mounted.
import { createTaskLibEntries } from '@wadeck-app/dsl-lib-task';
import { API_BASE, ROUTE_BASE } from '../commons/moduleConfig.js';

// The module's own API and pages live under app-core's prefixes, not at the root.
export default createTaskLibEntries({ apiBase: API_BASE, routeBase: ROUTE_BASE });
