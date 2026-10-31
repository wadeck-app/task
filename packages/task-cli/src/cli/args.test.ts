import { parseArgs, usesProjectDirOption } from './args.js';

describe('parseArgs', () => {
	it('splits the command from its arguments', () => {
		expect(parseArgs(['set-status', 'abc', 'done'])).toEqual({
			configDir: undefined,
			jsonMode: false,
			command: 'set-status',
			rest: ['abc', 'done'],
		});
	});

	it('reads --config and --json before the command', () => {
		const parsed = parseArgs(['--config', '/cfg', '--json', 'list']);
		expect(parsed).toMatchObject({ configDir: '/cfg', jsonMode: true, command: 'list', rest: [] });
	});

	it('keeps --config after the command as a plain argument (it is a global flag only)', () => {
		expect(parseArgs(['list', '--config', '/cfg']).rest).toEqual(['--config', '/cfg']);
	});

	it('has no command when only global flags are given', () => {
		expect(parseArgs(['--json']).command).toBeUndefined();
	});
});

describe('parseArgs: the project flag is not read here', () => {
	it('leaves -p and --project in the arguments (readProjectOption of task-service takes them out beforehand)', () => {
		expect(parseArgs(['list', '-p', 'shop']).rest).toEqual(['-p', 'shop']);
		expect(parseArgs(['-p', 'shop', 'list']).command).toBe('-p');
	});
});

describe('--project-dir (not an option)', () => {
	it('is never read: it stays in the arguments, and usesProjectDirOption tells it was typed', () => {
		const args = ['show', 'abc', '--project-dir', '/proj'];
		expect(parseArgs(args)).toMatchObject({ rest: ['abc', '--project-dir', '/proj'] });
		expect(parseArgs(args)).not.toHaveProperty('projectDir');
		expect(usesProjectDirOption(args)).toBe(true);
	});

	it.each([
		[['--project-dir', '/proj', 'list']],
		[['list', '--project-dir=/proj']],
		[['list', '--project-dir']],
		[['--json', 'list', '-p', 'shop', '--project-dir', '.']],
	])('is found anywhere in %j', args => {
		expect(usesProjectDirOption(args)).toBe(true);
	});

	it('is not found in other arguments', () => {
		expect(usesProjectDirOption(['list', '-p', 'shop', '--json'])).toBe(false);
		expect(usesProjectDirOption(['new', 'a title about project-dir'])).toBe(false);
	});
});
