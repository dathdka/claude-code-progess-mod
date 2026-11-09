import type { EngineInterface } from 'claude-code'

import type { Repo, SessionRow } from '../types'
import type { describeDoing } from './activity'
import type { Segment } from './gauges'
import { describeRow, layoutRow } from './overview'
import { repoLine, repoName } from './repos'
import { COLORS, truncate } from './style'

/** The elements of the surface the pane is drawn on. */
type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Doing = NonNullable<ReturnType<typeof describeDoing>>

/** The other sessions, one row each, and `+N more`. */
export function sessionBlock(ui: Ui, shown: readonly SessionRow[], more: number, now: number, inner: number) {
  const { Box, Text } = ui

  return (
    <Box flexDirection="column">
      {shown.map(row => {
        const text = layoutRow(describeRow(row, now), inner)
        const tone = row.state === 'waiting' ? COLORS.accent : row.state === 'busy' ? COLORS.text : COLORS.muted

        return (
          <Text>
            <Text color={tone}>{text.head}</Text>
            <Text color={COLORS.muted}>{text.progress}</Text>
            <Text color={row.state === 'waiting' ? COLORS.accent : COLORS.muted}> {text.detail}</Text>
          </Text>
        )
      })}
      {more > 0 && <Text color={COLORS.muted}>+{more} more</Text>}
    </Box>
  )
}

/** The live strip's lines, in order: gauges, what runs now, one per repository, `+N repos`; a line with nothing to show is null. */
export function stripLines(ui: Ui, gauges: readonly Segment[] | undefined, doing: Doing | undefined, repos: { shown: readonly Repo[]; more: number }, inner: number) {
  const { Text } = ui
  const gaugeLine =
    gauges === undefined ? null : (
      <Text>
        {gauges.map(segment => (
          <Text color={segment.tone === 'warn' ? COLORS.warn : segment.tone === 'muted' ? COLORS.muted : COLORS.text}>{segment.text}</Text>
        ))}
      </Text>
    )
  const agentRoom = doing === undefined || doing.agents === '' ? 0 : doing.agents.length + 1
  const doingLine =
    doing === undefined ? null : (
      <Text>
        <Text color={doing.isRunning ? COLORS.active : COLORS.muted}>{truncate(doing.text, Math.max(1, inner - agentRoom))}</Text>
        {doing.agents !== '' && <Text color={COLORS.accent}> {doing.agents}</Text>}
      </Text>
    )
  const repoLines = repos.shown.map(repo => {
    const parts = repoLine(repoName(repo.root), repo.status as NonNullable<Repo['status']>, inner)

    return (
      <Text>
        <Text color={COLORS.muted}>⎇ </Text>
        <Text color={COLORS.text}>{parts.name}</Text>
        <Text color={COLORS.accent}>{`  ${parts.branch}`}</Text>
        <Text color={(repo.status?.changed ?? 0) > 0 ? COLORS.active : COLORS.success}>{`  ${parts.detail}`}</Text>
      </Text>
    )
  })
  const moreLine = repos.more > 0 ? <Text color={COLORS.muted}>+{repos.more} repos</Text> : null

  return [gaugeLine, doingLine, ...repoLines, moreLine]
}
