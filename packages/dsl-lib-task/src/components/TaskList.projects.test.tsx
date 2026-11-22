import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { FAVORITE_ROWS, PROJECT_INFOS } from '../tasklist/projectFixtures.js';
import { GLOBAL_ROWS, NOW } from '../tasklist/taskListFixtures.js';
import { TaskList } from './TaskList.js';
import type { TaskListProps } from './TaskList.js';

// Favorite and priority projects in the global list: the toggle, the quick chips and the Project popover.

beforeEach(() => {
	sessionStorage.clear();
	window.history.replaceState(null, '', '/tasks');
});

function setup(props: Partial<TaskListProps> = {}) {
	return render(<TaskList rows={FAVORITE_ROWS} projects={PROJECT_INFOS} scope="all" storageKey="all" now={NOW} {...props} />);
}

const count = (): string => screen.getByTestId('tasklist-count').textContent ?? '';
const favToggle = (): HTMLElement => screen.getByRole('button', { name: 'Favorites only' });
const chips = (): HTMLElement => screen.getByRole('group', { name: 'Favorite projects' });
const firstRowId = (): string => screen.getAllByTestId('tasklist-row')[0]!.dataset['id']!;

async function openProjects(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
	await user.click(screen.getByRole('button', { name: /^Project/ }));
	return screen.getByRole('group', { name: 'Project filter' });
}

describe('TaskList global scope: default view', () => {
	it('keeps all projects, no filter and the last-update order whatever the favorites', () => {
		setup();
		expect(count()).toBe('11 of 11 tasks');
		expect(favToggle()).toHaveAttribute('aria-pressed', 'false');
		expect(window.location.search).toBe('');
		expect(firstRowId()).toBe('ff000000');
		expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
	});

	it('shows no toggle and no chips when no project is a favorite, or when the rows lack the new fields (older server)', () => {
		setup({ rows: GLOBAL_ROWS, projects: undefined });
		expect(screen.queryByRole('button', { name: 'Favorites only' })).toBeNull();
		expect(screen.queryByRole('group', { name: 'Favorite projects' })).toBeNull();
		expect(count()).toBe('6 of 6 tasks');
	});
});

describe('TaskList global scope: Favorites only', () => {
	it('keeps the tasks of favorite projects, says so (aria-pressed), writes fav=1, and a second click restores', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(favToggle());
		expect(favToggle()).toHaveAttribute('aria-pressed', 'true');
		expect(count()).toBe('7 of 11 tasks');
		expect(new URLSearchParams(window.location.search).get('fav')).toBe('1');
		await user.click(favToggle());
		expect(favToggle()).toHaveAttribute('aria-pressed', 'false');
		expect(count()).toBe('11 of 11 tasks');
		expect(window.location.search).toBe('');
	});

	it('is restored from the address, combines with the status filter, and Clear filters turns it off', async () => {
		const user = userEvent.setup();
		window.history.replaceState(null, '', '/tasks?fav=1');
		setup();
		expect(favToggle()).toHaveAttribute('aria-pressed', 'true');
		expect(count()).toBe('7 of 11 tasks');
		await user.click(screen.getByRole('button', { name: /^Status/ }));
		await user.click(within(screen.getByRole('group', { name: 'Status filter' })).getByRole('checkbox', { name: /^done/ }));
		expect(count()).toBe('0 of 11 tasks');
		await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
		expect(favToggle()).toHaveAttribute('aria-pressed', 'false');
		expect(count()).toBe('11 of 11 tasks');
	});

	it('stays visible when the address asks for it and no project is a favorite, so it can be turned off', async () => {
		const user = userEvent.setup();
		window.history.replaceState(null, '', '/tasks?fav=1');
		setup({ rows: GLOBAL_ROWS, projects: undefined });
		expect(count()).toBe('0 of 6 tasks');
		await user.click(favToggle());
		expect(count()).toBe('6 of 6 tasks');
	});

	it('is not part of the project scope: a linked fav=1 is dropped with a warning', () => {
		window.history.replaceState(null, '', '/tasks/p/p1?fav=1');
		setup({ rows: GLOBAL_ROWS, projects: undefined, scope: 'project', storageKey: 'p1' });
		expect(screen.queryByRole('button', { name: 'Favorites only' })).toBeNull();
		expect(screen.getByRole('status')).toHaveTextContent('favorite');
		expect(count()).toBe('6 of 6 tasks');
	});
});

describe('TaskList global scope: favorite chips', () => {
	it('draws at most six chips, then "+1 more"; a chip toggles its project (aria-pressed, address)', async () => {
		const user = userEvent.setup();
		setup();
		expect(within(chips()).getAllByRole('button').map(button => button.textContent)).toEqual([
			'apple',
			'banana',
			'cherry',
			'damson',
			'elder',
			'fig',
			'+1 more',
		]);
		const apple = within(chips()).getByRole('button', { name: 'apple' });
		expect(apple).toHaveAttribute('aria-pressed', 'false');
		await user.click(apple);
		expect(apple).toHaveAttribute('aria-pressed', 'true');
		expect(count()).toBe('1 of 11 tasks');
		expect(new URLSearchParams(window.location.search).getAll('projectIn')).toEqual(['apple']);
		await user.click(apple);
		expect(count()).toBe('11 of 11 tasks');
	});

	it('"+1 more" opens the Project list, where the seventh favorite and the chosen one are', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(within(chips()).getByRole('button', { name: 'apple' }));
		await user.click(within(chips()).getByRole('button', { name: '+1 more' }));
		const group = screen.getByRole('group', { name: 'Project filter' });
		expect(within(group).getByRole('checkbox', { name: /^grape/ })).toBeInTheDocument();
		expect(within(group).getByRole('checkbox', { name: /^apple/ })).toBeChecked();
	});

	it('shows every favorite when there are six or fewer, with no "+N more"', () => {
		setup({ projects: PROJECT_INFOS.slice(0, 3), rows: FAVORITE_ROWS.slice(0, 3) });
		expect(within(chips()).getAllByRole('button')).toHaveLength(3);
	});
});

describe('TaskList global scope: Project list', () => {
	it('lists favorites first (named as favorites), then high, normal and low with a tag; keeps counts; offers a project with no task', async () => {
		const user = userEvent.setup();
		setup();
		const group = await openProjects(user);
		const names = within(group)
			.getAllByRole('checkbox')
			.map(box => box.closest('label')!.querySelector('[data-testid="project-name"]')!.textContent);
		expect(names).toEqual(['apple', 'banana', 'cherry', 'damson', 'elder', 'fig', 'grape', 'hotel', 'mango', 'nine', 'lemon']);
		expect(within(group).getByRole('checkbox', { name: /^apple favorite/ })).toBeInTheDocument();
		expect(within(group).getByRole('checkbox', { name: /^nine 2/ })).toBeInTheDocument();
		expect(within(group).getByRole('checkbox', { name: /^mango 0/ })).toBeInTheDocument();
		expect(within(group).getByText('high')).toHaveClass('text-muted');
		expect(within(group).getByText('low')).toHaveClass('text-muted');
		expect(within(group).queryByText('normal')).toBeNull();
	});

	it('offers a search once there are more than eight projects, narrowing the list', async () => {
		const user = userEvent.setup();
		setup();
		const group = await openProjects(user);
		const field = within(group).getByRole('searchbox', { name: 'Search projects' });
		await user.type(field, 'an');
		const labels = within(group).getAllByRole('checkbox').map(box => box.closest('label')!.textContent);
		expect(labels).toHaveLength(2);
		expect(labels[0]).toContain('banana');
		expect(labels[1]).toContain('mango');
		await user.clear(field);
		expect(within(group).getAllByRole('checkbox')).toHaveLength(11);
	});

	it('has no search with eight projects or fewer', async () => {
		const user = userEvent.setup();
		setup({ rows: GLOBAL_ROWS, projects: undefined });
		const group = await openProjects(user);
		expect(within(group).queryByRole('searchbox')).toBeNull();
	});

	it('selects every matching project at once, then clears them', async () => {
		const user = userEvent.setup();
		setup();
		const group = await openProjects(user);
		await user.type(within(group).getByRole('searchbox', { name: 'Search projects' }), 'an');
		await user.click(within(group).getByRole('button', { name: 'Select matching (2)' }));
		expect(new URLSearchParams(window.location.search).getAll('projectIn').sort()).toEqual(['banana', 'mango']);
		expect(count()).toBe('1 of 11 tasks');
		await user.click(within(group).getByRole('button', { name: 'Clear project' }));
		expect(window.location.search).toBe('');
		await user.clear(within(group).getByRole('searchbox', { name: 'Search projects' }));
		await user.click(within(group).getByRole('button', { name: 'Select all (11)' }));
		expect(count()).toBe('11 of 11 tasks');
	});

	it('says when a search matches no project', async () => {
		const user = userEvent.setup();
		setup();
		const group = await openProjects(user);
		await user.type(within(group).getByRole('searchbox', { name: 'Search projects' }), 'zzz');
		expect(within(group).getByText('No project matches.')).toBeInTheDocument();
	});

	it('works on rows alone (older server: no projects list, no favorite fields)', async () => {
		const user = userEvent.setup();
		setup({ rows: GLOBAL_ROWS, projects: undefined });
		const group = await openProjects(user);
		await user.click(within(group).getByRole('checkbox', { name: /^beta/ }));
		expect(count()).toBe('3 of 6 tasks');
	});
});
