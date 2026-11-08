// Comment commands: comment, comments, comment-edit, comment-rm. Parsing and output only: the rules live in task-service.
import { addComment, deliverEvents, editComment, listComments, removeComment } from '@wadeck-app/task-service';
import type { TaskComment } from '@wadeck-app/task-core';

import type { ProjectCommand } from '../cli/env.js';
import { errorOutput, failure, jsonResult } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';
import { readTextSource } from '../cli/readText.js';

const COMMENT_USAGE =
	'Usage: task comment <id> <text...> [--file <path|->] [--author <name>] [--json]\n' +
	'Words are joined with a space; put -- before a text that starts with --. --file reads the text from a file, or from standard input with -.';
const COMMENTS_USAGE = 'Usage: task comments <id> [--json]';
const EDIT_USAGE =
	'Usage: task comment-edit <id> <comment-id> <text...> [--file <path|->] [--json]\n' +
	'List the comment ids with: task comments <id>';
const REMOVE_USAGE = 'Usage: task comment-rm <id> <comment-id> [--json]\nList the comment ids with: task comments <id>';

interface ParsedCommentArgs {
	/** The non-flag words in order: the ids first, then the words of the text. */
	positionals: string[];
	file: string | undefined;
	author: string | undefined;
}

/** Flags `--file <source>` and (when allowed) `--author <name>` anywhere; after `--` every word is text. */
function parseCommentArgs(
	rest: string[],
	usage: string,
	allowAuthor: boolean,
	jsonMode: boolean
): ParsedCommentArgs | CommandResult {
	const parsed: ParsedCommentArgs = { positionals: [], file: undefined, author: undefined };
	let literal = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (literal || !arg.startsWith('--') || arg === '--') {
			if (!literal && arg === '--') {
				literal = true;
			} else {
				parsed.positionals.push(arg);
			}
		} else if (arg === '--file') {
			parsed.file = rest[++i];
			if (!parsed.file) {
				return errorOutput(jsonMode, '--file requires a path (or - for standard input)', usage);
			}
		} else if (allowAuthor && arg === '--author') {
			parsed.author = rest[++i];
			if (!parsed.author) {
				return errorOutput(jsonMode, '--author requires a name', usage);
			}
		} else {
			return errorOutput(jsonMode, `unknown flag: ${arg}`, usage);
		}
	}
	return parsed;
}

/** The text of the command: the words, or the file. Throws an Error (message = what to fix) when neither or both. */
function commentText(words: string[], file: string | undefined): string | undefined {
	if (file !== undefined) {
		if (words.length > 0) {
			throw new Error('the text and --file cannot be combined');
		}
		return readTextSource(file, undefined, 'comment');
	}
	return words.length === 0 ? undefined : words.join(' ');
}

export const runComment: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const parsed = parseCommentArgs(rest, COMMENT_USAGE, true, jsonMode);
	if ('exitCode' in parsed) return parsed;
	const [id, ...words] = parsed.positionals;
	if (!id) {
		return errorOutput(jsonMode, 'missing id', COMMENT_USAGE);
	}
	let text: string | undefined;
	try {
		text = commentText(words, parsed.file);
	} catch (error) {
		return errorOutput(jsonMode, error instanceof Error ? error.message : String(error), COMMENT_USAGE);
	}
	if (text === undefined) {
		return errorOutput(jsonMode, 'missing text', COMMENT_USAGE);
	}
	let result: Awaited<ReturnType<typeof addComment>>;
	try {
		result = await addComment(ctx, { id, text, ...(parsed.author === undefined ? {} : { author: parsed.author }) });
	} catch (error) {
		return failure(jsonMode, error);
	}
	await deliverEvents(eventSink, result.events);
	return jsonMode
		? jsonResult({ taskId: result.task.id, comment: result.comment })
		: { exitCode: 0, output: `Comment ${result.comment.id} added to task ${result.task.id}` };
};

/** "2026-11-08 14:17": the UTC minute. */
function minute(iso: string): string {
	return iso.slice(0, 16).replace('T', ' ');
}

function commentBlock(comment: TaskComment): string {
	const who = [comment.author, comment.editedAt === undefined ? undefined : '(edited)'].filter(Boolean).join(' ');
	const header = [comment.id, minute(comment.at), who].filter(part => part !== '').join('  ');
	return [header, ...comment.text.split('\n').map(line => (line === '' ? '' : `  ${line}`))].join('\n');
}

export const runComments: ProjectCommand = async (rest, { jsonMode, ctx }) => {
	const id = rest[0];
	if (!id) {
		return errorOutput(jsonMode, 'missing id', COMMENTS_USAGE);
	}
	if (rest.length > 1) {
		return errorOutput(jsonMode, `unexpected argument: ${rest[1]}`, COMMENTS_USAGE);
	}
	try {
		const { id: taskId, comments } = await listComments(ctx, { id });
		if (jsonMode) return jsonResult(comments);
		return {
			exitCode: 0,
			output: comments.length === 0 ? `No comments on task ${taskId}.` : comments.map(commentBlock).join('\n\n'),
		};
	} catch (error) {
		return failure(jsonMode, error);
	}
};

export const runCommentEdit: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const parsed = parseCommentArgs(rest, EDIT_USAGE, false, jsonMode);
	if ('exitCode' in parsed) return parsed;
	const [id, commentId, ...words] = parsed.positionals;
	if (!id || !commentId) {
		return errorOutput(jsonMode, 'missing arguments', EDIT_USAGE);
	}
	let text: string | undefined;
	try {
		text = commentText(words, parsed.file);
	} catch (error) {
		return errorOutput(jsonMode, error instanceof Error ? error.message : String(error), EDIT_USAGE);
	}
	if (text === undefined) {
		return errorOutput(jsonMode, 'missing text', EDIT_USAGE);
	}
	let result: Awaited<ReturnType<typeof editComment>>;
	try {
		result = await editComment(ctx, { id, commentId, text });
	} catch (error) {
		return failure(jsonMode, error);
	}
	await deliverEvents(eventSink, result.events);
	const changed = result.events.length > 0;
	return jsonMode
		? jsonResult({ taskId: result.task.id, comment: result.comment, changed })
		: {
				exitCode: 0,
				output: `Comment ${result.comment.id} ${changed ? 'edited on' : 'unchanged on'} task ${result.task.id}`,
			};
};

export const runCommentRemove: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const [id, commentId] = rest;
	if (!id || !commentId) {
		return errorOutput(jsonMode, 'missing arguments', REMOVE_USAGE);
	}
	if (rest.length > 2) {
		return errorOutput(jsonMode, `unexpected argument: ${rest[2]}`, REMOVE_USAGE);
	}
	let result: Awaited<ReturnType<typeof removeComment>>;
	try {
		result = await removeComment(ctx, { id, commentId });
	} catch (error) {
		return failure(jsonMode, error);
	}
	await deliverEvents(eventSink, result.events);
	return jsonMode
		? jsonResult({ taskId: result.task.id, comment: result.comment })
		: { exitCode: 0, output: `Comment ${result.comment.id} removed from task ${result.task.id}` };
};
