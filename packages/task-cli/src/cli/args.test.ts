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

describe('parseArgs: -p / --project <ref>', () => {
	it('reads -p and --project after the command and removes them from the arguments', () => {
		expect(parseArgs(['list', '-p', 'shop', '--all']).projectRef).toBe('shop');
		const parsed = parseArgs(['show', 'abc', '--project', 'shop', '--with-parent']);
		expect(parsed).toMatchObject({ projectRef: 'shop', command: 'show', rest: ['abc', '--with-parent'] });
	});

	it('reads -p and --project before the command, next to --config and --json', () => {
		expect(parseArgs(['-p', 'shop', 'list'])).toMatchObject({ projectRef: 'shop', command: 'list', rest: [] });
		expect(parseArgs(['--json', '--project', 'shop', '--config', '/cfg', 'list'])).toMatchObject({
			projectRef: 'shop',
			configDir: '/cfg',
			jsonMode: true,
			command: 'list',
		});
	});

	it('keeps the reference as typed (an empty one is for the resolver to refuse)', () => {
		expect(parseArgs(['list', '-p', '']).projectRef).toBe('');
	});

	it('leaves a -p without value in the arguments, like --project-dir', () => {
		expect(parseArgs(['list', '-p']).rest).toEqual(['-p']);
		expect(parseArgs(['list', '-p']).projectRef).toBeUndefined();
	});

	it('is undefined when not given', () => {
		expect(parseArgs(['list']).projectRef).toBeUndefined();
	});
});
