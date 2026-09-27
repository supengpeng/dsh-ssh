/**
 * @module ssh.conn
 * @order 140
 *
 * The connection manager's integration surface: one `configure()` for the plugin
 * body, one `components()` for the container, and the stylesheet entry point.
 *
 * ```js
 * const conn = SSH.require('ssh.conn')
 * conn.configure({ app, api: SSH.require('ssh.conn.api'), chrome: SSH.require('ssh.chrome') })
 * const { ConnList, ConnForm } = conn.components()
 * ```
 */

SSH.define('ssh.conn', function (SSH) {
  const ui = () => SSH.require('ssh.conn.ui')
  const api = () => SSH.require('ssh.conn.api')
  const list = () => SSH.require('ssh.conn.list')
  const form = () => SSH.require('ssh.conn.form')

  /**
   * Wire the store, the endpoint client and (optionally) the chrome.
   * The store gets the endpoint client attached as its *connector*, which is what
   * lets `actions.*` perform calls without any component touching the bridge.
   */
  function configure(wiring = {}) {
    const endpoint = wiring.api ?? api()
    if (wiring.app && typeof wiring.app.actions.attachConnector === 'function') {
      wiring.app.actions.attachConnector(endpoint)
    }
    endpoint.configure({ bridge: wiring.bridge ?? null, app: wiring.app ?? null })
    ui().configure({ app: wiring.app ?? null, api: endpoint, chrome: wiring.chrome ?? null })
    return { endpoint, app: wiring.app ?? null }
  }

  /** The two components the container mounts. */
  function components() {
    return {
      ConnList: list().ConnList,
      ConnForm: form().ConnForm,
    }
  }

  /** Idempotent; the session workspace's sheet is pulled in by the same call. */
  function installStyles() {
    ui().ensureStyles()
  }

  return {
    configure,
    components,
    installStyles,
    api,
    ui,
    /** The chrome module this surface found (or null): `TabStrip`, `StatusBar`, `danger`. */
    chrome: () => ui().chrome(),
    // Re-exported so a caller (or a test) can reach the policies directly.
    helpers: () => {
      const module = ui()
      return {
        groupProfiles: module.groupProfiles,
        matchesQuery: module.matchesQuery,
        secretSummary: module.secretSummary,
        toProfileInput: module.toProfileInput,
        errorText: module.errorText,
        targetOf: module.targetOf,
      }
    },
  }
})
