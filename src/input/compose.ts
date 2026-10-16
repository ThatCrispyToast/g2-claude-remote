// The Compose menu model — the ordered set of keyboard-free actions the wearer
// can fire on a session by scrolling to one and tapping. Pure data + tiny
// helpers; the state machine in main.ts drives selection and dispatch.

import { ASIDE_QUESTIONS, EFFORTS, MODELS, MODES, QUICK_SENDS, SLASH_COMMANDS } from '../config'
import { HUD } from '../glasses'
import type { PermissionMode } from '../rc/types'

export type SubmenuKind = 'model' | 'mode' | 'effort' | 'command' | 'aside'

export type ComposeAction =
  | { kind: 'prompt'; label: string }
  | { kind: 'send'; label: string; text: string }
  | { kind: 'voice'; label: string }
  | { kind: 'interrupt'; label: string }
  | { kind: 'info'; label: string }
  | { kind: 'submenu'; label: string; menu: SubmenuKind }
  | { kind: 'archive'; label: string }
  | { kind: 'back'; label: string }

/**
 * The top-level Compose menu, in display order — ordered by how often the wearer
 * reaches for each on a keyboard-less device. Dictate leads (it's the only
 * open-ended input path), then Ask aside (check in without derailing the
 * session), the one-tap canned sends, the run controls (Interrupt), Session
 * info, the rarer steering (Commands / Model / Mode / Effort), Archive, Back.
 */
export function composeActions(opts: { voiceAvailable: boolean; pendingPrompt?: string | null }): ComposeAction[] {
  const actions: ComposeAction[] = []
  // 0) A blocking prompt the wearer set aside ("answer later"). The session is
  //    waiting on it, so it leads the menu; tapping it reopens the question /
  //    permission screen. Absent when nothing is pending.
  if (opts.pendingPrompt) actions.push({ kind: 'prompt', label: opts.pendingPrompt })
  // 1) Dictate — the primary, open-ended input. Top of the list. `»` reads as
  //    "say" (the mic glyph isn't in the firmware font). Omitted with no key.
  if (opts.voiceAvailable) actions.push({ kind: 'voice', label: `${HUD.USER} Dictate a message` })
  // 2) A side question — read-only, so it sits with the inputs, not the steering.
  actions.push({ kind: 'submenu', label: `? Ask aside ${HUD.GO}`, menu: 'aside' })
  // 3) One-tap canned sends.
  for (const q of QUICK_SENDS) actions.push({ kind: 'send', label: `${HUD.SEND} ${q.label}`, text: q.text })
  // 4) Run controls, then the session's status, then steering, then the
  //    destructive/exit tail. Commands leads the submenu cluster; the `/` reads as
  //    "slash command" (a plain-ASCII glyph the firmware font always renders).
  actions.push({ kind: 'interrupt', label: `${HUD.STOP} Interrupt` })
  actions.push({ kind: 'info', label: `${HUD.SYS} Session info` })
  if (SLASH_COMMANDS.length) actions.push({ kind: 'submenu', label: `/ Commands ${HUD.GO}`, menu: 'command' })
  actions.push({ kind: 'submenu', label: `Model ${HUD.GO}`, menu: 'model' })
  actions.push({ kind: 'submenu', label: `Mode ${HUD.GO}`, menu: 'mode' })
  actions.push({ kind: 'submenu', label: `Effort ${HUD.GO}`, menu: 'effort' })
  actions.push({ kind: 'archive', label: 'Archive session' })
  actions.push({ kind: 'back', label: `${HUD.BACK} Back` })
  return actions
}

export interface SubmenuItem {
  label: string
  value: string
  current: boolean
}

/** The Model submenu — current model marked. */
export function modelItems(current: string | null): SubmenuItem[] {
  const items = MODELS.map((m) => ({
    label: `${m.id === current ? `${HUD.CUR} ` : '  '}${m.label}`,
    value: m.id,
    current: m.id === current,
  }))
  items.push({ label: `${HUD.BACK} Back`, value: '', current: false })
  return items
}

/**
 * The Commands submenu — each row fires a slash command (`/name`). A command is a
 * one-shot action, not a persistent setting, so nothing is ever marked `current`;
 * `value` carries the bare command name for the state machine to dispatch.
 */
export function commandItems(): SubmenuItem[] {
  const items: SubmenuItem[] = SLASH_COMMANDS.map((c) => ({
    label: `/ ${c.label}`,
    value: c.name,
    current: false,
  }))
  items.push({ label: `${HUD.BACK} Back`, value: '', current: false })
  return items
}

/** Value of the Ask aside submenu's dictation row (a question is never this). */
export const ASIDE_DICTATE = '@dictate'

/**
 * The Ask aside submenu: dictate a question (voice), or one of the canned ones.
 * `value` is the question itself — the state machine asks it directly, with no
 * confirm step: a side question can't change the session.
 */
export function asideItems(voiceAvailable: boolean): SubmenuItem[] {
  const items: SubmenuItem[] = []
  if (voiceAvailable) items.push({ label: `${HUD.USER} Dictate a question`, value: ASIDE_DICTATE, current: false })
  for (const q of ASIDE_QUESTIONS) items.push({ label: `? ${q}`, value: q, current: false })
  items.push({ label: `${HUD.BACK} Back`, value: '', current: false })
  return items
}

/** The Mode submenu — current permission mode marked. */
export function modeItems(current: PermissionMode | string | null): SubmenuItem[] {
  const items: SubmenuItem[] = MODES.map((m) => ({
    label: `${m === current ? `${HUD.CUR} ` : '  '}${m}`,
    value: m,
    current: m === current,
  }))
  items.push({ label: `${HUD.BACK} Back`, value: '', current: false })
  return items
}

/**
 * The Effort submenu, the worker's current level marked (`undefined` = unknown,
 * nothing marked — older workers don't report it). The auto row carries the
 * sentinel value 'auto' because '' is the Back row's value; a worker reports
 * its effective level, never "auto", so that row is never marked.
 */
export function effortItems(current: string | null | undefined): SubmenuItem[] {
  const items: SubmenuItem[] = EFFORTS.map((e) => ({
    label: `${current != null && e.id === current ? `${HUD.CUR} ` : '  '}${e.label}`,
    value: e.id ?? 'auto',
    current: current != null && e.id === current,
  }))
  items.push({ label: `${HUD.BACK} Back`, value: '', current: false })
  return items
}
