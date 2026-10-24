import { parseArgs, usesRemovedProjectDir } from './args.js';

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

	it('leaves a -p without value in the arguments, for the command to reject as an unknown flag', () => {
		expect(parseArgs(['list', '-p']).rest).toEqual(['-p']);
		expect(parseArgs(['list', '-p']).projectRef).toBeUndefined();
	});

	it('is undefined when not given', () => {
		expect(parseArgs(['list']).projectRef).toBeUndefined();
	});
});

describe('--project-dir (removed)', () => {
	it('is no longer read: it stays in the arguments, and usesRemovedProjectDir tells it was typed', () => {
		const args = ['show', 'abc', '--project-dir', '/proj'];
		expect(parseArgs(args)).toMatchObject({ rest: ['abc', '--project-dir', '/proj'] });
		expect(parseArgs(args)).not.toHaveProperty('projectDir');
		expect(usesRemovedProjectDir(args)).toBe(true);
	});

	it.each([
		[['--project-dir', '/proj', 'list']],
		[['list', '--project-dir=/proj']],
		[['list', '--project-dir']],
		[['--json', 'list', '-p', 'shop', '--project-dir', '.']],
	])('is found anywhere in %j', args => {
		expect(usesRemovedProjectDir(args)).toBe(true);
	});

	it('is not found in other arguments', () => {
		expect(usesRemovedProjectDir(['list', '-p', 'shop', '--json'])).toBe(false);
		expect(usesRemovedProjectDir(['new', 'a title about project-dir'])).toBe(false);
	});
});
