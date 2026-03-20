import type { CompanionActionDefinitions } from '@companion-module/base'
import type Kahuna from './main.js'

export enum ActionId {
	TriggerMacro = 'trigger_macro',
}

export type ActionSchema = {
	[ActionId.TriggerMacro]: {
		options: {
			project: number
			macro: number
		}
	}
}

export function UpdateActions(self: Kahuna): CompanionActionDefinitions<ActionSchema> {
	return {
		[ActionId.TriggerMacro]: {
			name: 'Trigger Macro',
			options: [
				{
					id: 'project',
					type: 'number',
					label: 'Project',
					default: 1,
					min: 1,
					max: 99,
					asInteger: true,
				},
				{
					id: 'macro',
					type: 'number',
					label: 'Macro',
					default: 1,
					min: 1,
					max: 999,
					asInteger: true,
				},
			],
			callback: async (event) => {
				const { project, macro } = event.options
				await self.triggerMacro(project, macro)
			},
		},
	}
}
