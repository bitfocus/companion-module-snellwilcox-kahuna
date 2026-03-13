/**
 * KahunaCommand.ts
 *
 * Represents a single macro command being sent to the Kahuna vision mixer.
 * A command may have multiple stages (e.g. LOAD → TRIGGER → UNLOAD) and
 * advances through them one at a time as the mixer acknowledges each step
 * with an "OK" response.
 *
 * Wire format per stage:
 *   <CMD><pp>,<mmm>\r
 *   where CMD ∈ { MLD, MTR, MUL }
 *         pp  = zero-padded 2-digit project number
 *         mmm = zero-padded 3-digit macro number
 */

import { type MacroMessage, MacroStage } from './kahuna.types.js'

export class KahunaCommand {
	public readonly message: MacroMessage
	private stage: number = 0

	public constructor(message: MacroMessage) {
		this.message = message
	}

	// ─── Stage control ──────────────────────────────────────────────────────────

	public nextStage(): void {
		this.stage++
	}

	public isFinished(): boolean {
		return this.stage >= this.message.getNumberStages()
	}

	// ─── Wire format ────────────────────────────────────────────────────────────

	/**
	 * Returns the raw ASCII string to write to the command TCP socket for the
	 * current stage.
	 *
	 * @throws {Error} if the current stage value is not a recognised MacroStage.
	 */
	public toString(): string {
		const stageType = this.message.getStage(this.stage)

		let prefix: string
		switch (stageType) {
			case MacroStage.LOAD:
				prefix = 'MLD'
				break
			case MacroStage.TRIGGER:
				prefix = 'MTR'
				break
			case MacroStage.UNLOAD:
				prefix = 'MUL'
				break
			// Exhaustiveness guard: TypeScript will flag this if MacroStage grows
			// and the switch is not updated.
			default: {
				const _exhaustive: never = stageType
				throw new Error(`Unknown macro stage: ${String(_exhaustive)}`)
			}
		}

		const project = String(this.message.project).padStart(2, '0')
		const macro = String(this.message.macro).padStart(3, '0')
		return `${prefix}${project},${macro}\r`
	}
}
