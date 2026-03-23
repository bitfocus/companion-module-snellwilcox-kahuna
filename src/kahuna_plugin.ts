/**
 * KahunaPlugin.ts
 *
 * Companion module driver for the Kahuna vision mixer.
 *
 * Manages two persistent TCP connections via companion-module-base TCPHelper:
 *
 *   cmdSocket   – sends macro commands (LOAD / TRIGGER / UNLOAD stages) and
 *                 reads OK / ERROR acknowledgements from the mixer.
 *
 *   tallySocket – receives a continuous binary stream from the mixer; parsed
 *                 for 0x84 messages that carry the current tally number.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   const kahuna = new KahunaPlugin()
 *   kahuna.configure(config, log)
 *   await kahuna.start()
 *
 *   // Inbound — call public methods directly:
 *   kahuna.triggerMacro(project, macro)
 *   const tally = kahuna.requestTally()
 *
 *   // Outbound — listen for events:
 *   kahuna.on('tally_changed',  (tallyNumber) => { ... })
 *   kahuna.on('macro_complete', (project, macro) => { ... })
 *   kahuna.on('cmd_status',     (status, message) => { ... })
 *   kahuna.on('tally_status',   (status, message) => { ... })
 *
 *   kahuna.destroy()
 */

import { EventEmitter } from 'node:events'
import { type ModuleLogger, TCPHelper, type TCPStatuses } from '@companion-module/base'

import { KahunaCommand } from './kahuna_command.js'
import { MacroStage, type KahunaConfig, type MacroMessage } from './kahuna.types.js'

// ─── Event interface ──────────────────────────────────────────────────────────

export interface KahunaPluginEvents {
	/** Emitted whenever the tally number received from the mixer changes. */
	tally_changed: [tallyNumber: number]
	/** Emitted when all stages of a macro have been acknowledged by the mixer. */
	macro_complete: [project: number, macro: number]
	/** Forwarded status_change events from the command TCP connection. */
	cmd_status: [status: TCPStatuses, message: string | undefined]
	/** Forwarded status_change events from the tally TCP connection. */
	tally_status: [status: TCPStatuses, message: string | undefined]
	/** Emitted after destroy() has completed teardown. */
	stopped: []
}

// ─── KahunaPlugin ─────────────────────────────────────────────────────────────

export class KahunaPlugin extends EventEmitter<KahunaPluginEvents> {
	// ── TCP sockets (created in start()) ─────────────────────────────────────────
	private cmdSocket: TCPHelper | null = null
	private tallySocket: TCPHelper | null = null

	// ── Command queue (FIFO, mirrors C++ std::deque<CKahunaCommand>) ──────────────
	private readonly commands: KahunaCommand[] = []
	private processingCommand: boolean = false

	// ── Tally state ───────────────────────────────────────────────────────────────
	private tallyNumber: number = 0

	// ── Tally stream accumulation buffer ─────────────────────────────────────────
	private tallyBuffer: Buffer = Buffer.alloc(0)

	// ── Configuration and dependencies (set in configure()) ──────────────────────
	private host: string = ''
	private cmdPort: number = 0
	private tallyPort: number = 0
	private log!: ModuleLogger

	// ─── Lifecycle ────────────────────────────────────────────────────────────────

	/**
	 * Configure connection parameters and dependencies.
	 * Must be called before start().
	 *
	 * @param config - IP, ports.
	 * @param log    - Companion module logger.
	 */
	public configure(config: KahunaConfig, log: ModuleLogger): void {
		this.log = log

		log.debug('Kahuna Configuring')

		// ── Validate IP ──────────────────────────────────────────────────────────
		const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/
		const hostnameRegex =
			/^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$/
		// If the string contains only digits and dots it is an IPv4 attempt —
		// reject it unless it passes strict IPv4 validation. Without this guard
		// the hostname regex would accept malformed addresses like "192.168.1.256"
		// because all-numeric labels are syntactically valid hostname labels.
		const looksLikeIpv4 = /^[\d.]+$/.test(config.ip)
		if (looksLikeIpv4 ? !ipv4Regex.test(config.ip) : !hostnameRegex.test(config.ip)) {
			throw new TypeError(`Invalid IP address or hostname: '${config.ip}'`)
		}

		// ── Validate ports ───────────────────────────────────────────────────────
		const isValidPort = (p: number): boolean => Number.isInteger(p) && p >= 1 && p <= 65535

		if (!isValidPort(config.cmdPort)) {
			throw new RangeError(`cmdPort must be an integer between 1 and 65535 — received ${config.cmdPort}`)
		}
		if (!isValidPort(config.tallyPort)) {
			throw new RangeError(`tallyPort must be an integer between 1 and 65535 — received ${config.tallyPort}`)
		}
		if (config.cmdPort === config.tallyPort) {
			throw new RangeError(`cmdPort and tallyPort must be different — both are ${config.cmdPort}`)
		}

		this.host = config.ip
		this.cmdPort = config.cmdPort
		this.tallyPort = config.tallyPort

		log.debug('Kahuna Configured')
	}

	/**
	 * Open both TCP connections and load the macro mapping cache from the DB.
	 * TCPHelper connects automatically after construction and reconnects on drop.
	 */
	public async start(): Promise<void> {
		this.log.info(`Starting Kahuna Cmd Driver at ${this.host}:${this.cmdPort}`)

		this.cmdSocket = new TCPHelper(this.host, this.cmdPort)
		this.cmdSocket.on('connect', () => {
			this.onCmdConnect()
		})
		this.cmdSocket.on('end', () => {
			this.onCmdEnd()
		})
		this.cmdSocket.on('error', (err: Error) => {
			this.log.error(`Cmd socket error: ${err.message}`)
		})
		this.cmdSocket.on('data', (buf: Buffer) => {
			this.receivedCmdData(buf)
		})
		this.cmdSocket.on('status_change', (status: TCPStatuses, message: string | undefined) => {
			this.emit('cmd_status', status, message)
		})

		this.log.info(`Starting Kahuna Tally Driver at ${this.host}:${this.tallyPort}`)
		this.tallySocket = new TCPHelper(this.host, this.tallyPort)
		this.tallySocket.on('connect', () => {
			this.log.info('Kahuna tally connected')
		})
		this.tallySocket.on('end', () => {
			this.log.info('Kahuna tally disconnected')
		})
		this.tallySocket.on('error', (err: Error) => {
			this.log.error(`Tally socket error: ${err.message}`)
		})
		this.tallySocket.on('data', (buf: Buffer) => {
			this.receivedTallyData(buf)
		})
		this.tallySocket.on('status_change', (status: TCPStatuses, message: string | undefined) => {
			this.emit('tally_status', status, message)
		})
	}

	/**
	 * Permanently close both TCP connections and release all resources.
	 * Emits 'stopped' after a short teardown delay.
	 */
	public destroy(): void {
		this.tallySocket?.destroy()
		this.cmdSocket?.destroy()
		setTimeout(() => {
			this.emit('stopped')
		}, 500)
	}

	// ─── Public inbound API ───────────────────────────────────────────────────────

	/**
	 * Returns the most recently received tally number (zero-indexed).
	 * The mixer streams tally data continuously so this is always current.
	 */
	public requestTally(): number {
		this.log.info(`Tally requested, returning: ${this.tallyNumber - 1}`)
		return this.tallyNumber - 1
	}

	/**
	 * Queue a macro command directly by project and macro id.
	 * The mixer will LOAD then TRIGGER the macro.
	 *
	 * @param project - Two-digit project number.
	 * @param macro   - Three-digit macro number.
	 */
	public triggerMacro(project: number, macro: number): void {
		if (!Number.isInteger(project) || !Number.isInteger(macro)) {
			throw new TypeError(`triggerMacro requires integer arguments — received project=${project}, macro=${macro}`)
		}
		this.log.debug(`Queuing macro project=${project} macro=${macro}`)
		this.enqueueCommand(this.buildMacroMessage(project, macro))
	}

	// ─── Connection handlers ──────────────────────────────────────────────────────

	private onCmdConnect(): void {
		this.log.info('Kahuna cmd connected')
		// Reset flag so any command that was in-flight before a reconnect
		// can be dequeued rather than blocking the queue indefinitely.
		this.processingCommand = false
		void this.sendNextCommand()
	}

	private onCmdEnd(): void {
		this.log.info('Kahuna cmd disconnected')
		this.processingCommand = false
	}

	// ─── Command queue ────────────────────────────────────────────────────────────

	private enqueueCommand(message: MacroMessage): void {
		this.commands.push(new KahunaCommand(message))
		void this.sendNextCommand()
	}

	/**
	 * Send the head of the queue if idle and the socket is ready.
	 * Replaces C++ CKahunaPlugin::sendNextCommand().
	 */
	private async sendNextCommand(): Promise<void> {
		if (this.processingCommand) return
		if (this.commands.length === 0) return
		if (this.cmdSocket === null) return
		if (!this.cmdSocket.isConnected) return

		// Checked above: commands is non-empty.
		const command = this.commands[0]
		// Unreachable in practice; satisfies noUncheckedIndexedAccess.
		if (command === undefined) return

		this.processingCommand = true
		const str = command.toString()

		try {
			await this.cmdSocket.sendAsync(str)
			this.log.debug(`Written Command :: ${str.trim()}`)
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			this.log.error(`Failed to write command: ${msg}`)
			this.commands.shift()
			this.processingCommand = false
			void this.sendNextCommand()
		}
	}

	// ─── Command response parsing ─────────────────────────────────────────────────

	/**
	 * Process data arriving on the command socket.
	 * The mixer replies 'OK' or 'ERROR...' to each command stage.
	 */
	private receivedCmdData(buf: Buffer): void {
		const response = buf.toString('ascii').trim()
		this.log.debug(`Received macro response: ${response}`)

		if (response === 'OK') {
			const command = this.commands[0]
			if (command === undefined) {
				this.log.error('Received OK but command queue is empty')
				this.processingCommand = false
				return
			}

			command.nextStage()

			if (command.isFinished()) {
				this.emit('macro_complete', command.message.project, command.message.macro)
				this.commands.shift()
				this.processingCommand = false
				void this.sendNextCommand()
			} else {
				// Send the next stage of the same multi-stage macro.
				const str = command.toString()
				this.cmdSocket
					?.sendAsync(str)
					.then(() => {
						this.log.debug(`Written Command :: ${str.trim()}`)
					})
					.catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err)
						this.log.error(`Failed to write command stage: ${msg}`)
					})
			}
		} else if (response.startsWith('ERROR')) {
			this.log.error(`Kahuna ERROR response: ${response}`)
			this.commands.shift()
			this.processingCommand = false
			void this.sendNextCommand()
		} else {
			this.log.debug(`Unknown response: ${response}`)
			this.commands.shift()
			this.processingCommand = false
			void this.sendNextCommand()
		}
	}

	// ─── Tally stream parsing ─────────────────────────────────────────────────────

	/**
	 * Accumulate incoming tally bytes and extract complete fields.
	 *
	 * The Kahuna sends a continuous binary stream.  Fields are bounded by
	 * control bytes (>= 0x80); data bytes within a field are all < 0x80.
	 */
	private receivedTallyData(incoming: Buffer): void {
		this.tallyBuffer = Buffer.concat([this.tallyBuffer, incoming])

		// Discard leading bytes below 0x80 — they cannot start a valid field.
		let trimStart = 0
		while (trimStart < this.tallyBuffer.length) {
			const b = this.tallyBuffer[trimStart]
			// noUncheckedIndexedAccess: b is number | undefined.
			if (b === undefined || b >= 0x80) break
			trimStart++
		}
		if (trimStart > 0) {
			this.tallyBuffer = this.tallyBuffer.subarray(trimStart)
		}

		// Guard against runaway buffers (mirrors the C++ 1000-byte check).
		if (this.tallyBuffer.length >= 1000) {
			this.log.error('Input stream too long, skipping')
			this.tallyBuffer = Buffer.alloc(0)
			return
		}

		// Extract complete fields.
		let pos = 0
		while (pos + 1 < this.tallyBuffer.length) {
			const fieldStart = pos

			// Read the two mandatory control bytes (both >= 0x80).
			// noUncheckedIndexedAccess: each access returns number | undefined.
			const ctrl0 = this.tallyBuffer[pos]
			const ctrl1 = this.tallyBuffer[pos + 1]
			if (ctrl0 === undefined || ctrl1 === undefined) break

			const field: number[] = [ctrl0, ctrl1]
			pos += 2

			// Consume trailing data bytes (< 0x80) belonging to this field.
			while (pos < this.tallyBuffer.length) {
				const b = this.tallyBuffer[pos]
				if (b === undefined || b >= 0x80) break
				field.push(b)
				pos++
			}

			// A field is complete when the next delimiter byte is present, OR it is
			// a two-byte 0xD2 0xD2 heartbeat frame.
			const isHeartbeat = field.length === 2 && ctrl0 === 0xd2 && ctrl1 === 0xd2

			if (pos < this.tallyBuffer.length || isHeartbeat) {
				this.processField(Buffer.from(field))
			} else {
				// Incomplete field — leave it in the buffer for the next chunk.
				pos = fieldStart
				break
			}
		}

		this.tallyBuffer = this.tallyBuffer.subarray(pos)
	}

	/**
	 * Inspect a complete tally field and emit 'tally_changed' if the value
	 * has changed.  Only 0x84 messages carry tally data; all others are
	 * silently discarded.
	 */
	private processField(field: Buffer): void {
		const firstByte = field[0]
		const tallyByte = field[18]

		// noUncheckedIndexedAccess: both accesses return number | undefined.
		if (firstByte !== 0x84 || field.length <= 18 || tallyByte === undefined) {
			return
		}

		if (tallyByte !== this.tallyNumber) {
			this.tallyNumber = tallyByte
			this.emit('tally_changed', this.tallyNumber)
			this.log.debug(`Tally Changed to ${this.tallyNumber}`)
		}
	}

	// ─── Macro helpers ────────────────────────────────────────────────────────────

	/**
	 * Build an internal MacroMessage (LOAD → TRIGGER) for KahunaCommand.
	 */
	private buildMacroMessage(projectId: number, macroId: number): MacroMessage {
		const stages: MacroStage[] = [MacroStage.LOAD, MacroStage.TRIGGER]

		return {
			project: projectId,
			macro: macroId,
			getNumberStages(): number {
				return stages.length
			},
			getStage(index: number): MacroStage {
				const stage = stages[index]
				if (stage === undefined) {
					throw new RangeError(`Stage index ${index} out of range (max ${stages.length - 1})`)
				}
				return stage
			},
		}
	}
}
