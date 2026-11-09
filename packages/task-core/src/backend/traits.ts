// What a backend keeps and where its limits are, beyond the capabilities: the facts `task migrate` needs to tell, BEFORE it writes,
// what will not survive on the target (the loss table). Capabilities say what the backend can do; traits say how faithfully and within
// which limits. A backend that declares nothing is treated as keeping nothing (the migration never assumes a fidelity nobody promised).

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
	cost?: { requests: number; seconds: number; quotaPerHour?: number; read?: { requests: number; seconds: number } };
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
