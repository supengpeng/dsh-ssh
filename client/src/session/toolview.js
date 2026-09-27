/**
 * @module ssh.toolview
 * @order 485
 *
 * `SshExecCard` — the conversation row for `ssh_exec` (ICD §4.4 / §8.3 voice).
 *
 * The Host half already computes exactly the right presentation for this tool
 * (`src/tools/exec.ts`: `presentCall` → `card:'terminal'`, `presentResult` →
 * `output`/`exitCode`/`signal`, and `output.presentationMeta` =
 * `envelopePresentation()`), but the DSH Web client never renders Host card views:
 * it dispatches the keyed slot `tool.call.toolview` with `entryKey: <wire tool
 * name>` (`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx` line 57-61)
 * and falls back to `GenericToolCard`. Only `bash` ships a keyed view, so an
 * `ssh_exec` call used to show as "Tool call · ssh_exec · <first string arg>".
 *
 * A keyed hit **replaces** that generic row, so this component is the whole row and
 * carries two hard obligations:
 *
 *   1. **always render something** — returning `null` would leave an empty row;
 *   2. **never throw** — not on a pending call (no result yet), not on a `meta`
 *      whose shape it does not recognise, and not on a call whose arguments never
 *      arrived.
 *
 * ## What it reads (every prop is pinned by the harness source)
 *
 *   - `phase` / `block` — `ToolCallOwnerProps = ToolCallCommonProps & ToolCallPhaseProps`
 *     (`packages/client/ui-tool/src/client/contract/slots.ts:103`), whose phase
 *     union is `'preparing' | 'start' | 'result'` (`:97-100`);
 *   - `toolName` — "Wire Tool name and keyed dispatch value" (`slots.ts:83`),
 *     `callId` (`:81`), optional `inspect` (`:93`);
 *   - `block.argsRaw` while running — `StartedToolCall` (`ui-conversation ...
 *     /contract/records.ts:282`); `block.call.argsRaw` once settled —
 *     `ToolResultNode.call: { name; argsRaw } | null` (`records.ts:164`);
 *   - `block.meta` — `meta?: unknown` (`records.ts:170`), filled from the tool/result
 *     event by the chat builder (`ui-chat .../conversation-nodes/tool.ts:77`
 *     `meta: match.event.data.meta`), which is `envelopePresentation()`'s projection:
 *     `title`, `output`, `exitCode`, `signal?`, `outcome`, `sessionId`, `streamId`,
 *     `durationMs`;
 *   - `block.content` / `block.isError` / `block.error` — the settled result's own
 *     fields (`records.ts:167-169`), used when `meta` is absent or unusable.
 *
 * `meta` is `unknown` **on purpose** — a tool may project a scalar (the terminal
 * tools project a boolean), so every field is type-checked here and every absence is
 * a rendering decision, not an exception. In particular a `null`/missing `exitCode`
 * is not an error: a signalled command has no exit code and carries `signal`
 * instead, so "no exit pill" is the honest rendering. A `exitCode` that is not a
 * number (a string `"0"`, `NaN`) is treated exactly like an absent one.
 *
 * ## Channels
 *
 * The Host's projection joins everything into one `output` string and marks stderr
 * with a literal `[stderr]` line. The card splits on that marker, so stdout and
 * stderr are distinguishable — visibly (labelled blocks) and for assistive tech
 * (`aria-label`), not only by colour. The Host appends its notes after that marker,
 * and this card does not pretend otherwise: notes ride inside the last section
 * because the projection carries no delimiter that tells them apart, and inventing
 * one would be a second contract for the Host's copy. When `meta` yields no usable
 * output at all, the model-facing render (`block.content`) is the fallback — it is
 * the richer source, delimiting `--- stdout ---`, `--- stderr ---` and
 * `--- notes ---`, so notes stay out of the error block there.
 *
 * ## Styling
 *
 * `SSH.h` + the plugin's own `ssh-ws-*` classes and `--dsw-*` tokens (via
 * `ssh.session.styles`, inserted idempotently here because a session that never
 * opened the SSH panel has not loaded it) and the session kit's translator
 * (`ssh.session.ui`). React is the only external, exactly as the assembler demands.
 */

SSH.define('ssh.toolview', function (SSH) {
  const { useEffect } = SSH.react
  const h = SSH.h

  /**
   * The wire tool name this card occupies.
   *
   * Must equal `SSH_EXEC_TOOL_NAME` in the Host half (`src/tools/exec.ts`): the
   * dispatcher looks the entry up by the *wire* name, and a typo would silently
   * leave the generic row in place forever. The card's own test pins the literal.
   */
  const TOOL_NAME = 'ssh_exec'

  /** The channel marker `envelopePresentation()` inserts before stderr. */
  const STDERR_MARKER = '[stderr]'

  /** The model-facing render's section markers (`renderEnvelope`). */
  const STDOUT_SECTION = '--- stdout ---'
  const STDERR_SECTION = '--- stderr ---'
  const NOTES_SECTION = '--- notes ---'

  /** Lifecycle states and the words/tones that state them. */
  const STATUS = {
    running: { key: 'tool.running', tone: 'running' },
    ok: { key: 'tool.ok', tone: 'ok' },
    error: { key: 'tool.failed', tone: 'error' },
    refused: { key: 'tool.refused', tone: 'refused' },
    timeout: { key: 'tool.timeout', tone: 'timeout' },
    cancelled: { key: 'tool.cancelled', tone: 'cancelled' },
    limit: { key: 'tool.outputLimit', tone: 'denied' },
  }

  /** No channel content (a pending call, or a result with nothing to show). */
  const NO_CHANNELS = Object.freeze({ stdout: '', stderr: '', notes: '', reason: null })

  /** A head line of the model-facing render (`renderEnvelope`). */
  const HEAD_LINE = /^(ssh|label|command|cwd|reason): /

  /** A row that lays out an inline adornment beside its text. */
  const ROW_STYLE = Object.freeze({ display: 'flex', alignItems: 'center', gap: 6 })

  /** The command line: it owns the remaining width and never forces the row wider. */
  const COMMAND_STYLE = Object.freeze({
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 12,
  })

  // ── value readers ───────────────────────────────────────────────────────────
  //
  // Everything below tolerates unknown input: `meta` is `unknown` and the wire is
  // untrusted, so a malformed field degrades to "not there" instead of throwing
  // inside a render.

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function recordOf(value) {
    return isRecord(value) ? value : null
  }

  function stringOf(value) {
    return typeof value === 'string' ? value : null
  }

  /** A finite number, or null: `NaN`/`Infinity`/`"0"` are all "not there". */
  function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  /** The call's raw arguments, whichever stage carries them. */
  function argsRawOf(block, settled) {
    if (!isRecord(block)) return ''
    if (!settled && typeof block.argsRaw === 'string') return block.argsRaw
    const call = recordOf(block.call)
    if (call !== null && typeof call.argsRaw === 'string') return call.argsRaw
    return typeof block.argsRaw === 'string' ? block.argsRaw : ''
  }

  /** Parsed arguments, or null when they are absent, non-object or still streaming. */
  function readArgs(raw) {
    if (typeof raw !== 'string' || raw === '') return null
    try {
      return recordOf(JSON.parse(raw))
    } catch {
      // A mid-stream prefix is not JSON yet: the command stays unknown rather than
      // being reconstructed from half a payload.
      return null
    }
  }

  /**
   * The command this row is about.
   *
   * Order: the call's own arguments (what the model asked for) → the projection's
   * `command` (not emitted today, read defensively) → the `$ …` line the projection
   * leads with, which is the only place a settled result still carries the command
   * when its call head fell outside the session window.
   */
  function commandOf(args, meta) {
    const fromArgs = args === null ? null : stringOf(args.command)
    if (fromArgs !== null && fromArgs.trim() !== '') return fromArgs
    const fromMeta = meta === null ? null : stringOf(meta.command)
    if (fromMeta !== null && fromMeta.trim() !== '') return fromMeta
    const output = meta === null ? null : stringOf(meta.output)
    if (output !== null && output.startsWith('$ ')) {
      const firstBreak = output.indexOf('\n')
      const line = firstBreak < 0 ? output.slice(2) : output.slice(2, firstBreak)
      if (line.trim() !== '') return line
    }
    return ''
  }

  /**
   * Drop the projection's leading `$ <command>` line.
   *
   * The whole command is compared, not just the first line, because a multi-line
   * command would otherwise leave its own tail behind as if it were output.
   */
  function stripPromptLine(text, command) {
    if (command !== '' && text.startsWith(`$ ${command}`)) {
      const rest = text.slice(command.length + 2)
      return rest.startsWith('\n') ? rest.slice(1) : rest
    }
    // An empty command is a refusal: the projection still leads with a bare `$ `.
    if (text === '$' || text === '$ ') return ''
    if (text.startsWith('$ \n')) return text.slice(3)
    if (text.startsWith('$ ')) {
      const firstBreak = text.indexOf('\n')
      return firstBreak < 0 ? text.slice(2) : text.slice(firstBreak + 1)
    }
    return text
  }

  /** Split the projection's single string into channels at its `[stderr]` marker. */
  function splitChannels(text) {
    const at = text.indexOf(STDERR_MARKER)
    if (at < 0) return { stdout: text.replace(/\n+$/, ''), stderr: '', notes: '' }
    const stdout = text.slice(0, at).replace(/\n+$/, '')
    let stderr = text.slice(at + STDERR_MARKER.length)
    if (stderr.startsWith('\n')) stderr = stderr.slice(1)
    return { stdout, stderr: stderr.replace(/\n+$/, ''), notes: '' }
  }

  /**
   * Split the model-facing render into its sections.
   *
   * `renderEnvelope` writes head lines (`ssh: …`, `label:`, `command:`, `cwd:`,
   * `reason:`) and then whichever of `--- stdout ---`, `--- stderr ---` and
   * `--- notes ---` it has — a refusal with no captured output carries no
   * `--- stdout ---` at all. So this reads the marker *positions* instead of
   * assuming the trio: text before the first marker is the stdout section by
   * position, each marker owns the text up to the next one, and notes never land in
   * the error channel. `reason` is the one head line the card cannot rebuild from the
   * call, so it is recovered here.
   */
  function sectionsOfRendered(text) {
    const lines = text.split('\n')
    let consumed = 0
    let reason = null
    while (consumed < lines.length) {
      const match = HEAD_LINE.exec(lines[consumed])
      if (match === null) break
      if (match[1] === 'reason') reason = lines[consumed].slice(match[0].length).trim()
      consumed += 1
    }
    const body = lines.slice(consumed).join('\n')
    const marks = [
      { key: 'stdout', at: body.indexOf(STDOUT_SECTION), length: STDOUT_SECTION.length },
      { key: 'stderr', at: body.indexOf(STDERR_SECTION), length: STDERR_SECTION.length },
      { key: 'notes', at: body.indexOf(NOTES_SECTION), length: NOTES_SECTION.length },
    ]
      .filter((mark) => mark.at >= 0)
      .sort((left, right) => left.at - right.at)
    const sections = { stdout: '', stderr: '', notes: '', reason }
    if (marks.length === 0) {
      sections.stdout = body.trim()
      return sections
    }
    // Text before the first marker is the stdout section *by position*: a refusal has
    // no `--- stdout ---` marker, and its `(no output)` line still belongs to stdout
    // rather than to the notes section that follows it.
    sections.stdout = body.slice(0, marks[0].at).trim()
    for (let index = 0; index < marks.length; index += 1) {
      const mark = marks[index]
      const end = index + 1 < marks.length ? marks[index + 1].at : body.length
      const own = body.slice(mark.at + mark.length, end).trim()
      sections[mark.key] = mark.key === 'stdout' ? `${sections.stdout}\n${own}`.trim() : own
    }
    return sections
  }

  /**
   * The settled result's own text: text blocks verbatim, other blocks as JSON, and
   * the structured error as a last resort — the same flattening the harness's
   * `resultText` does (`ui-tool .../models/tool-call-model.ts:180`).
   */
  function settledText(block) {
    if (!isRecord(block) || !Array.isArray(block.content)) return null
    const parts = []
    for (const entry of block.content) {
      if (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string') parts.push(entry.text)
      else if (entry !== null && entry !== undefined) {
        try {
          parts.push(JSON.stringify(entry, null, 2))
        } catch {
          /* an unserialisable block is skipped, never fatal */
        }
      }
    }
    if (parts.length === 0) {
      const error = recordOf(block.error)
      const code = error === null ? null : stringOf(error.code)
      if (error !== null && code !== null) parts.push(`${stringOf(error.name) ?? 'Error'}: ${code}`)
    }
    const text = parts.join('\n')
    return text === '' ? null : text
  }

  /** The channel content to draw for one settled result. */
  function channelsOf(block, meta, command) {
    const projected = meta === null ? null : stringOf(meta.output)
    if (projected !== null && projected !== '') {
      const split = splitChannels(stripPromptLine(projected, command))
      return { stdout: split.stdout, stderr: split.stderr, notes: split.notes, reason: null }
    }
    const rendered = settledText(block)
    return rendered === null ? NO_CHANNELS : sectionsOfRendered(rendered)
  }

  /** The machine-readable failure code: the envelope's, else the harness's. */
  function codeOf(block, meta) {
    const fromMeta = meta === null ? null : stringOf(meta.code)
    if (fromMeta !== null) return fromMeta
    const error = isRecord(block) ? recordOf(block.error) : null
    return error === null ? null : stringOf(error.code)
  }

  /**
   * The lifecycle state of one call.
   *
   * A numeric exit code decides on its own (`0` is ok, anything else failed); with
   * no usable exit code a `signal` is the failure. Without either, the Host's own
   * outcome word is what is left to trust.
   */
  function stateOf(input) {
    if (!input.settled) return 'running'
    if (input.isError) return 'error'
    if (input.outcome === 'refused') return 'refused'
    if (input.outcome === 'timeout') return 'timeout'
    if (input.outcome === 'cancelled') return 'cancelled'
    if (input.exitCode !== null) return input.exitCode === 0 ? 'ok' : 'error'
    if (input.signal !== null) return 'error'
    if (input.outcome === 'error') return 'error'
    if (input.outcome === 'output-limit') return 'limit'
    return 'ok'
  }

  // ── ambient services ────────────────────────────────────────────────────────

  let sheetInserted = false

  /**
   * Insert the session workspace's stylesheet once.
   *
   * The card borrows `ssh-ws-*` classes from `ssh.session.styles`, which the panel
   * inserts lazily; a conversation that never opened the SSH panel would otherwise
   * render an unstyled card. Idempotent (that module caches its disposer) and
   * retried after a failure, so a late module registry still gets styled.
   */
  function ensureSheet() {
    if (sheetInserted) return
    try {
      const styles = SSH.require('ssh.session.styles')
      if (styles && typeof styles.ensureStyles === 'function') {
        styles.ensureStyles()
        sheetInserted = true
      }
    } catch {
      /* the session kit is absent: the card stays readable, only plainer */
    }
  }

  /** The session kit (translator + primitives), or null in a bare composition. */
  function uiModule() {
    try {
      const ui = SSH.require('ssh.session.ui')
      if (ui && typeof ui.t === 'function') return ui
    } catch {
      /* the card must render without the kit; the key name is the fallback */
    }
    return null
  }

  /** A progress glyph: the kit's spinner, or the plugin's own connecting dot. */
  function progressGlyph(ui) {
    try {
      const primitives = ui !== null && typeof ui.ui === 'function' ? ui.ui() : null
      const Spinner = primitives === null ? null : primitives.Spinner
      if (typeof Spinner === 'function') return h(Spinner, { size: 10 })
    } catch {
      /* fall through to the dot */
    }
    return h('span', { className: 'ssh-ws-dot', 'data-state': 'connecting', 'aria-hidden': 'true' })
  }

  /** Human duration through the kit, with a plain-milliseconds floor. */
  function durationText(ui, ms) {
    try {
      if (ui !== null && typeof ui.formatDuration === 'function') return ui.formatDuration(ms)
    } catch {
      /* fall through */
    }
    return `${Math.round(ms)} ms`
  }

  // ── the card ────────────────────────────────────────────────────────────────

  /**
   * One `ssh_exec` call as a terminal row.
   *
   * @param props - `ToolCallOwnerProps`: `phase`, `block`, `toolName`, `callId`, the
   *   optional `inspect` callback, plus the rest of the owner currency it ignores.
   * @returns the always-present card markup.
   */
  function SshExecCard(props) {
    const settings = isRecord(props) ? props : {}
    // The stylesheet is a side effect, so it belongs to the commit, not the render.
    useEffect(() => {
      ensureSheet()
    }, [])

    const ui = uiModule()
    const t = ui === null ? (key) => key : ui.t

    const block = recordOf(settings.block)
    const phaseProp = stringOf(settings.phase)
    const settled = phaseProp !== null ? phaseProp === 'result' : block !== null && block.kind === 'tool-result'
    const preparing = !settled && (phaseProp !== null ? phaseProp === 'preparing' : block !== null && block.phase === 'preparing')
    const phase = settled ? 'result' : preparing ? 'preparing' : 'start'

    const meta = settled ? recordOf(block === null ? null : block.meta) : null
    const args = readArgs(argsRawOf(block, settled))
    const command = commandOf(args, meta)
    const channels = settled ? channelsOf(block, meta, command) : NO_CHANNELS

    const exitCode = meta === null ? null : numberOf(meta.exitCode)
    const signal = meta === null ? null : stringOf(meta.signal)
    const outcome = meta === null ? null : stringOf(meta.outcome)
    const durationMs = meta === null ? null : numberOf(meta.durationMs)
    const streamId = meta === null ? null : stringOf(meta.streamId)
    const message = (meta === null ? null : stringOf(meta.message)) ?? channels.reason
    const code = codeOf(block, meta)
    const label = args === null ? null : stringOf(args.label)
    const sessionId = (args === null ? null : stringOf(args.sessionId)) ?? (meta === null ? null : stringOf(meta.sessionId))
    const cwd = (args === null ? null : stringOf(args.cwd)) ?? (meta === null ? null : stringOf(meta.cwd))
    const isError = settled && block !== null && block.isError === true

    const state = stateOf({ settled, isError, outcome, exitCode, signal })
    // A clean exit still deserves a word when the capture was truncated: `ok` is the
    // command's own verdict, "Output truncated" is the reader's warning.
    const statusState = state === 'ok' && outcome === 'output-limit' ? 'limit' : state
    const status = STATUS[statusState]
    const failureText = [code, message].filter((part) => part !== null && part !== '').join(': ')

    // ── pills ──
    const pills = []
    if (exitCode !== null) {
      pills.push(
        h(
          'span',
          {
            key: 'exit',
            className: 'ssh-ws-badge',
            'data-outcome': exitCode === 0 ? 'ok' : 'error',
            'data-testid': 'ssh-toolview-exit',
          },
          t('tool.exit', { code: exitCode }),
        ),
      )
    }
    if (signal !== null) {
      pills.push(
        h(
          'span',
          { key: 'signal', className: 'ssh-ws-badge', 'data-outcome': 'error', 'data-testid': 'ssh-toolview-signal' },
          t('tool.signal', { signal }),
        ),
      )
    }
    if (code !== null) {
      pills.push(h('span', { key: 'code', className: 'ssh-ws-badge', 'data-outcome': 'error', 'data-testid': 'ssh-toolview-code' }, code))
    }
    // The status word is skipped on a clean success that already states its exit
    // code: a terminal row should not say the same thing twice.
    if (!(state === 'ok' && exitCode !== null && statusState === 'ok')) {
      pills.push(
        h(
          'span',
          { key: 'status', className: 'ssh-ws-badge', 'data-outcome': status.tone, 'data-testid': 'ssh-toolview-status' },
          state === 'running' ? progressGlyph(ui) : null,
          t(status.key),
        ),
      )
    }
    // ── body ──
    const body = []
    if (!settled) {
      body.push(
        h('div', { key: 'running', className: 'ssh-ws-hint', 'data-testid': 'ssh-toolview-running', style: ROW_STYLE },
          progressGlyph(ui),
          t('tool.running')),
      )
    } else {
      if (state !== 'ok' && failureText !== '') {
        body.push(h('div', { key: 'failure', className: 'ssh-ws-error', 'data-testid': 'ssh-toolview-error' }, failureText))
      }
      for (const channel of ['stdout', 'stderr']) {
        const text = channels[channel]
        if (text === '') continue
        const channelLabel = channel === 'stderr' ? t('tool.stderr') : t('tool.stdout')
        const labelled = channel === 'stderr' || channels.stderr !== ''
        body.push(
          h(
            'div',
            { key: channel, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
            labelled
              ? h('div', { className: 'ssh-ws-hint', 'data-testid': `ssh-toolview-${channel}-label` }, channelLabel)
              : null,
            h(
              'pre',
              {
                className: 'ssh-ws-out',
                'data-testid': `ssh-toolview-${channel}`,
                'data-channel': channel,
                'aria-label': channelLabel,
              },
              text,
            ),
          ),
        )
      }
      if (channels.notes !== '') {
        body.push(
          h('div', { key: 'notes', className: 'ssh-ws-hint', 'data-testid': 'ssh-toolview-notes', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, channels.notes),
        )
      }
      if (body.length === 0) {
        body.push(h('div', { key: 'none', className: 'ssh-ws-hint', 'data-testid': 'ssh-toolview-empty', style: ROW_STYLE }, t('tool.noOutput')))
      }
    }

    // ── facts ──
    const facts = []
    if (durationMs !== null) facts.push(['duration', t('tool.duration', { duration: durationText(ui, durationMs) })])
    if (outcome !== null) facts.push(['outcome', outcome])
    if (streamId !== null) facts.push(['stream', t('tool.stream', { streamId })])
    if (sessionId !== null) facts.push(['session', t('tool.session', { sessionId })])
    if (cwd !== null) facts.push(['cwd', t('tool.cwd', { cwd })])
    if (label !== null) facts.push(['label', label])
    const inspect = typeof settings.inspect === 'function' ? settings.inspect : null
    const footer = facts.length > 0 || inspect !== null
      ? h(
          'div',
          { className: 'ssh-ws-activity-foot', 'data-testid': 'ssh-toolview-facts', style: { padding: '0 8px 6px' } },
          facts.map(([name, text]) => h('span', { key: name, 'data-testid': `ssh-toolview-${name}` }, text)),
          inspect === null
            ? null
            : h(
                'button',
                {
                  key: 'inspect',
                  type: 'button',
                  className: 'ssh-ws-filter',
                  'data-testid': 'ssh-toolview-inspect',
                  onClick: () => {
                    // A host callback is never allowed to take the card down with it.
                    try {
                      inspect()
                    } catch (error) {
                      console.error('[dsh-ssh] inspect failed', error)
                    }
                  },
                },
                t('tool.inspect'),
              ),
        )
      : null

    return h(
      'div',
      {
        className: 'ssh-ws-cmd-pane',
        'data-testid': 'ssh-toolview',
        'data-tool': stringOf(settings.toolName) || TOOL_NAME,
        'data-phase': phase,
        'data-state': state,
        'data-outcome': outcome === null ? undefined : outcome,
        'data-exit-code': exitCode === null ? undefined : String(exitCode),
        'data-signal': signal === null ? undefined : signal,
        'data-truncated': outcome === 'output-limit' ? '1' : undefined,
        // What the card made of `meta`: the three tolerances its tests assert.
        'data-meta': settled ? (block !== null && block.meta === undefined ? 'absent' : meta === null ? 'unusable' : 'record') : 'pending',
        'data-command-available': command === '' ? 'false' : 'true',
        'aria-label': t('tool.title'),
      },
      h(
        'div',
        { className: 'ssh-ws-cmd-pane-head' },
        h('span', { className: 'ssh-ws-cmd-prompt', 'aria-hidden': 'true' }, '$'),
        command === ''
          ? h(
              'span',
              { className: 'ssh-ws-hint', 'data-testid': 'ssh-toolview-command', style: COMMAND_STYLE },
              preparing ? t('tool.pendingCommand') : t('tool.emptyCommand'),
            )
          : h('code', { className: 'ssh-ws-mono', 'data-testid': 'ssh-toolview-command', style: COMMAND_STYLE, title: command }, command),
        h('span', { className: 'ssh-ws-spacer' }),
        pills,
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 8px 0' } }, body),
      footer,
    )
  }

  return { SshExecCard, TOOL_NAME }
})
