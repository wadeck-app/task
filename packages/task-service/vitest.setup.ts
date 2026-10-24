// Safety net: no test may push to a real queue. A test that builds the default event sink (no injected publisher) would
// otherwise find the daemon of the machine running the tests, or start it with `queue start`. QUEUE_SDK_OFF=1 makes the
// SDK send, start and report nothing (every call answers `dropped`), and child processes spawned by tests inherit it.
// Tests of the real SDK path (queueEventSink.integration.test.ts) remove it for their own duration and talk to the SDK
// fake daemon only.
process.env['QUEUE_SDK_OFF'] = '1';
