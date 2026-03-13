import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import type { InstanceBaseExt, KahunaTypes } from './types.js'

export { UpgradeScripts }

export default class ModuleInstance extends InstanceBase<KahunaTypes> implements InstanceBaseExt {
	config!: ModuleConfig // Setup in init()

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config

		this.updateStatus(InstanceStatus.Ok)

		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updatePresets() // export Presets
		this.updateVariableDefinitions() // export variable definitions
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', `destroy process: ${process.pid} id: ${this.id} label: ${this.label}`)
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		this.setActionDefinitions(UpdateActions(this))
	}

	updateFeedbacks(): void {
		this.setFeedbackDefinitions(UpdateFeedbacks(this))
	}

	updatePresets(): void {}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}
}
