import type { CompanionFeedbackDefinitions } from '@companion-module/base'
import type Kahuna from './main.js'

export enum FeedbackId {
	Tally = 'tally',
}

export type FeedbackSchema = {
	[FeedbackId.Tally]: {
		type: 'value'
		options: {
			info: never
		}
	}
}

export function UpdateFeedbacks(self: Kahuna): CompanionFeedbackDefinitions<FeedbackSchema> {
	return {
		[FeedbackId.Tally]: {
			name: 'Tally',
			type: 'value',
			options: [
				{
					type: 'static-text',
					id: 'info',
					label: '',
					value: 'Returns current Tally Number',
				},
			],
			callback: () => {
				return self.kahunaTally
			},
		},
	}
}
