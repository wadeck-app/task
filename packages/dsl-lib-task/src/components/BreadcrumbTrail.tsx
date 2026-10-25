import { ChevronRight } from 'lucide-react';
import React from 'react';

export interface BreadcrumbItem {
	label: string;
	/** An app path; without it the item is plain text. */
	href?: string;
	/** Tooltip (the full title when the label is cut). */
	title?: string;
}

export interface BreadcrumbTrailProps {
	/** From the root to the parent of the current page. */
	items: BreadcrumbItem[];
	separator?: 'slash' | 'chevron';
	/** Above this many items (current label included) the middle ones fold into an ellipsis. 0 = never fold. */
	maxItems?: number;
	/** The last, unlinked element: the page itself. */
	currentLabel?: string;
}

/**
 * The ancestors of the current page as a trail (Jira's `Parent > Child` header).
 *
 * @registryCategory atomic
 * @registryTags breadcrumb ancestors trail navigation
 */
export function BreadcrumbTrail({
	items,
	separator = 'chevron',
	maxItems = 0,
	currentLabel,
}: BreadcrumbTrailProps): React.ReactElement | null {
	const list = Array.isArray(items) ? items : [];
	if (list.length === 0 && !currentLabel) {
		return null;
	}
	const total = list.length + (currentLabel ? 1 : 0);
	let shown: (BreadcrumbItem | 'fold')[] = list;
	let folded: BreadcrumbItem[] = [];
	if (maxItems >= 3 && total > maxItems) {
		// Keep the root, the fold mark and as many trailing items as are left; the current label takes one place.
		const keepTail = Math.max(1, maxItems - 2 - (currentLabel ? 1 : 0));
		folded = list.slice(1, Math.max(1, list.length - keepTail));
		shown = folded.length === 0 ? list : [list[0]!, 'fold', ...list.slice(list.length - keepTail)];
	}
	const sep = (key: string) => (
		<span key={key} data-testid="breadcrumb-separator" aria-hidden="true" className="shrink-0 text-muted">
			{separator === 'slash' ? '/' : <ChevronRight size={14} />}
		</span>
	);
	const nodes: React.ReactNode[] = [];
	shown.forEach((item, index) => {
		if (index > 0) {
			nodes.push(sep(`s${index}`));
		}
		if (item === 'fold') {
			nodes.push(
				<span
					key="fold"
					data-testid="breadcrumb-folded"
					title={folded.map(f => f.label).join(' / ')}
					className="shrink-0 text-muted"
				>
					…
				</span>
			);
			return;
		}
		nodes.push(
			item.href ? (
				<a
					key={`i${index}`}
					href={item.href}
					title={item.title}
					className="min-w-0 max-w-[16rem] truncate text-muted hover:text-content hover:underline"
				>
					{item.label}
				</a>
			) : (
				<span key={`i${index}`} title={item.title} className="min-w-0 max-w-[16rem] truncate text-muted">
					{item.label}
				</span>
			)
		);
	});
	if (currentLabel) {
		if (shown.length > 0) {
			nodes.push(sep('s-current'));
		}
		nodes.push(
			<span key="current" aria-current="page" className="min-w-0 truncate font-medium text-content">
				{currentLabel}
			</span>
		);
	}
	return (
		<nav aria-label="Breadcrumb" data-testid="breadcrumb-trail">
			<div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">{nodes}</div>
		</nav>
	);
}
