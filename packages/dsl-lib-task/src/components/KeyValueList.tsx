import React from 'react';

export interface KeyValueEntry {
	key: string;
	value: string;
}

export interface KeyValueListProps {
	/** The pairs, in the order to show them. */
	entries: KeyValueEntry[];
	/** Row spacing. */
	density?: 'compact' | 'comfortable';
	/** Shown when there is no entry; without it nothing is drawn. */
	emptyText?: string;
}

/**
 * Free-form key / value pairs (metadata, custom fields): keys in monospace, values wrapped.
 *
 * IN SCOPE: a read-only list of data pairs. OUT OF SCOPE: editing, typed values.
 *
 * @registryCategory atomic
 * @registryTags key value metadata properties
 */
export function KeyValueList({
	entries,
	density = 'compact',
	emptyText,
}: KeyValueListProps): React.ReactElement | null {
	if (entries.length === 0) {
		return emptyText ? <p className="text-sm text-muted">{emptyText}</p> : null;
	}
	return (
		<dl
			data-testid="key-value-list"
			data-density={density}
			className={`m-0 flex flex-col ${density === 'compact' ? 'gap-1' : 'gap-2'} text-sm`}
		>
			{entries.map(entry => (
				<div key={entry.key} className="flex min-w-0 items-baseline gap-2">
					<dt className="shrink-0 font-mono text-xs text-muted">{entry.key}</dt>
					<dd title={entry.value} className="m-0 min-w-0 break-words text-content">
						{entry.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
