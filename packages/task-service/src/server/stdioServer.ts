// `task serve --stdio`: ONE request read from a stream (stdin), ONE answer returned, through the same pipeline as the HTTP server
// (requestHandler.ts). It exists for a caller that can run a command on this machine but cannot open a port: `machine run <peer>`
// runs the allow-listed command and carries the request on its stdin. There is NO token here: the caller is the program that
// started this process, and who may start it is decided outside (the peer is authenticated by `machine` and an admin allowed this
// exact command). Never expose this entry point to something that did not authenticate its caller.
//
// Envelope on stdin (JSON, exactly these keys):  { "method": "GET", "path": "/v1/tasks/abc", "headers": { "X-Task-Protocol": "1" }, "body": <json> }
// Answer on stdout (JSON):                       { "status": 200, "headers": { "X-Task-Protocol": "1" }, "body": <json> }
// `headers` and `body` are optional in the request. A problem with the request itself (not JSON, unknown key, too large) is an
// answer in the same shape (400 / 413), never a stack; business validation is the pipeline's, strict like over HTTP.
import { WireProtocolError, encodeWireError } from '@wadeck-app/task-core';

import type { TaskServiceContext } from '../context.js';
import type { EventSink } from '../events.js';
import { createRequestHandler } from './requestHandler.js';
import type { ServiceRequest, ServiceResponse } from './requestHandler.js';
import { assertServable } from './taskServer.js';

/** What the envelope may add to the body limit (method, path, headers, the JSON quotes). */
export const STDIO_ENVELOPE_ALLOWANCE = 64 * 1024;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface StdioServerOptions {
	/** The served project (any storage but `remote`: {@link assertServable}). */
	ctx: TaskServiceContext;
	/** Where the events of a write are delivered; they are delivered, and flushed, BEFORE the answer is returned. */
	eventSink?: EventSink;
	version?: string;
	now?: () => Date;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Default 1 MiB, the HTTP limit. */
	maxBodyBytes?: number;
}

/** The answer printed on stdout. */
export type StdioAnswer = ServiceResponse;

const ENVELOPE_KEYS = ['method', 'path', 'headers', 'body'] as const;
const USAGE_HINT =
	'Send one JSON object: {"method":"GET","path":"/v1/info","headers":{"X-Task-Protocol":"1"}} ("body" is optional).';

function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(message: string): WireProtocolError {
	return new WireProtocolError('invalid-request', message, USAGE_HINT);
}

/** Reads the stream up to `limit` bytes; `undefined` when it holds more (nothing else is kept). */
async function readAll(source: AsyncIterable<Buffer | string>, limit: number): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of source) {
		const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
		size += buffer.length;
		if (size > limit) return undefined;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/** The request of an envelope, or a WireProtocolError (400) that says what is wrong with it. */
function parseEnvelope(text: string, maxBodyBytes: number): ServiceRequest {
	if (text.trim() === '') throw bad('no request on stdin');
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		throw bad('the request on stdin is not valid JSON');
	}
	if (!isMapping(parsed)) throw bad('the request on stdin must be a JSON object');
	for (const key of Object.keys(parsed)) {
		if (!(ENVELOPE_KEYS as readonly string[]).includes(key)) {
			throw bad(`unknown key "${key}" in the request (allowed: ${ENVELOPE_KEYS.join(', ')})`);
		}
	}
	const { method, path, headers, body } = parsed;
	if (typeof method !== 'string' || method === '') throw bad('"method" must be a text such as "GET"');
	if (typeof path !== 'string' || !path.startsWith('/')) throw bad('"path" must be a text starting with "/"');
	const lowered: Record<string, string | undefined> = {};
	if (headers !== undefined) {
		if (!isMapping(headers)) throw bad('"headers" must be an object of texts');
		for (const [name, value] of Object.entries(headers)) {
			if (typeof value !== 'string') throw bad(`header "${name}" must be a text`);
			lowered[name.toLowerCase()] = value;
		}
	}
	const size = body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body));
	return {
		method,
		path,
		headers: lowered,
		readBody: () => {
			if (size > maxBodyBytes) {
				return Promise.reject(
					new WireProtocolError(
						'too-large',
						`the request body is larger than ${maxBodyBytes} bytes (${size} received)`,
						'Send less data per request.'
					)
				);
			}
			return Promise.resolve(body);
		},
	};
}

/**
 * Serves one request read from `source` and returns the answer. Throws a TaskServerStartError for a project that cannot be served
 * (a process-level failure: the caller prints it on stderr and exits non-zero); every problem of the request itself is an answer.
 */
export async function serveStdioRequest(
	source: AsyncIterable<Buffer | string>,
	options: StdioServerOptions
): Promise<StdioAnswer> {
	assertServable(options.ctx);
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const redact = [options.ctx.storage.dataDir];
	const handler = createRequestHandler({
		ctx: options.ctx,
		eventSink: options.eventSink,
		version: options.version,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.log === undefined ? {} : { log: options.log }),
		redact,
	});
	const refuse = (error: unknown): StdioAnswer => {
		const { status, body } = encodeWireError(error, { redact });
		return { status, headers: {}, body };
	};
	const text = await readAll(source, maxBodyBytes + STDIO_ENVELOPE_ALLOWANCE);
	if (text === undefined) {
		return refuse(
			new WireProtocolError(
				'too-large',
				`the request on stdin is larger than ${maxBodyBytes + STDIO_ENVELOPE_ALLOWANCE} bytes`,
				'Send less data per request.'
			)
		);
	}
	let request: ServiceRequest;
	try {
		request = parseEnvelope(text, maxBodyBytes);
	} catch (error) {
		return refuse(error);
	}
	const answer = await handler.handle(request);
	// Same as over HTTP: the events of the write leave before the caller is answered, and the sink is flushed before the process ends.
	await handler.flushEvents();
	return answer;
}
