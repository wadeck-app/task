import { CornerDownRight } from 'lucide-react';
import React from 'react';
import { PILL_RADIUS } from '../ui/tokens.js';
import { TONE_DOT, TONE_PILL, toneOf } from '../tones.js';
import { shortDate } from './cardLayout.js';
import type { CardFieldLayout, TitleLines } from './cardLayout.js';
import type { BoardCardData } from './boardModel.js';

/** The class of the title for each number of lines (literal strings: the stylesheet scan is static). */
export const TITLE_CLAMP: Record<TitleLines, string> = {
	1: 'line-clamp-1',
	2: 'line-clamp-2',
	3: 'line-clamp-3',
};

function priorityTone(priority: string): 'danger' | 'warning' | 'neutral' {
	const key = priority.toLowerCase();
	return key === 'urgent' ? 'danger' : key === 'high' ? 'warning' : 'neutral';
}

/** One or two capital letters of a name: the first letters of its first two words (split on space, dot, dash, underscore, at). */
export function initialsOf(name: string): string {
	const words = name.split(/[\s._@-]+/).filter(word => word !== '');
	return words
		.slice(0, 2)
		.map(word => word.charAt(0).toUpperCase())
		.join('');
}

const FIELD_BASE = 'shrink-0';

/**
 * One field of a card, or null when the card has nothing for it (a missing assignee, parent or date draws nothing, never a
 * placeholder). `showStatus` is what the `auto` style of the status looks at: the column holds several statuses.
 */
export function renderCardField(
	entry: CardFieldLayout,
	card: BoardCardData,
	showStatus: boolean
): React.ReactElement | null {
	switch (entry.field) {
		case 'id':
			return (
				<span data-testid="card-field-id" className={`${FIELD_BASE} font-mono text-xs text-muted`}>
					{card.id}
				</span>
			);
		case 'priority': {
			if (card.priority === undefined || card.priority === '') {
				return null;
			}
			const text = card.priorityText ?? card.priority;
			if (entry.style === 'text') {
				return (
					<span data-testid="card-field-priority" data-style="text" className={`${FIELD_BASE} text-muted`}>
						{text}
					</span>
				);
			}
			if (entry.style === 'dot') {
				return (
					<span
						data-testid="card-field-priority"
						data-style="dot"
						role="img"
						title={text}
						aria-label={`Priority: ${text}`}
						className={`inline-block h-2 w-2 ${FIELD_BASE} ${PILL_RADIUS} ${TONE_DOT[priorityTone(card.priority)]}`}
					/>
				);
			}
			return (
				<span
					data-testid="card-field-priority"
					data-style="pill"
					className={`inline-flex ${FIELD_BASE} items-center ${PILL_RADIUS} px-2 text-xs font-medium ${TONE_PILL[priorityTone(card.priority)]}`}
				>
					{text}
				</span>
			);
		}
		case 'assignee': {
			if (card.assignee === undefined || card.assignee === '') {
				return null;
			}
			if (entry.style === 'initials') {
				return (
					<span
						data-testid="card-field-assignee"
						data-style="initials"
						role="img"
						title={card.assignee}
						aria-label={`Assignee: ${card.assignee}`}
						className={`inline-flex h-5 min-w-[1.25rem] ${FIELD_BASE} items-center justify-center ${PILL_RADIUS} bg-muted-bg px-1 text-xs font-medium text-content`}
					>
						{initialsOf(card.assignee)}
					</span>
				);
			}
			return (
				<span data-testid="card-field-assignee" data-style="text" className={`${FIELD_BASE} text-muted`}>
					{card.assignee}
				</span>
			);
		}
		case 'status': {
			const status = card.status ?? '';
			if (status === '' || (entry.style === 'auto' && !showStatus)) {
				return null;
			}
			const tone = toneOf(card.tone);
			if (entry.style === 'dot') {
				return (
					<span
						data-testid="card-field-status"
						data-style="dot"
						role="img"
						title={status}
						aria-label={`Status: ${status}`}
						className={`inline-block h-2 w-2 ${FIELD_BASE} ${PILL_RADIUS} ${TONE_DOT[tone]}`}
					/>
				);
			}
			return (
				<span
					data-testid="card-field-status"
					data-style={entry.style === 'pill' ? 'pill' : 'auto'}
					className={`inline-flex ${FIELD_BASE} items-center ${PILL_RADIUS} px-2 text-xs font-medium ${TONE_PILL[tone]}`}
				>
					{status}
				</span>
			);
		}
		case 'created': {
			const day = shortDate(card.createdAt);
			return day === undefined ? null : (
				<span data-testid="card-field-created" title={`Created ${card.createdAt}`} className={`${FIELD_BASE} text-muted`}>
					{day}
				</span>
			);
		}
		case 'statusSince': {
			const day = shortDate(card.statusSince);
			return day === undefined ? null : (
				<span
					data-testid="card-field-statusSince"
					title={`In this status since ${card.statusSince}`}
					className={`${FIELD_BASE} text-muted`}
				>
					{`since ${day}`}
				</span>
			);
		}
		case 'parent':
			return card.parentId === undefined || card.parentId === '' ? null : (
				<span
					data-testid="card-field-parent"
					title={`Parent task ${card.parentId}`}
					className={`inline-flex ${FIELD_BASE} items-center gap-1 font-mono text-muted`}
				>
					<CornerDownRight size={12} aria-hidden="true" />
					{card.parentId}
				</span>
			);
	}
}
