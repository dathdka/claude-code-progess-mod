export const MAX_SCENE_COLUMNS = 96
export const MIN_SCENE_COLUMNS = 16
export const MAX_SCENE_ROWS = 16
export const MIN_SCENE_ROWS = 8
/** Rows the pane keeps for everything but the scene: 7 of chrome and 8 for tasks. */
export const INFO_ROWS = 15
/** Rows assumed when the pane does not report its height. */
export const DEFAULT_BODY_ROWS = 40

export type SceneLayout = { columns: number; rows: number; firstRow: number }

/**
 * The scene's size for a pane, or undefined when the pane is too small and shows the text layout.
 * A short pane crops the top rows of the scene (`firstRow`): the citadel and the path stay.
 */
export function sceneLayout(innerColumns: number, bodyRows: number): SceneLayout | undefined {
  const rows = Math.min(MAX_SCENE_ROWS, bodyRows - INFO_ROWS)
  if (innerColumns < MIN_SCENE_COLUMNS || rows < MIN_SCENE_ROWS) return undefined

  return { columns: Math.min(MAX_SCENE_COLUMNS, innerColumns), rows, firstRow: MAX_SCENE_ROWS - rows }
}

/** Windows lit for `done` of `total` tasks: all of them only once every task is done, none for an empty list. */
export function litWindows(done: number, total: number, windows: number): number {
  if (total <= 0) return 0
  if (done >= total) return windows

  return Math.floor((windows * Math.max(0, done)) / total)
}
