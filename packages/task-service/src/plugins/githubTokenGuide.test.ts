import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { BackendAuthError } from '@wadeck-app/task-core';

import {
	DOC_FILE,
	GITHUB_TOKEN_GUIDE_POINTER,
	GUIDE_QUOTES,
	renderGuideMarkdown,
	renderGuideText,
} from './githubTokenGuide.js';
import { deniedPermissionHint } from './github/credentialRequirements.js';
import { resolveToken } from './github/githubToken.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

describe('github token guide: text', () => {
	const text = renderGuideText();

	it('wraps at 100 columns, plain ASCII, no escape codes', () => {
		for (const line of text.split('\n')) {
			// A lone URL longer than the width is not cut.
			if (line.trim().includes(' ')) expect(line.length, line).toBeLessThanOrEqual(100);

			expect(line, line).toMatch(/^[\x20-\x7e]*$/);
		}
	});

	it('covers the four parts in order', () => {
		const order = [
			'1. Create the token',
			'2. Where to put the token',
			'3. Next commands',
			'4. When the token is refused',
		].map(title => text.indexOf(title));
		expect(order.every(index => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it('marks every evidence level and never leaves a claim unmarked', () => {
		expect(text).toContain('VERIFIED LIVE 2026-11-08');
		expect(text).toContain('DOCUMENTED-NOT-LIVE');
		expect(text).toContain('UNKNOWN');
	});

	it('names the permissions, the owner choice, the token file rules and the commands', () => {
		for (const fragment of [
			'Resource owner',
			'Issues: Read and write',
			'Metadata: Read',
			'issue_fields=read',
			'tokenFile',
			'tokenEnv',
			'chmod 600',
			'icacls',
			'AsSecureString',
			'task strategy check',
			'task labels sync --dry-run',
			'task migrate --from',
			'project add',
		]) {
			expect(text, fragment).toContain(fragment);
		}
	});

	it('never suggests echo for the token', () => {
		expect(text).not.toMatch(/echo\s+['"]?\$?\{?TOKEN/i);
		expect(text).not.toMatch(/echo\s+ghp_|echo\s+github_pat_/);
	});
});

describe('github token guide: quoted messages still exist in the code', () => {
	const text = renderGuideText();
	// Wrapping may break a quoted message over two lines.
	const flat = text.replace(/\s+/g, ' ');

	it.each(GUIDE_QUOTES.map(quote => [quote.text, quote.source] as const))('%s (in %s)', (fragment, source) => {
		expect(flat).toContain(fragment);
		const file = path.join(repoRoot, 'packages/task-service/src/plugins', source);
		expect(fs.readFileSync(file, 'utf8')).toContain(fragment);
	});

	it('the runtime messages of the missing token and the denied permission contain what the guide quotes', () => {
		let missing: BackendAuthError | undefined;
		try {
			resolveToken(
				{ kind: 'env', name: 'GITHUB_TOKEN' },
				{},
				{ source: 'config.yml', project: 'shop', repo: 'acme/shop' }
			);
		} catch (error) {
			missing = error as BackendAuthError;
		}
		expect(missing?.message).toContain('No GitHub token: the environment variable GITHUB_TOKEN is not set');
		expect(flat).toContain('No GitHub token: the environment variable');
		expect(missing?.hint).toContain(GITHUB_TOKEN_GUIDE_POINTER);

		const denied = deniedPermissionHint('issues=write', 'acme/shop', 'the file /x', true);
		expect(denied).toContain('Issues: Read and write (GitHub says: issues=write)');
		expect(denied).toContain(GITHUB_TOKEN_GUIDE_POINTER);
		expect(flat).toContain('(GitHub says: issues=write)');
	});

	it('the pointer names the command the CLI answers', () => {
		expect(GITHUB_TOKEN_GUIDE_POINTER).toContain('task strategy help github');
		expect(text).not.toContain(GITHUB_TOKEN_GUIDE_POINTER);
	});
});

describe('github token guide: docs file', () => {
	const file = path.join(repoRoot, DOC_FILE);
	const expected = renderGuideMarkdown();

	it('docs/github-strategy-token.md is exactly what the guide renders (UPDATE_GUIDE_DOC=1 rewrites it)', () => {
		if (process.env['UPDATE_GUIDE_DOC'] === '1') fs.writeFileSync(file, expected);
		expect(fs.existsSync(file), `${DOC_FILE} is missing: run the test with UPDATE_GUIDE_DOC=1`).toBe(true);
		expect(fs.readFileSync(file, 'utf8')).toBe(expected);
	});

	it('is referenced from CLAUDE.md in the github section', () => {
		const claude = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
		const section = claude.slice(claude.indexOf('## Storage strategy: github'));
		expect(section.slice(0, section.indexOf('\n## Storage strategy: gitlab'))).toContain(DOC_FILE);
	});
});
