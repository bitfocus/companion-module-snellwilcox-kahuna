/**
 * KahunaPlugin.test.ts
 *
 * Unit tests for KahunaPlugin covering:
 *   - configure() validation (IP, ports)
 *   - requestTally() return value
 *   - triggerMacro() validation and queuing
 *   - destroy() lifecycle event
 *   - Tally stream parsing (processField / receivedTallyData)
 *   - Command response handling (OK, ERROR, unknown, multi-stage)
 *   - cmd_status / tally_status event forwarding
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KahunaPlugin } from './kahuna_plugin.js'
import { KahunaCommand } from './kahuna_command.js'
import { MacroStage, type KahunaConfig, type MacroMessage } from './kahuna.types.js'

// ─── Mock TCPHelper ───────────────────────────────────────────────────────────
//
// vi.hoisted() runs before vi.mock() hoisting, so MockTCPHelper and
// mockInstances are available inside the mock factory below.

const { MockTCPHelper, mockInstances } = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { EventEmitter } = require('node:events') as typeof import('node:events')
	const mockInstances: MockTCPHelper[] = []

	class MockTCPHelper extends EventEmitter {
		isConnected = false
		isDestroyed = false
		sendAsync = vi.fn().mockResolvedValue(true)
		destroy = vi.fn(() => {
			this.isDestroyed = true
		})

		/** Simulate the mixer accepting the TCP connection. */
		simulateConnect(): void {
			this.isConnected = true
			this.emit('connect')
		}
		/** Simulate the mixer closing the connection. */
		simulateEnd(): void {
			this.isConnected = false
			this.emit('end')
		}
		/** Simulate raw bytes arriving from the mixer. */
		simulateData(buf: Buffer): void {
			this.emit('data', buf)
		}
		/** Simulate a socket error. */
		simulateError(err: Error): void {
			this.emit('error', err)
		}
		/** Simulate a TCPHelper status_change event. */
		simulateStatusChange(status: string, message?: string): void {
			this.emit('status_change', status, message)
		}
	}

	return { MockTCPHelper, mockInstances }
})

vi.mock('@companion-module/base', () => ({
	// Must use `function` (not an arrow function) so `new TCPHelper()` works.
	TCPHelper: vi.fn().mockImplementation(function () {
		const instance = new MockTCPHelper()
		mockInstances.push(instance)
		return instance
	}),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal ModuleLogger stub — all methods are no-ops. */
const makeLogger = () => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
})

/** Valid config used as a baseline throughout the tests. */
const VALID_CONFIG: KahunaConfig = { ip: '192.168.1.100', cmdPort: 9990, tallyPort: 9991 }

/**
 * Build the raw 19 bytes of a 0x84 tally field (no terminator).
 * Layout: [0x84, 0x80, 0x00×16, tallyValue]
 */
function makeTallyField(tallyValue: number): Buffer {
	const field = Buffer.alloc(19, 0x00)
	field[0] = 0x84 // first control byte — identifies a tally message
	field[1] = 0x80 // second control byte
	field[18] = tallyValue // tally number; data byte so must be < 0x80
	return field
}

/**
 * Build a binary tally buffer that the parser will process as a complete
 * 0x84 field carrying `tallyValue` at byte 18.
 *
 * The trailing 0x80 signals to the parser that the field is complete
 * (pos < this.tallyBuffer.length is true).  Only suitable for a single
 * isolated field — for consecutive fields use makeTallyField() directly so
 * that the next field's first 0x84 byte acts as the natural terminator.
 */
function makeTallyBuffer(tallyValue: number): Buffer {
	return Buffer.concat([makeTallyField(tallyValue), Buffer.from([0x80])])
}

/** Build an OK response buffer as the mixer sends it. */
const OK_BUF = Buffer.from('OK\r\n', 'ascii')

/** Build a raw ERROR response buffer. */
const ERROR_BUF = Buffer.from('ERROR: bad macro\r\n', 'ascii')

/** Build a KahunaCommand with a LOAD → TRIGGER sequence. */
function makeCommand(project: number, macro: number): KahunaCommand {
	const stages = [MacroStage.LOAD, MacroStage.TRIGGER]
	const msg: MacroMessage = {
		project,
		macro,
		getNumberStages: () => stages.length,
		getStage: (i: number) => {
			const s = stages[i]
			if (s === undefined) throw new RangeError(`out of range: ${i}`)
			return s
		},
	}
	return new KahunaCommand(msg)
}

/**
 * Flush all pending microtasks so that async helpers like sendNextCommand()
 * (which is called with `void`) have a chance to complete before assertions.
 */
const flushMicrotasks = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
	mockInstances.length = 0
	vi.clearAllMocks()
})

// ─── configure() — IP validation ─────────────────────────────────────────────

describe('configure — IP validation', () => {
	it('accepts a valid IPv4 address', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure(VALID_CONFIG, makeLogger())).not.toThrow()
	})

	it('accepts the loopback address 127.0.0.1', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: '127.0.0.1' }, makeLogger())).not.toThrow()
	})

	it('accepts boundary IPv4 address 0.0.0.0', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: '0.0.0.0' }, makeLogger())).not.toThrow()
	})

	it('accepts boundary IPv4 address 255.255.255.255', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: '255.255.255.255' }, makeLogger())).not.toThrow()
	})

	it('accepts a simple hostname', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: 'kahuna-mixer' }, makeLogger())).not.toThrow()
	})

	it('accepts a dotted hostname', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: 'mixer.broadcast.local' }, makeLogger())).not.toThrow()
	})

	it('throws TypeError for an empty string', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: '' }, makeLogger())).toThrow(TypeError)
	})

	it('throws TypeError for an octet out of range (256)', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: '192.168.1.256' }, makeLogger())).toThrow(TypeError)
	})

	it('throws TypeError for too many octets', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: '192.168.1.1.1' }, makeLogger())).toThrow(TypeError)
	})

	it('throws TypeError for too few octets', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: '192.168.1' }, makeLogger())).toThrow(TypeError)
	})

	it('throws TypeError for a bare number', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: '12345' }, makeLogger())).toThrow(TypeError)
	})

	it('throws TypeError for an IP with a trailing dot', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, ip: '192.168.1.1.' }, makeLogger())).toThrow(TypeError)
	})
})

// ─── configure() — port validation ───────────────────────────────────────────

describe('configure — port validation', () => {
	it('accepts port 1 (minimum valid port)', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, cmdPort: 1, tallyPort: 2 }, makeLogger())).not.toThrow()
	})

	it('accepts port 65535 (maximum valid port)', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, cmdPort: 65534, tallyPort: 65535 }, makeLogger())).not.toThrow()
	})

	it('throws RangeError when cmdPort is 0', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, cmdPort: 0 }, makeLogger())).toThrow(RangeError)
	})

	it('throws RangeError when cmdPort is negative', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, cmdPort: -1 }, makeLogger())).toThrow(RangeError)
	})

	it('throws RangeError when cmdPort exceeds 65535', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, cmdPort: 65536 }, makeLogger())).toThrow(RangeError)
	})

	it('throws RangeError when cmdPort is a float', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, cmdPort: 80.5 }, makeLogger())).toThrow(RangeError)
	})

	it('throws RangeError when cmdPort is NaN', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, cmdPort: NaN }, makeLogger())).toThrow(RangeError)
	})

	it('throws RangeError when tallyPort is 0', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, tallyPort: 0 }, makeLogger())).toThrow(RangeError)
	})

	it('throws RangeError when tallyPort exceeds 65535', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, tallyPort: 65536 }, makeLogger())).toThrow(RangeError)
	})

	it('throws RangeError when tallyPort is a float', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, tallyPort: 9991.5 }, makeLogger())).toThrow(RangeError)
	})

	it('throws RangeError when cmdPort and tallyPort are the same', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, cmdPort: 9990, tallyPort: 9990 }, makeLogger())).toThrow(
			RangeError,
		)
	})

	it('throws RangeError with a message naming the duplicate port', () => {
		const plugin = new KahunaPlugin()
		expect(() => plugin.configure({ ...VALID_CONFIG, cmdPort: 9990, tallyPort: 9990 }, makeLogger())).toThrow(/9990/)
	})
})

// ─── requestTally() ───────────────────────────────────────────────────────────

describe('requestTally', () => {
	it('returns -1 before any tally data has been received (tallyNumber starts at 0)', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		expect(plugin.requestTally()).toBe(-1)
	})

	it('returns the most recently received tally number minus 1', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		// Directly set internal tally state to simulate a received tally.
		;(plugin as unknown as { tallyNumber: number }).tallyNumber = 5
		expect(plugin.requestTally()).toBe(4)
	})

	it('returns 0 when the device reports tally source 1', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		;(plugin as unknown as { tallyNumber: number }).tallyNumber = 1
		expect(plugin.requestTally()).toBe(0)
	})
})

// ─── triggerMacro() — validation ─────────────────────────────────────────────

describe('triggerMacro — validation', () => {
	it('does not throw for valid integer arguments', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		expect(() => plugin.triggerMacro(1, 5)).not.toThrow()
	})

	it('does not throw for project=0 and macro=0', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		expect(() => plugin.triggerMacro(0, 0)).not.toThrow()
	})

	it('does not throw for negative integers', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		// Negative values pass integer validation; the mixer will reject the
		// resulting wire string, which is the correct place for that failure.
		expect(() => plugin.triggerMacro(-1, -1)).not.toThrow()
	})

	it('throws TypeError when project is a float', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		expect(() => plugin.triggerMacro(1.5, 5)).toThrow(TypeError)
	})

	it('throws TypeError when macro is a float', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		expect(() => plugin.triggerMacro(1, 5.5)).toThrow(TypeError)
	})

	it('throws TypeError when project is NaN', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		expect(() => plugin.triggerMacro(NaN, 5)).toThrow(TypeError)
	})

	it('throws TypeError when macro is NaN', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		expect(() => plugin.triggerMacro(1, NaN)).toThrow(TypeError)
	})

	it('throws TypeError when project is Infinity', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		expect(() => plugin.triggerMacro(Infinity, 5)).toThrow(TypeError)
	})

	it('throws TypeError message includes both received values', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		expect(() => plugin.triggerMacro(1.5, 5.5)).toThrow(/project=1\.5.*macro=5\.5/)
	})
})

// ─── destroy() ───────────────────────────────────────────────────────────────

describe('destroy', () => {
	it('emits stopped after the teardown delay', async () => {
		vi.useFakeTimers()
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()

		const stopped = vi.fn()
		plugin.on('stopped', stopped)

		plugin.destroy()
		expect(stopped).not.toHaveBeenCalled()

		await vi.runAllTimersAsync()
		expect(stopped).toHaveBeenCalledOnce()

		vi.useRealTimers()
	})

	it('calls destroy() on both sockets', async () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()

		const [cmdSocket, tallySocket] = mockInstances
		plugin.destroy()

		expect(cmdSocket?.destroy).toHaveBeenCalledOnce()
		expect(tallySocket?.destroy).toHaveBeenCalledOnce()
	})
})

// ─── Tally stream parsing ─────────────────────────────────────────────────────

describe('tally stream parsing', () => {
	/** Call the private receivedTallyData() directly, bypassing start(). */
	function feedTally(plugin: KahunaPlugin, buf: Buffer): void {
		;(plugin as unknown as { receivedTallyData(b: Buffer): void }).receivedTallyData(buf)
	}

	it('emits tally_changed with the correct source number', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		feedTally(plugin, makeTallyBuffer(3))
		expect(changed).toHaveBeenCalledWith(3) // No longer 0based
	})

	it('does not emit tally_changed when the tally value is unchanged', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		feedTally(plugin, makeTallyBuffer(3))
		feedTally(plugin, makeTallyBuffer(3))

		expect(changed).toHaveBeenCalledOnce()
	})

	it('emits tally_changed again when the value changes a second time', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		// Chain both fields in one buffer: field2's 0x84 terminates field1 naturally.
		// Using separate makeTallyBuffer() calls would leave a stray 0x80 at the
		// end of the first event that would corrupt the second field's parsing.
		feedTally(plugin, Buffer.concat([makeTallyField(1), makeTallyField(2), Buffer.from([0x80])]))

		expect(changed).toHaveBeenCalledTimes(2)
		expect(changed).toHaveBeenNthCalledWith(1, 1)
		expect(changed).toHaveBeenNthCalledWith(2, 2)
	})

	it('does not emit tally_changed for a non-0x84 field', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		// Same layout as a tally field but first byte is 0x85 instead of 0x84.
		const nonTallyField = Buffer.alloc(19, 0x00)
		nonTallyField[0] = 0x85
		nonTallyField[1] = 0x80
		nonTallyField[18] = 5
		feedTally(plugin, Buffer.concat([nonTallyField, Buffer.from([0x80])]))

		expect(changed).not.toHaveBeenCalled()
	})

	it('does not emit tally_changed for a 0x84 field that is too short (< 19 bytes)', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		// 18-byte field — byte 18 is missing.
		const shortField = Buffer.alloc(18, 0x00)
		shortField[0] = 0x84
		shortField[1] = 0x80
		feedTally(plugin, Buffer.concat([shortField, Buffer.from([0x80])]))

		expect(changed).not.toHaveBeenCalled()
	})

	it('silently discards leading data bytes (< 0x80) before the first field', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		// Prepend three stray data bytes before a valid tally field.
		const junk = Buffer.from([0x01, 0x02, 0x03])
		feedTally(plugin, Buffer.concat([junk, makeTallyBuffer(7)]))

		expect(changed).toHaveBeenCalledWith(7)
	})

	it('handles a 0xD2 0xD2 heartbeat without throwing or emitting tally_changed', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		feedTally(plugin, Buffer.from([0xd2, 0xd2]))

		expect(changed).not.toHaveBeenCalled()
	})

	it('reassembles a tally field split across two data events', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		const field = makeTallyField(4)
		// First chunk: first 10 bytes — no terminator, so the field is incomplete.
		feedTally(plugin, field.subarray(0, 10))
		expect(changed).not.toHaveBeenCalled()

		// Second chunk: remaining bytes + terminator to signal field completion.
		feedTally(plugin, Buffer.concat([field.subarray(10), Buffer.from([0x80])]))
		expect(changed).toHaveBeenCalledWith(4)
	})

	it('resets the accumulation buffer and logs an error when it exceeds 1000 bytes', () => {
		const log = makeLogger()
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, log)

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		// A 1000-byte buffer of 0x80 bytes (control bytes, so not trimmed).
		feedTally(plugin, Buffer.alloc(1000, 0x80))

		expect(log.error).toHaveBeenCalledWith(expect.stringContaining('too long'))
		expect(changed).not.toHaveBeenCalled()
	})

	it('continues processing correctly after a buffer overflow reset', () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())

		const changed = vi.fn()
		plugin.on('tally_changed', changed)

		feedTally(plugin, Buffer.alloc(1000, 0x80)) // trigger overflow reset
		feedTally(plugin, makeTallyBuffer(2)) // should now process cleanly

		expect(changed).toHaveBeenCalledWith(2)
	})
})

// ─── Command response parsing ─────────────────────────────────────────────────

describe('command response parsing', () => {
	/** Directly invoke the private receivedCmdData() method. */
	function feedCmd(plugin: KahunaPlugin, buf: Buffer): void {
		;(plugin as unknown as { receivedCmdData(b: Buffer): void }).receivedCmdData(buf)
	}

	/** Push a pre-built command directly into the plugin's internal queue. */
	function pushCommand(plugin: KahunaPlugin, command: KahunaCommand): void {
		;(plugin as unknown as { commands: KahunaCommand[] }).commands.push(command)
	}

	/** Set processingCommand so the queue believes a send is in progress. */
	function setProcessing(plugin: KahunaPlugin, value: boolean): void {
		;(plugin as unknown as { processingCommand: boolean }).processingCommand = value
	}

	it('emits macro_complete after receiving OK for every stage', async () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()
		const [cmdSocket] = mockInstances
		cmdSocket?.simulateConnect()

		const complete = vi.fn()
		plugin.on('macro_complete', complete)

		pushCommand(plugin, makeCommand(3, 42))
		setProcessing(plugin, true)

		// First OK: LOAD stage done, TRIGGER stage sent.
		feedCmd(plugin, OK_BUF)
		await flushMicrotasks()

		// Second OK: TRIGGER stage done → macro_complete.
		feedCmd(plugin, OK_BUF)
		await flushMicrotasks()

		expect(complete).toHaveBeenCalledWith(3, 42)
	})

	it('dequeues the command and moves to the next on an ERROR response', async () => {
		const plugin = new KahunaPlugin()
		const log = makeLogger()
		plugin.configure(VALID_CONFIG, log)
		await plugin.start()
		const [cmdSocket] = mockInstances
		cmdSocket?.simulateConnect()

		const complete = vi.fn()
		plugin.on('macro_complete', complete)

		pushCommand(plugin, makeCommand(1, 1))
		pushCommand(plugin, makeCommand(2, 2))
		setProcessing(plugin, true)

		feedCmd(plugin, ERROR_BUF)
		await flushMicrotasks()

		expect(log.error).toHaveBeenCalledWith(expect.stringContaining('ERROR'))
		// macro_complete should never fire for the failed command.
		expect(complete).not.toHaveBeenCalled()
	})

	it('dequeues on an unknown response and logs debug', async () => {
		const plugin = new KahunaPlugin()
		const log = makeLogger()
		plugin.configure(VALID_CONFIG, log)
		await plugin.start()
		const [cmdSocket] = mockInstances
		cmdSocket?.simulateConnect()

		pushCommand(plugin, makeCommand(1, 1))
		setProcessing(plugin, true)

		feedCmd(plugin, Buffer.from('UNKNOWN_RESPONSE\r\n', 'ascii'))
		await flushMicrotasks()

		expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('Unknown response'))
	})

	it('logs an error when OK is received but the queue is empty', async () => {
		const plugin = new KahunaPlugin()
		const log = makeLogger()
		plugin.configure(VALID_CONFIG, log)
		await plugin.start()

		setProcessing(plugin, true)
		// No command in queue.
		feedCmd(plugin, OK_BUF)

		expect(log.error).toHaveBeenCalledWith(expect.stringContaining('queue is empty'))
	})

	it('processes a second queued command after the first completes', async () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()
		const [cmdSocket] = mockInstances
		cmdSocket?.simulateConnect()

		const complete = vi.fn()
		plugin.on('macro_complete', complete)

		pushCommand(plugin, makeCommand(1, 10))
		pushCommand(plugin, makeCommand(2, 20))
		setProcessing(plugin, true)

		// Complete command 1 (two OKs for LOAD → TRIGGER).
		feedCmd(plugin, OK_BUF)
		await flushMicrotasks()
		feedCmd(plugin, OK_BUF)
		await flushMicrotasks()

		expect(complete).toHaveBeenCalledWith(1, 10)

		// Complete command 2.
		setProcessing(plugin, true)
		feedCmd(plugin, OK_BUF)
		await flushMicrotasks()
		feedCmd(plugin, OK_BUF)
		await flushMicrotasks()

		expect(complete).toHaveBeenCalledWith(2, 20)
		expect(complete).toHaveBeenCalledTimes(2)
	})

	it('trims whitespace from the response before comparing', async () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()
		const [cmdSocket] = mockInstances
		cmdSocket?.simulateConnect()

		const complete = vi.fn()
		plugin.on('macro_complete', complete)

		pushCommand(plugin, makeCommand(1, 1))
		setProcessing(plugin, true)

		// LOAD OK with extra whitespace.
		feedCmd(plugin, Buffer.from('  OK  \r\n', 'ascii'))
		await flushMicrotasks()
		// TRIGGER OK.
		feedCmd(plugin, Buffer.from('OK\n', 'ascii'))
		await flushMicrotasks()

		expect(complete).toHaveBeenCalledWith(1, 1)
	})
})

// ─── Connection events ────────────────────────────────────────────────────────

describe('connection events', () => {
	it('resets processingCommand on cmd connect', async () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()
		const [cmdSocket] = mockInstances

		;(plugin as unknown as { processingCommand: boolean }).processingCommand = true
		cmdSocket?.simulateConnect()

		expect((plugin as unknown as { processingCommand: boolean }).processingCommand).toBe(false)
	})

	it('resets processingCommand on cmd end', async () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()
		const [cmdSocket] = mockInstances

		;(plugin as unknown as { processingCommand: boolean }).processingCommand = true
		cmdSocket?.simulateEnd()

		expect((plugin as unknown as { processingCommand: boolean }).processingCommand).toBe(false)
	})

	it('logs a cmd socket error', async () => {
		const log = makeLogger()
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, log)
		await plugin.start()
		const [cmdSocket] = mockInstances

		cmdSocket?.simulateError(new Error('ECONNREFUSED'))

		expect(log.error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'))
	})

	it('logs a tally socket error', async () => {
		const log = makeLogger()
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, log)
		await plugin.start()
		const [, tallySocket] = mockInstances

		tallySocket?.simulateError(new Error('ETIMEDOUT'))

		expect(log.error).toHaveBeenCalledWith(expect.stringContaining('ETIMEDOUT'))
	})
})

// ─── Status event forwarding ──────────────────────────────────────────────────

describe('status event forwarding', () => {
	it('forwards cmd socket status_change as cmd_status', async () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()
		const [cmdSocket] = mockInstances

		const cmdStatus = vi.fn()
		plugin.on('cmd_status', cmdStatus)

		cmdSocket?.simulateStatusChange('ok', undefined)

		expect(cmdStatus).toHaveBeenCalledWith('ok', undefined)
	})

	it('forwards tally socket status_change as tally_status', async () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()
		const [, tallySocket] = mockInstances

		const tallyStatus = vi.fn()
		plugin.on('tally_status', tallyStatus)

		tallySocket?.simulateStatusChange('connecting', 'Reconnecting...')

		expect(tallyStatus).toHaveBeenCalledWith('connecting', 'Reconnecting...')
	})

	it('forwards cmd_status and tally_status independently', async () => {
		const plugin = new KahunaPlugin()
		plugin.configure(VALID_CONFIG, makeLogger())
		await plugin.start()
		const [cmdSocket, tallySocket] = mockInstances

		const cmdStatus = vi.fn()
		const tallyStatus = vi.fn()
		plugin.on('cmd_status', cmdStatus)
		plugin.on('tally_status', tallyStatus)

		cmdSocket?.simulateStatusChange('ok')
		tallySocket?.simulateStatusChange('disconnected', 'Lost connection')

		expect(cmdStatus).toHaveBeenCalledTimes(1)
		expect(tallyStatus).toHaveBeenCalledTimes(1)
		expect(tallyStatus).toHaveBeenCalledWith('disconnected', 'Lost connection')
	})
})
