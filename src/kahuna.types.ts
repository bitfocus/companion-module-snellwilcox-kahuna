/**
 * kahuna.types.ts
 *
 * Shared interfaces, enums and type aliases for the Kahuna vision-mixer plugin.
 */

// ─── Macro stage enum ─────────────────────────────────────────────────────────

/**
 * The three operations the Kahuna mixer supports on a macro.
 * Values map directly to the two-/three-letter wire commands:
 *   LOAD    → MLD
 *   TRIGGER → MTR
 *   UNLOAD  → MUL
 */
export enum MacroStage {
	LOAD = 'LOAD',
	TRIGGER = 'TRIGGER',
	UNLOAD = 'UNLOAD',
}

// ─── Internal macro message ───────────────────────────────────────────────────

/**
 * Internal representation of a staged macro command passed to KahunaCommand.
 * Constructed by KahunaPlugin.buildMacroMessage() and not part of the public API.
 */
export interface MacroMessage {
	readonly project: number
	readonly macro: number
	getNumberStages(): number
	getStage(index: number): MacroStage
}

// ─── Plugin configuration ─────────────────────────────────────────────────────

export interface KahunaConfig {
	/** Mixer IP address or hostname. */
	readonly ip: string
	/** Command TCP port (1–65535). */
	readonly cmdPort: number
	/** Tally TCP port (1–65535). Must differ from cmdPort. */
	readonly tallyPort: number
}
