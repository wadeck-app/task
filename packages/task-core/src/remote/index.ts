// Barrel of the remote protocol (re-exported by ../index.ts): the route table and the typed errors on the wire.
export {
	API_PREFIX,
	EVENTS_HEADER,
	EVENTS_SUPPRESS,
	PORT_OPERATIONS,
	PROTOCOL_HEADER,
	PROTOCOL_MAX,
	PROTOCOL_MIN,
	PROTOCOL_VERSION,
	ProtocolPathError,
	ROUTES,
	buildRequest,
	matchRoute,
	routeFor,
} from './protocol.js';
export type {
	EventsOutcome,
	HttpMethod,
	PortOperation,
	ProtocolOperation,
	RouteMatch,
	RouteSpec,
	ServerInfo,
	WriteEnvelope,
} from './protocol.js';
export { WireProtocolError, decodeWireError, encodeWireError } from './wireErrors.js';
export type { DecodeContext, EncodeOptions, ProtocolFailureType, WireErrorBody, WireErrorType } from './wireErrors.js';
