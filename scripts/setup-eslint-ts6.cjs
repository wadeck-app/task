/**
 * postinstall: symlink typescript@6 into each @typescript-eslint/* nested node_modules
 * so they pick up TS6 instead of the TS7 installed at the root.
 * Required until typescript-eslint releases TS7 support:
 * https://github.com/typescript-eslint/typescript-eslint/issues/10940
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ts6Path = path.join(root, 'node_modules', 'typescript-6');

if (!fs.existsSync(ts6Path)) {
	console.error('✗ setup-eslint-ts6: node_modules/typescript-6 not found — run npm install first');
	process.exit(1);
}

const targets = [
	'node_modules/typescript-eslint/node_modules',
	'node_modules/@typescript-eslint/parser/node_modules',
	'node_modules/@typescript-eslint/typescript-estree/node_modules',
	'node_modules/@typescript-eslint/eslint-plugin/node_modules',
	'node_modules/@typescript-eslint/type-utils/node_modules',
	'node_modules/@typescript-eslint/utils/node_modules',
	'node_modules/ts-api-utils/node_modules',
];

for (const target of targets) {
	const fullTarget = path.join(root, target);
	const tsLink = path.join(fullTarget, 'typescript');

	fs.mkdirSync(fullTarget, { recursive: true });

	try {
		fs.rmSync(tsLink, { recursive: true, force: true });
	} catch (_) {}

	// Use 'junction' on Windows for directory symlinks (no elevated privileges needed)
	fs.symlinkSync(ts6Path, tsLink, 'junction');
	console.log(`✓ Linked typescript@6 → ${tsLink}`);
}
