import { parseArgs } from './args.js';

describe('parseArgs', () => {
	it('splits the command from its arguments', () => {
		expect(parseArgs(['set-status', 'abc', 'done'])).toEqual({
			configDir: undefined,
			projectDir: undefined,
			jsonMode: false,
			command: 'set-status',
			rest: ['abc', 'done'],
		});
	});

	it('reads --config and --json before the command', () => {
		const parsed = parseArgs(['--config', '/cfg', '--json', 'list']);
		expect(parsed).toMatchObject({ configDir: '/cfg', jsonMode: true, command: 'list', rest: [] });
	});

	it('reads --json and --project-dir after the command and removes them from the arguments', () => {
		const parsed = parseArgs(['show', 'abc', '--json', '--project-dir', '/proj', '--with-parent']);
		expect(parsed).toMatchObject({
			projectDir: '/proj',
			jsonMode: true,
			command: 'show',
			rest: ['abc', '--with-parent'],
		});
	});

	it('keeps --config after the command as a plain argument (it is a global flag only)', () => {
		expect(parseArgs(['list', '--config', '/cfg']).rest).toEqual(['--config', '/cfg']);
	});

	it('leaves a --project-dir without value in the arguments, for the command to reject as an unknown flag', () => {
		expect(parseArgs(['list', '--project-dir']).rest).toEqual(['--project-dir']);
	});

	it('has no command when only global flags are given', () => {
		expect(parseArgs(['--json']).command).toBeUndefined();
	});
});
