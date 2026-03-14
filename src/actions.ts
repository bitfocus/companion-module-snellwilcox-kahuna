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
			timeout: number
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
					max: 100,
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
				{
					id: 'timeout',
					type: 'number',
					label: 'Timeout (mS)',
					default: 2000,
					min: 500,
					max: Number.MAX_SAFE_INTEGER,
					asInteger: true,
					description: `Promise will reject after this interval.Should be longer than macro duration.`,
				},
			],
			callback: async (event) => {
				const { project, macro, timeout } = event.options
				await self.triggerMacro(project, macro, timeout)
			},
		},
	}
}
