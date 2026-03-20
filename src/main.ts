import {
	createModuleLogger,
	InstanceBase,
	InstanceStatus,
	TCPStatuses,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks, FeedbackId } from './feedbacks.js'
import type { InstanceBaseExt, KahunaTypes } from './types.js'
import { KahunaPlugin } from './KahunaPlugin.js'
import PQueue from 'p-queue'

export { UpgradeScripts }

export default class ModuleInstance extends InstanceBase<KahunaTypes> implements InstanceBaseExt {
	config!: ModuleConfig // Setup in init()
	#kahuna!: KahunaPlugin
	#queue = new PQueue({ intervalCap: 1, interval: 10 })
	#controller = new AbortController()

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config

		this.updateStatus(InstanceStatus.Connecting)

		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updatePresets() // export Presets
		this.updateVariableDefinitions() // export variable definitions
		await this.initKahuna(config)
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', `destroy process: ${process.pid} id: ${this.id} label: ${this.label}`)
		this.#controller.abort()
		this.#queue.clear()
		if (this.#kahuna) await this.destroyKahuna()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.#controller.abort()
		this.#queue.clear()
		this.#controller = new AbortController()
		this.config = config
		await this.initKahuna(config)
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	private async destroyKahuna(): Promise<void> {
		if (this.#kahuna) {
			await new Promise<void>((resolve) => {
				this.#kahuna.once('stopped', resolve)
				this.#kahuna.destroy()
			})
		}
	}

	private async initKahuna(config: ModuleConfig): Promise<void> {
		if (this.#kahuna) await this.destroyKahuna()
		this.updateStatus(InstanceStatus.Connecting)
		let cmdStatus: TCPStatuses = InstanceStatus.Disconnected
		let tallyStatus: TCPStatuses = InstanceStatus.Disconnected

		const STATUS_SEVERITY: Record<TCPStatuses, number> = {
			[InstanceStatus.Ok]: 0,
			[InstanceStatus.Connecting]: 1,
			[InstanceStatus.Disconnected]: 2,
			[InstanceStatus.UnknownError]: 3,
		}

		const updateWorstStatus = (message: string | undefined): void => {
			const [worstStatus] = ([cmdStatus, tallyStatus] as TCPStatuses[]).sort(
				(a, b) => STATUS_SEVERITY[b] - STATUS_SEVERITY[a],
			)
			this.updateStatus(worstStatus, message ?? null)
		}
		this.#kahuna = new KahunaPlugin()
		this.#kahuna.configure(config, createModuleLogger('Kahuna'))
		this.#kahuna.on('macro_complete', (project, macro) => {
			this.log('info', `Macro Complete. ${project}, ${macro}`)
		})
		this.#kahuna.on('tally_changed', (tallyNumber) => {
			this.log(`debug`, `Tally Changed: ${tallyNumber}`)
			this.setVariableValues({ tallyNumber: tallyNumber })
			this.checkFeedbacks(FeedbackId.Tally)
		})
		this.#kahuna.on('stopped', () => {
			this.log('info', `Kahuna connection closed`)
		})
		this.#kahuna.on('cmd_status', (status, message) => {
			cmdStatus = status
			this.log('info', `Command port connection status changed: ${status} ${message ? message : ''}`)
			updateWorstStatus(message)
		})
		this.#kahuna.on('tally_status', (status, message) => {
			tallyStatus = status
			this.log('info', `Tally port connection status changed: ${status} ${message ? message : ''}`)
			updateWorstStatus(message)
		})
		await this.#kahuna.start()
	}

	/**
	 * Trigger a macro on the Kahuna and wait for it to complete.
	 *
	 * Adds the trigger to the module's serial queue so concurrent calls are
	 * automatically serialised.  The returned promise resolves when the mixer
	 * acknowledges all stages with a matching macro_complete event, or rejects
	 * if that does not happen within `timeoutMs` milliseconds.
	 *
	 * @param project   - Two-digit project number (integer).
	 * @param macro     - Three-digit macro number (integer).
	 * @param timeoutMs - Maximum time to wait for macro_complete acknowledgement.
	 */
	public async triggerMacro(project: number, macro: number, timeoutMs: number = 5000): Promise<void> {
		if (!this.#kahuna) {
			return Promise.reject(new Error('Kahuna is not initialised — call initKahuna() first'))
		}

		// Capture the reference so the queue task and event handler close over
		// a stable value even if initKahuna() is called again mid-flight.
		const kahuna = this.#kahuna

		await this.#queue.add(
			async ({ signal }) => {
				await new Promise<void>((resolve, reject) => {
					let timer: NodeJS.Timeout | undefined = undefined

					const cleanup = (): void => {
						clearTimeout(timer)
						kahuna.off('macro_complete', onComplete)
						signal?.removeEventListener('abort', onAbort)
					}

					const onComplete = (completedProject: number, completedMacro: number): void => {
						if (completedProject === project && completedMacro === macro) {
							cleanup()
							resolve()
						}
					}

					const onAbort = (): void => {
						cleanup()
						reject(signal?.reason instanceof Error ? signal.reason : new Error(`Macro ${project}/${macro} aborted`))
					}

					kahuna.on('macro_complete', onComplete)
					signal?.addEventListener('abort', onAbort, { once: true })

					timer = setTimeout(() => {
						cleanup()
						reject(new Error(`Macro ${project}/${macro} timed out after ${timeoutMs}ms — no acknowledgement received`))
					}, timeoutMs)

					try {
						kahuna.triggerMacro(project, macro)
					} catch (err: unknown) {
						cleanup()
						reject(err instanceof Error ? err : new Error('Macro failed to complete'))
					}
				})
			},
			{ signal: this.#controller.signal },
		)
	}

	public get kahunaTally(): Readonly<number> {
		if (!this.#kahuna) {
			throw new Error('Kahuna is not initialised — call initKahuna() first')
		}
		return this.#kahuna.requestTally()
	}

	private updateActions(): void {
		this.setActionDefinitions(UpdateActions(this))
	}

	private updateFeedbacks(): void {
		this.setFeedbackDefinitions(UpdateFeedbacks(this))
	}

	private updatePresets(): void {}

	private updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
		this.setVariableValues({ tallyNumber: 0 })
	}
}
