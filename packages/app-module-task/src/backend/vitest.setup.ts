// Safety net: no test may push to a real queue. The packaged module that backend.realServer.integration.test.ts spawns
// builds the default event sink (the sink cannot be injected there), which would find the daemon of the machine running
// the tests or start it with `queue start`. QUEUE_SDK_OFF=1 makes the SDK send, start and report nothing (every call
// answers `dropped`), and child processes spawned by tests inherit it.
process.env['QUEUE_SDK_OFF'] = '1';
