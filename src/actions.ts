import type { CompanionActionDefinitions } from '@companion-module/base'
import type Kahuna from './main.js'

export enum ActionId {
	Id = 'id',
}

export type ActionSchema = {
	[ActionId.Id]: {
		options: {
			num: number
		}
	}
}

export function UpdateActions(_self: Kahuna): CompanionActionDefinitions<ActionSchema> {
	return {
		[ActionId.Id]: {
			name: 'My First Action',
			options: [
				{
					id: 'num',
					type: 'number',
					label: 'Test',
					default: 5,
					min: 0,
					max: 100,
				},
			],
			callback: async (event) => {
				console.log('Hello world!', event.options.num)
			},
		},
	}
}
