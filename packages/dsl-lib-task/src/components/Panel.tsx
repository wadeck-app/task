import { ChevronDown, ChevronRight } from 'lucide-react';
import React, { useId, useState } from 'react';

export interface PanelProps {
	title: string;
	/** A number shown in a small badge next to the title (0 is shown). */
	count?: number;
	/** The header toggles the content. */
	collapsible?: boolean;
	/** Initial state when collapsible. The state then lives in the component, across re-renders of the page. */
	defaultOpen?: boolean;
	/** `card`: bordered box. `plain`: no border, header and content only. `flush`: bordered, no inner padding for the content. */
	appearance?: 'card' | 'plain' | 'flush';
	/**
	 * Controls on the right of the header.
	 * @slot tag:layout, tag:display, tag:composite, tag:atomic
	 */
	actions?: React.ReactNode;
	/**
	 * The content.
	 * @slot tag:layout, tag:table, tag:form, tag:display, tag:composite, tag:atomic
	 */
	items?: React.ReactNode;
}

// @formatter:off
const FRAME: Record<NonNullable<PanelProps['appearance']>, string> = {
	card: 'rounded-lg border border-border bg-surface',
	plain: '',
	flush: 'rounded-lg border border-border bg-surface overflow-hidden',
};
const BODY: Record<NonNullable<PanelProps['appearance']>, string> = {
	card: 'px-4 pb-4',
	plain: 'pt-2',
	flush: '',
};
const HEADER: Record<NonNullable<PanelProps['appearance']>, string> = {
	card: 'px-4 py-3',
	plain: 'py-1',
	flush: 'px-4 py-3',
};
// @formatter:on

/**
 * A titled box with an optional count, header actions and a collapsible body.
 *
 * @registryCategory disposition
 * @registryTags panel section card collapsible
 */
export function Panel({
	title,
	count,
	collapsible = false,
	defaultOpen = true,
	appearance = 'card',
	actions,
	items,
}: PanelProps): React.ReactElement {
	const [open, setOpen] = useState(defaultOpen);
	const bodyId = useId();
	const expanded = !collapsible || open;
	const heading = (
		<>
			{collapsible ? (
				expanded ? (
					<ChevronDown size={14} aria-hidden="true" className="shrink-0 text-muted" />
				) : (
					<ChevronRight size={14} aria-hidden="true" className="shrink-0 text-muted" />
				)
			) : null}
			<span className="truncate text-sm font-semibold text-content">{title}</span>
			{count === undefined || count === null ? null : (
				<span
					data-testid="panel-count"
					className="rounded-full bg-muted-bg px-1.5 py-0.5 text-xs font-medium text-muted"
				>
					{count}
				</span>
			)}
		</>
	);
	return (
		<section data-testid="panel" className={FRAME[appearance]}>
			<div className={`flex items-center justify-between gap-2 ${HEADER[appearance]}`}>
				{collapsible ? (
					<button
						type="button"
						aria-expanded={expanded}
						aria-controls={bodyId}
						onClick={() => setOpen(value => !value)}
						className="flex min-w-0 flex-1 items-center gap-2 text-left"
					>
						{heading}
					</button>
				) : (
					<div className="flex min-w-0 flex-1 items-center gap-2">{heading}</div>
				)}
				{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
			</div>
			{expanded ? (
				<div id={bodyId} className={BODY[appearance]}>
					{items}
				</div>
			) : null}
		</section>
	);
}
