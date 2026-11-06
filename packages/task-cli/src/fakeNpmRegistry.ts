// Test helper (never imported by shipped code): a tiny npm registry on a loopback port, enough for `npm view` and
// `npm install -g` of fake packages, with a tarball that can be made to hang so a test can kill npm mid-install.
//
// Why not shared-updater's MockRegistry: its dist/ references a mock-registry-server.mjs that the published package does
// not contain (checked in node_modules/@wadeck-app/shared-updater@2026.10.25-020), so it cannot start.
//
// The registry runs in the test process: a test must therefore spawn npm / the updater ASYNCHRONOUSLY (a spawnSync
// would block the event loop that has to answer npm).
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';

/** How the tarball request of a hung version behaves. */
export type TarballHang = 'no-body' | 'half-body';

interface PublishedVersion {
	tarball: Buffer;
	integrity: string;
	shasum: string;
}

export interface FakeNpmRegistry {
	/** `http://127.0.0.1:<port>/` (trailing slash, the form npm expects). */
	url: string;
	/** Publishes `name@version` with these files (path -> content; `package.json` is generated). */
	publish(name: string, version: string, files?: Record<string, string>): void;
	/** Makes `latest` point at `version`. */
	setLatest(name: string, version: string): void;
	/** Makes the tarball request of `name@version` hang after answering 200 (`undefined` clears it). */
	hangTarball(name: string, version: string, mode: TarballHang | undefined): void;
	/** Resolves when a request for the tarball of `name@version` has arrived (hung or not). */
	tarballRequested(name: string, version: string, timeoutMs?: number): Promise<void>;
	close(): Promise<void>;
}

/** A gzipped ustar archive with every file under `package/` (what npm expects of a tarball). */
export function buildTarball(files: Record<string, string>): Buffer {
	const blocks: Buffer[] = [];
	for (const [name, content] of Object.entries(files)) {
		const body = Buffer.from(content);
		const header = Buffer.alloc(512);
		const full = `package/${name}`;
		if (Buffer.byteLength(full) > 100)
			throw new Error(`tarball entry name too long for the minimal writer: ${full}`);
		header.write(full, 0, 'utf8');
		header.write('0000644\0', 100);
		header.write('0000000\0', 108);
		header.write('0000000\0', 116);
		header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
		header.write('00000000000\0', 136);
		header.write('        ', 148);
		header.write('0', 156);
		header.write('ustar\0', 257);
		header.write('00', 263);
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
		blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(blocks));
}

export async function startFakeNpmRegistry(): Promise<FakeNpmRegistry> {
	const versions = new Map<string, Map<string, PublishedVersion>>();
	const latest = new Map<string, string>();
	const hung = new Map<string, TarballHang>();
	const requested = new Map<string, Array<() => void>>();
	const requestedKeys = new Set<string>();
	const sockets = new Set<import('node:net').Socket>();
	let baseUrl = '';

	const key = (name: string, version: string): string => `${name}@${version}`;

	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
		// Tarball: /<name>/-/<unscoped>-<version>.tgz
		const tgz = /^\/(.+)\/-\/[^/]+?-(\d[^/]*)\.tgz$/.exec(url);
		if (tgz) {
			const [, name, version] = tgz as unknown as [string, string, string];
			const published = versions.get(name)?.get(version);
			requestedKeys.add(key(name, version));
			for (const resolve of requested.get(key(name, version)) ?? []) resolve();
			if (!published) {
				res.writeHead(404).end(`fake registry: ${name}@${version} was not published`);
				return;
			}
			const mode = hung.get(key(name, version));
			res.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-length': published.tarball.length,
			});
			if (mode === 'no-body') return;
			if (mode === 'half-body') {
				res.write(published.tarball.subarray(0, Math.floor(published.tarball.length / 2)));
				return;
			}
			res.end(published.tarball);
			return;
		}
		// Packument: /<name>
		const name = url.slice(1);
		const published = versions.get(name);
		if (!published) {
			res.writeHead(404, { 'content-type': 'application/json' }).end(
				JSON.stringify({ error: `not found: ${name}` })
			);
			return;
		}
		const tag = latest.get(name);
		const doc = {
			name,
			'dist-tags': tag === undefined ? {} : { latest: tag },
			versions: Object.fromEntries(
				[...published].map(([version, v]) => [
					version,
					{
						name,
						version,
						dist: {
							tarball: `${baseUrl}${name}/-/${name.split('/').pop()}-${version}.tgz`,
							integrity: v.integrity,
							shasum: v.shasum,
						},
					},
				])
			),
		};
		res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
	});
	server.on('connection', socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

	return {
		url: baseUrl,
		publish(name, version, files = {}) {
			const tarball = buildTarball({ 'package.json': JSON.stringify({ name, version }), ...files });
			const perPackage = versions.get(name) ?? new Map<string, PublishedVersion>();
			perPackage.set(version, {
				tarball,
				integrity: `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`,
				shasum: crypto.createHash('sha1').update(tarball).digest('hex'),
			});
			versions.set(name, perPackage);
		},
		setLatest: (name, version) => void latest.set(name, version),
		hangTarball(name, version, mode) {
			if (mode === undefined) hung.delete(key(name, version));
			else hung.set(key(name, version), mode);
		},
		tarballRequested(name, version, timeoutMs = 30_000) {
			if (requestedKeys.has(key(name, version))) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(new Error(`no request for the tarball of ${key(name, version)} within ${timeoutMs} ms`)),
					timeoutMs
				);
				const list = requested.get(key(name, version)) ?? [];
				list.push(() => {
					clearTimeout(timer);
					resolve();
				});
				requested.set(key(name, version), list);
			});
		},
		close() {
			for (const socket of sockets) socket.destroy();
			return new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}
