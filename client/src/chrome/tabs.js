/**
 * @module ssh.chrome.tabs
 * @order 68
 *
 * Multi-session tab strip (ICD §8.3 `TabStrip` props, §8.4 shortcuts).
 *
 * **Composition with the shell.** The shipped right sidebar already renders the dock
 * chips — one per *tab type* (`sidebar.right.pane.tab.title`, M0-SPIKE §4 C2/C3) — and
 * that seat is not ours to take. Those chips answer "which feature is open"; they
 * cannot answer "which of the ten SSH sessions am I looking at", because ten sessions
 * live inside one SSH pane. This strip is that second level: it renders *sessions*
 * inside our own pane and never registers on the shell's dock seats, so the two never
 * fight over the same chrome. What it adds over the dock chips is exactly what the
 * dock cannot do: per-session state dots, drag/keyboard reordering, close-others and
 * the close-a-live-session confirmation.
 *
 * Reordering is a pure `moveTab` over the id list, driven by three input paths — HTML5
 * drag, `Alt+←/→` on the chip, and a direct `onReorder` call from the store owner —
 * because HTML5 drag events do not exist in the headless harness and an untestable
 * reorder path is one that breaks silently.
 */

SSH.define('ssh.chrome.tabs', function (SSH) {
  const { useRef, useState } = SSH.react
  const h = SSH.h

  /** States a chip can project (ICD §8.3 narrows `SessionState` to these three). */
  const TAB_STATES = Object.freeze(['connected', 'connecting', 'error'])
  /** A session that would lose work if its tab were closed in one click. */
  const LIVE_STATES = Object.freeze(['connected', 'connecting'])

  function normalizeState(state) {
    return TAB_STATES.includes(state) ? state : 'idle'
  }

  function isLiveState(state) {
    return LIVE_STATES.includes(state)
  }

  function stateLabelKey(state) {
    return `conn.state.${normalizeState(state)}`
  }

  /** Move one entry of a list; returns a new array. Out-of-range moves are no-ops. */
  function moveTab(tabs, fromIndex, toIndex) {
    const list = [...(tabs || [])]
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return list
    if (fromIndex < 0 || fromIndex >= list.length) return list
    const target = Math.max(0, Math.min(list.length - 1, toIndex))
    if (target === fromIndex) return list
    const [moved] = list.splice(fromIndex, 1)
    list.splice(target, 0, moved)
    return list
  }

  /** Index of a tab by id (or session id), or -1. */
  function indexOfTab(tabs, id) {
    return (tabs || []).findIndex((tab) => tab.id === id || tab.sessionId === id)
  }

  /**
   * The reorder payload handed to `onReorder`.
   *
   * One object argument: `{ id, fromIndex, toIndex, order }`, where `order` is every
   * tab id in its new order — enough for a store to either splice or replace the list
   * without a second round trip.
   */
  function reorderPayload(tabs, fromIndex, toIndex) {
    const list = [...(tabs || [])]
    const next = moveTab(list, fromIndex, toIndex)
    const clampedTo = Math.max(0, Math.min(list.length - 1, toIndex))
    return {
      id: next[clampedTo] ? next[clampedTo].id : null,
      fromIndex,
      toIndex: clampedTo,
      order: next.map((tab) => tab.id),
    }
  }

  /** Which chip should take focus for a key press, or -1 to let the key through. */
  function focusTargetFor(key, index, length) {
    if (length <= 0) return -1
    if (key === 'ArrowRight') return index + 1 >= length ? 0 : index + 1
    if (key === 'ArrowLeft') return index - 1 < 0 ? length - 1 : index - 1
    if (key === 'Home') return 0
    if (key === 'End') return length - 1
    return -1
  }

  /** Reorder step for `Alt+←/→`; -1 when the move would leave the list. */
  function reorderStepFor(key, index, length, altKey) {
    if (altKey !== true) return -1
    const delta = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
    if (delta === 0) return -1
    const next = index + delta
    return next < 0 || next >= length ? -1 : next
  }

  function TabChip(props) {
    const { tab, active, index, count, i18n, onSelect, onRequestClose, onReorder, onFocusIndex, drag } = props
    const state = normalizeState(tab.state)

    const onKeyDown = (event) => {
      // Alt+←/→ reorders; the hint is advertised in the strip's title and README.
      const reorderTo = reorderStepFor(event.key, index, count, event.altKey === true)
      if (reorderTo >= 0 && typeof onReorder === 'function') {
        event.preventDefault()
        onReorder(reorderPayload(props.siblings, index, reorderTo))
        onFocusIndex(reorderTo)
        return
      }
      const focusTo = focusTargetFor(event.key, index, count)
      if (focusTo >= 0) {
        event.preventDefault()
        onFocusIndex(focusTo)
        return
      }
      if (event.key === 'Delete' && typeof onRequestClose === 'function') {
        event.preventDefault()
        onRequestClose(tab)
      }
    }

    return h(
      'div',
      {
        className: 'dsh-ssh-tab',
        'data-testid': 'ssh-tab',
        'data-tab-id': tab.id,
        'data-state': state,
        'data-active': active ? 'true' : 'false',
        'data-index': index,
        'data-over': drag && drag.overIndex === index ? 'true' : 'false',
        draggable: true,
        onDragStart: (event) => {
          if (event.dataTransfer && typeof event.dataTransfer.setData === 'function') {
            try {
              event.dataTransfer.setData('text/plain', String(index))
            } catch {
              /* a browser may refuse; the payload below is the real channel */
            }
          }
          if (drag) drag.setFromIndex(index)
        },
        onDragOver: (event) => {
          event.preventDefault()
          if (drag) drag.setOverIndex(index)
        },
        onDragLeave: () => {
          if (drag && drag.overIndex === index) drag.setOverIndex(-1)
        },
        onDrop: (event) => {
          event.preventDefault()
          const from = drag ? drag.fromIndex : -1
          if (drag) {
            drag.setOverIndex(-1)
            drag.setFromIndex(-1)
          }
          if (from >= 0 && from !== index && typeof onReorder === 'function') {
            onReorder(reorderPayload(props.siblings, from, index))
          }
        },
        onDragEnd: () => {
          if (drag) {
            drag.setOverIndex(-1)
            drag.setFromIndex(-1)
          }
        },
      },
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          className: 'dsh-ssh-tab-main',
          'data-testid': `ssh-tab-main-${tab.id}`,
          tabIndex: active ? 0 : -1,
          'aria-selected': active ? 'true' : 'false',
          'aria-label': `${tab.title} — ${i18n.t(stateLabelKey(state))}`,
          title: `${tab.title}\n${i18n.t('chrome.tabs.reorderHint')}`,
          onClick: () => onSelect(tab),
          onKeyDown,
          onMouseDown: (event) => {
            // Middle click closes, like every other tab strip.
            if (event.button === 1 && typeof onRequestClose === 'function') {
              event.preventDefault()
              onRequestClose(tab)
            }
          },
        },
        h('span', { className: 'dsh-ssh-tab-state', 'data-state': state }),
        h('span', { className: 'dsh-ssh-tab-label' }, tab.title),
      ),
      typeof onRequestClose === 'function'
        ? h(
            'button',
            {
              type: 'button',
              className: 'dsh-ssh-tab-close',
              'data-testid': `ssh-tab-close-${tab.id}`,
              'aria-label': `${i18n.t('chrome.tabs.close')}: ${tab.title}`,
              title: i18n.t('chrome.tabs.close'),
              onClick: () => onRequestClose(tab),
            },
            '×',
          )
        : null,
    )
  }

  /**
   * The frozen `TabStrip` props (ICD §8.3):
   * `{ tabs, activeId, onChange, onClose, onCloseOthers, onReorder }`.
   *
   * Extra optional props: `onNew` (a `+` chip) and `confirmDanger: false` to skip the
   * confirmation routing (used by tests and by a host that confirms elsewhere).
   */
  function TabStrip(props) {
    const { tabs = [], activeId, onChange, onClose, onCloseOthers, onReorder, onNew } = props
    const i18n = SSH.require('ssh.i18n').getI18n()
    const listRef = useRef(null)
    // Drag origin lives in a ref: dragover re-renders (for the drop indicator), and a
    // render must not reset where the drag started.
    const fromIndexRef = useRef(-1)
    const [overIndex, setOverIndex] = useState(-1)
    const drag = {
      get fromIndex() {
        return fromIndexRef.current
      },
      overIndex,
      setFromIndex(value) {
        fromIndexRef.current = value
      },
      setOverIndex,
    }

    const focusIndex = (index) => {
      const root = listRef.current
      if (!root || typeof root.querySelectorAll !== 'function') return
      const chips = root.querySelectorAll('button[role="tab"]')
      const target = chips && chips[index]
      if (target && typeof target.focus === 'function') {
        try {
          target.focus()
        } catch {
          /* focus is best-effort in a headless DOM */
        }
      }
    }

    /**
     * Closing a live session is dangerous (ICD §8.4 / §12): the confirmation is awaited
     * *before* `onClose` runs, so a host cannot forget it by accident.
     */
    const requestClose = (tab) => {
      if (typeof onClose !== 'function') return
      if (props.confirmDanger === false || !isLiveState(tab.state)) {
        onClose(tab)
        return
      }
      SSH.require('ssh.chrome.confirm')
        .danger('closeSession', { label: tab.title, sessionId: tab.sessionId }, { t: i18n.t })
        .then((confirmed) => {
          if (confirmed) onClose(tab)
        })
        .catch((error) => {
          console.error('[dsh-ssh] close confirmation failed', error)
        })
    }

    /** Close-others can close several live sessions at once, so it confirms too. */
    const requestCloseOthers = (keep) => {
      if (typeof onCloseOthers !== 'function') return
      const others = tabs.filter((tab) => tab.id !== keep.id)
      const live = others.filter((tab) => isLiveState(tab.state))
      if (props.confirmDanger === false || live.length === 0) {
        onCloseOthers(keep)
        return
      }
      SSH.require('ssh.chrome.confirm')
        .danger(
          'danger',
          { title: i18n.t('chrome.confirm.closeSession.title'), body: i18n.t('confirm.danger.body') },
          { t: i18n.t },
        )
        .then((confirmed) => {
          if (confirmed) onCloseOthers(keep)
        })
        .catch((error) => {
          console.error('[dsh-ssh] close-others confirmation failed', error)
        })
    }

    const newButton = () =>
      typeof onNew === 'function'
        ? h(
            'button',
            {
              type: 'button',
              className: 'dsh-ssh-tab-tool',
              'data-testid': 'ssh-tab-new',
              title: i18n.t('conn.new'),
              'aria-label': i18n.t('conn.new'),
              onClick: () => onNew(),
            },
            '+',
          )
        : null

    if (tabs.length === 0) {
      return h(
        'div',
        { className: 'dsh-ssh-tabstrip', 'data-testid': 'ssh-tabstrip' },
        h('span', { className: 'dsh-ssh-tabstrip-empty' }, i18n.t('chrome.tabs.empty')),
        h('div', { className: 'dsh-ssh-tabstrip-tools' }, newButton()),
      )
    }

    return h(
      'div',
      { className: 'dsh-ssh-tabstrip', 'data-testid': 'ssh-tabstrip' },
      h(
        'div',
        { className: 'dsh-ssh-tabstrip-inner', role: 'tablist', 'aria-label': i18n.t('chrome.tabs.aria'), ref: listRef },
        tabs.map((tab, index) =>
          h(TabChip, {
            key: tab.id,
            tab,
            siblings: tabs,
            index,
            count: tabs.length,
            active: tab.id === activeId,
            i18n,
            drag,
            onSelect: (selected) => {
              if (typeof onChange === 'function') onChange(selected)
            },
            onRequestClose: typeof onClose === 'function' ? requestClose : undefined,
            onReorder: (payload) => {
              if (typeof onReorder === 'function') onReorder(payload)
            },
            onFocusIndex: focusIndex,
          }),
        ),
      ),
      h(
        'div',
        { className: 'dsh-ssh-tabstrip-tools' },
        typeof onCloseOthers === 'function' && tabs.length > 1
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-ssh-tab-tool',
                'data-testid': 'ssh-tab-close-others',
                title: i18n.t('chrome.tabs.closeOthers'),
                'aria-label': i18n.t('chrome.tabs.closeOthers'),
                onClick: () => requestCloseOthers(tabs.find((tab) => tab.id === activeId) || tabs[0]),
              },
              '⋯',
            )
          : null,
        newButton(),
      ),
    )
  }

  return {
    TAB_STATES,
    LIVE_STATES,
    TabStrip,
    TabChip,
    normalizeState,
    isLiveState,
    stateLabelKey,
    moveTab,
    indexOfTab,
    reorderPayload,
    focusTargetFor,
    reorderStepFor,
  }
})
