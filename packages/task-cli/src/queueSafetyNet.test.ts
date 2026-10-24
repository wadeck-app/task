// vitest.setup.ts switches the queue SDK off, also for the CLI processes this suite spawns: see that file.
describe('queue safety net', () => {
	it('sets QUEUE_SDK_OFF=1 for the tests', () => {
		expect(process.env['QUEUE_SDK_OFF']).toBe('1');
	});
});
