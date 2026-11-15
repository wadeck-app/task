// What a backend keeps and where its limits are, beyond the capabilities: the facts `task migrate` needs to tell, BEFORE it writes,
// what will not survive on the target (the loss table). Capabilities say what the backend can do; traits say how faithfully and within
// which limits. A backend that declares nothing is treated as keeping nothing (the migration never assumes a fidelity nobody promised).

/** What the plan decided for one task of a migration: the facts a backend's cost model needs to count the calls the task will cost. */
export interface MigrationTaskFacts {
	/** `new`: the run creates the task; `resume`: it is already on the target (what is left to do depends on `phase`). */
	state: 'new' | 'resume';
	/**
	 * Required for `resume`, how far the earlier run got (the journal's phase): `created` = the fields, links and comments are left (fields
	 * counted as writes of their own, an upper bound), `fielded` = links and comments, `linked` = comments. Absent for `new`.
	 */
	phase?: 'created' | 'fielded' | 'linked';
	/** The status the task ends in on the target. */
	status: string;
	/** The task has a parent (it is attached to it after it is created). */
	hasParent: boolean;
	type?: string;
	priority?: string;
	assignee?: string;
	/** Plain labels. */
	labels: readonly string[];
	/** Metadata WITHOUT the migration marker. */
	meta: Readonly<Record<string, string>>;
	/** The migration marker is written (the target holds metadata). */
	marker: boolean;
	/** The type of each link the task holds (links are written once both ends exist). */
	links: readonly string[];
	/** Comments to write, the history note included. */
	comments: number;
}

/** What a backend's cost model answers for a set of tasks. */
export interface MigrationCostModelResult {
	/** Requests that change the target (what spacing and a content cap apply to): creates, patches, label creations, links, comments. */
	writes: number;
	/** Every request to the target: the writes, the reads around each write, the label probes and the read-back that checks the run. */
	requests: number;
	/** How many of the requests are the read-back of the final check (their time is a read, not a write). */
	verifyRequests: number;
	/** What the person should know about how the numbers were counted (labels counted as new, priority storage not known...). */
	notes: string[];
}

export interface BackendTraits {
	/** `create({ createdAt })` is stored. False: the system assigns the creation instant (a forge). */
	keepsCreatedAt: boolean;
	/** `addComment(..., { author })` is stored. False: the author is whoever holds the credentials. */
	authoredComments: boolean;
	/** Longest comment text accepted, in characters. Absent: no limit known. */
	commentTextMax?: number;
	/** Longest comment author name accepted. Absent: no limit known. */
	commentAuthorMax?: number;
	/** Longest description accepted (room for what the backend adds to it included). Absent: no limit known. */
	descriptionMax?: number;
	/** Why the backend would refuse this label name (a sentence), or undefined when it accepts it. Absent: every name is accepted. */
	labelProblem?: (label: string) => string | undefined;
	/** Deepest nesting of tasks (a root is level 1). Absent: unlimited. */
	hierarchyDepth?: number;
	/** Most direct children of one task. Absent: unlimited. */
	childrenPerParent?: number;
	/**
	 * Rough cost of one port write (requests and seconds, reads that follow included), for the estimate printed by `task migrate
	 * --dry-run`; `quotaPerHour` is the request budget of the system, when it has one. Absent: free (local).
	 */
	cost?: {
		requests: number;
		seconds: number;
		quotaPerHour?: number;
		read?: { requests: number; seconds: number };
		/**
		 * A read by id that answers the task fields only (`resolve`) when it is cheaper than `read` (the whole record): the final check
		 * of a migration uses it for a task with no link and no comment. Absent: the whole record is read.
		 */
		resolve?: { requests: number; seconds: number };
		/** The cap on requests that change the system, when it has one: what a long migration is bound by, whatever its pace. */
		contentCap?: { perHour: number; perMinute?: number; source: string };
		/**
		 * Counts the calls of the tasks the plan will write, from what the backend really does (a create that carries its fields, a close
		 * that is a call of its own...). Absent: every write the engine counts costs `requests` and `seconds`.
		 */
		model?: (tasks: readonly MigrationTaskFacts[]) => MigrationCostModelResult;
	};
	/**
	 * `createMigrated` writes the type, the labels, the priority (when it is a label) and the metadata in the creation call. The engine
	 * calls it only when this is true (the member is optional and a wrapper that opens the backend late cannot tell it is absent).
	 */
	foldsCreate?: boolean;
}

/** The local file store. */
export const LOCAL_TRAITS: BackendTraits = Object.freeze({
	keepsCreatedAt: true,
	authoredComments: true,
	commentTextMax: 10000,
	commentAuthorMax: 100,
});

/** What a backend that declares no traits is assumed to keep: nothing. */
export const NO_TRAITS: BackendTraits = Object.freeze({
	keepsCreatedAt: false,
	authoredComments: false,
});
