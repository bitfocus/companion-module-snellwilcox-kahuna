import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export type ModuleConfig = {
	ip: string
	cmdPort: number
	tallyPort: number
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'ip',
			label: 'Target IP',
			width: 8,
			regex: Regex.IP,
		},
		{
			type: 'number',
			id: 'cmdPort',
			label: 'Command Port',
			width: 4,
			min: 1,
			max: 65535,
			default: 4003,
		},
		{
			type: 'number',
			id: 'tallyPort',
			label: 'Tally Port',
			width: 4,
			min: 1,
			max: 65535,
			default: 4004,
		},
	]
}
