import { combineRgb } from '@companion-module/base'
import type { CompanionFeedbackDefinitions } from '@companion-module/base'
import type Kahuna from './main.js'

export enum FeedbackId {
	Id = 'id',
}

export type FeedbackSchema = {
	[FeedbackId.Id]: {
		type: 'boolean'
		options: {
			num: number
		}
	}
}

export function UpdateFeedbacks(_self: Kahuna): CompanionFeedbackDefinitions<FeedbackSchema> {
	return {
		[FeedbackId.Id]: {
			name: 'Example Feedback',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [
				{
					id: 'num',
					type: 'number',
					label: 'Test',
					default: 5,
					min: 0,
					max: 10,
				},
			],
			callback: (feedback) => {
				console.log('Hello world!', feedback.options.num)
				if (Number(feedback.options.num) > 5) {
					return true
				} else {
					return false
				}
			},
		},
	}
}
