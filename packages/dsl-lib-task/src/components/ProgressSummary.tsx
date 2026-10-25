import React from 'react';

export interface ProgressSummaryProps {
	/** How many are finished. */
	done: number;
	/** How many there are. */
	total: number;
	/** The sentence. Default `<done> of <total> done`. */
	text?: string;
	/** `bar`: a filled bar. `segments`: one block per item. `ring`: a circle with the percentage. `text`: the sentence only. */
	appearance?: 'bar' | 'segments' | 'ring' | 'text';
	/** Colour of the finished part. */
	tone?: 'success' | 'info' | 'primary';
}

// @formatter:off
const FILL: Record<NonNullable<ProgressSummaryProps['tone']>, string> = {
	success: 'bg-success',
	info: 'bg-info-text',
	primary: 'bg-primary',
};
const STROKE: Record<NonNullable<ProgressSummaryProps['tone']>, string> = {
	success: 'stroke-success',
	info: 'stroke-info-text',
	primary: 'stroke-primary',
};
// @formatter:on

const RING_RADIUS = 16;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
// More segments than this would be unreadable blocks: fall back to the bar.
const MAX_SEGMENTS = 30;

/**
 * Shows how far a set of items is done (sub-tasks of a task).
 *
 * @registryCategory atomic
 * @registryTags progress children summary
 */
export function ProgressSummary({
	done,
	total,
	text,
	appearance = 'bar',
	tone = 'success',
}: ProgressSummaryProps): React.ReactElement {
	const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
	const safeDone = Number.isFinite(done) && done > 0 ? Math.min(Math.floor(done), safeTotal) : 0;
	const percent = safeTotal === 0 ? 0 : Math.round((safeDone / safeTotal) * 100);
	const sentence = text ?? (safeTotal === 0 ? 'Nothing to do' : `${safeDone} of ${safeTotal} done`);
	const label = <span className="text-sm text-muted">{sentence}</span>;
	const aria = {
		role: 'progressbar',
		'aria-valuemin': 0,
		'aria-valuenow': safeDone,
		'aria-valuemax': safeTotal,
		'aria-label': sentence,
	} as const;

	if (appearance === 'text') {
		return <div data-testid="progress-summary">{label}</div>;
	}
	if (appearance === 'ring') {
		return (
			<div data-testid="progress-summary" className="flex items-center gap-3">
				<div {...aria} className="relative h-10 w-10 shrink-0">
					<svg viewBox="0 0 40 40" className="h-10 w-10 -rotate-90">
						<circle cx="20" cy="20" r={RING_RADIUS} fill="none" strokeWidth="4" className="stroke-border" />
						<circle
							cx="20"
							cy="20"
							r={RING_RADIUS}
							fill="none"
							strokeWidth="4"
							strokeLinecap="round"
							strokeDasharray={RING_LENGTH}
							strokeDashoffset={RING_LENGTH * (1 - percent / 100)}
							className={STROKE[tone]}
						/>
					</svg>
					<span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-content">
						{percent}%
					</span>
				</div>
				{label}
			</div>
		);
	}
	if (appearance === 'segments' && safeTotal > 0 && safeTotal <= MAX_SEGMENTS) {
		return (
			<div data-testid="progress-summary" className="flex flex-col gap-1.5">
				<div {...aria} className="flex gap-1">
					{Array.from({ length: safeTotal }, (_, i) => (
						<span
							key={i}
							data-testid="progress-segment"
							data-done={i < safeDone}
							className={`h-2 flex-1 rounded-sm ${i < safeDone ? FILL[tone] : 'bg-muted-bg'}`}
						/>
					))}
				</div>
				{label}
			</div>
		);
	}
	return (
		<div data-testid="progress-summary" className="flex flex-col gap-1.5">
			<div {...aria} className="h-2 w-full overflow-hidden rounded-full bg-muted-bg">
				<div className={`h-full rounded-full ${FILL[tone]}`} style={{ width: `${percent}%` }} />
			</div>
			{label}
		</div>
	);
}
