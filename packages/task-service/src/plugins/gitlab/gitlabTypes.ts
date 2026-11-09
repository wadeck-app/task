// The shapes of the GitLab REST API v4 that the gitlab strategy reads (only the fields it uses), from docs.gitlab.com. Types only.
// NOT VERIFIED AGAINST A REAL GITLAB: a field marked "UNVERIFIED" is used as documented elsewhere or by name, never seen live.

/** `GET /projects/:id/issues/:issue_iid` and the items of the list (docs.gitlab.com/api/issues). */
export interface ApiIssue {
	/** The global id: not an address (the URLs use `iid`). */
	id: number;
	/** The number inside the project: the task id. */
	iid: number;
	project_id: number;
	title: string;
	description: string | null;
	/** `opened` or `closed` (docs: the `state` filter takes `opened` and `closed`). */
	state: 'opened' | 'closed';
	/** Label NAMES (strings) unless `with_labels_details=true`; an object form is tolerated. */
	labels: Array<string | { name: string }>;
	created_at: string;
	updated_at: string;
	closed_at?: string | null;
	/** `issue`, `incident`, `test_case` or `task`. */
	issue_type?: string;
	web_url?: string;
	/** UNVERIFIED whether system notes are counted: never used to skip a read. */
	user_notes_count?: number;
	confidential?: boolean;
	/** Present on a moved issue (UNVERIFIED, tolerated): such an issue is closed and copied, it is not a task. */
	moved_to_id?: number | null;
}

/** An item of `GET .../issues/:iid/notes` (docs.gitlab.com/api/notes). */
export interface ApiNote {
	id: number;
	body: string;
	author: { username: string; name?: string } | null;
	created_at: string;
	updated_at: string;
	/** true: written by GitLab itself (label changed, title changed...), not a comment. */
	system: boolean;
	noteable_iid?: number | null;
}

/** An item of `GET .../issues/:iid/resource_label_events` (docs.gitlab.com/api/resource_label_events). */
export interface ApiLabelEvent {
	id: number;
	created_at: string;
	user?: { username: string } | null;
	/** UNVERIFIED: a label deleted since may come as null. */
	label: { id?: number; name: string } | null;
	action: 'add' | 'remove';
}

/** An item of `GET .../issues/:iid/resource_state_events` (docs.gitlab.com/api/resource_state_events). */
export interface ApiStateEvent {
	id: number;
	created_at: string;
	user?: { username: string } | null;
	/** `opened` or `closed` for an issue (`reopened`... UNVERIFIED for issues, tolerated). */
	state: string;
}

export type ApiLinkType = 'relates_to' | 'blocks' | 'is_blocked_by';

/** An item of `GET .../issues/:iid/links`: the issue on the other end, plus the link (docs.gitlab.com/api/issue_links). */
export interface ApiLinkedIssue extends ApiIssue {
	issue_link_id: number;
	/** Seen from the issue the list belongs to (UNVERIFIED: the page does not say, the fake and the UI assume so). */
	link_type: ApiLinkType;
}

/** `GET /projects/:id` (the fields the strategy uses). */
export interface ApiProject {
	id: number;
	path_with_namespace: string;
	web_url?: string;
	archived?: boolean;
	/** Deprecated in favour of `issues_access_level`. */
	issues_enabled?: boolean;
	issues_access_level?: 'disabled' | 'private' | 'enabled';
	namespace?: { id: number; full_path?: string; kind?: string };
	permissions?: {
		project_access?: { access_level: number } | null;
		group_access?: { access_level: number } | null;
	};
}

/** An item of `GET /projects/:id/labels`. */
export interface ApiProjectLabel {
	id: number;
	name: string;
	color?: string;
	description?: string | null;
	open_issues_count?: number;
	closed_issues_count?: number;
}
