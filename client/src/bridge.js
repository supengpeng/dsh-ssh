/**
 * @module ssh.bridge
 * @order 20
 *
 * The only place in the client half that knows how a browser call reaches the
 * host. Everything else in the UI talks to `call()` and `stream()` and is
 * therefore independent of the binding.
 *
 * **Read `docs/CARRIER.md` before changing this file.** It records with source line
 * numbers: the real channel shape (`connection.rpc.call('/api', '<ns>/<method>',
 * { args }, signal)` — the Gateway's own call path), why a locally installed plugin
 * cannot mount its own contribution, the wire-field rule (the host derives it from the
 * **source parameter name**; `assertExactArguments` refuses an unexpected field), the
 * single-JSON-string argument rule (a rich object crosses the carrier lossily — M0 §7.2),
 * the namespace service's **reserved method names** (why ICD §4.5's `remove` is wired as
 * `removePath`), and the exact-route Plan B steps.
 *
 * DSH exposes Remote methods as generated `ctx.remote.<namespace>` faces, but a
 * plugin that is not part of the shipped build has no generated client
 * declarations — it has to find the carrier the composition actually provides.
 * `bridge.probe()` therefore *verifies* each candidate by performing a real
 * `sshPlugin/ping` round trip and keeps the first one that answers, recording
 * every attempt so a failure is diagnosable instead of silent. The M0 transport
 * spike exists to pin this down; once the winner is known the other candidates
 * stay as documented fallbacks.
 */

SSH.define('ssh.bridge', function (SSH) {
  /** Wire namespace: matches `REMOTE_NAMESPACE` in src/protocol.ts. */
  const NS = 'sshPlugin'

  /** Codes the host may carry; anything else degrades to SSH_UNKNOWN. */
  const KNOWN_CODES = new Set([
    'SSH_NET_UNREACHABLE',
    'SSH_NET_REFUSED',
    'SSH_NET_DNS',
    'SSH_NET_RESET',
    'SSH_NET_TIMEOUT',
    'SSH_AUTH_FAILED',
    'SSH_AUTH_METHOD_UNSUPPORTED',
    'SSH_AUTH_KEY_UNREADABLE',
    'SSH_AUTH_PASSPHRASE_REQUIRED',
    'SSH_AUTH_AGENT_UNAVAILABLE',
    'SSH_HOSTKEY_UNKNOWN',
    'SSH_HOSTKEY_MISMATCH',
    'SSH_TIMEOUT_CONNECT',
    'SSH_TIMEOUT_OPERATION',
    'SSH_TIMEOUT_IDLE',
    'SSH_CMD_EXIT_NONZERO',
    'SSH_SFTP_PROTOCOL',
    'SSH_SFTP_NO_SUCH_FILE',
    'SSH_SFTP_TARGET_EXISTS',
    'SSH_SFTP_IS_A_DIRECTORY',
    'SSH_SFTP_DISK_FULL',
    'SSH_SFTP_VERIFY_MISMATCH',
    'SSH_SFTP_TRANSFER_ABORTED',
    'SSH_PERM_DENIED',
    'SSH_PERM_LOCAL_DENIED',
    'SSH_LIMIT_POOL_EXHAUSTED',
    'SSH_LIMIT_QUEUE_FULL',
    'SSH_LIMIT_OUTPUT_TRUNCATED',
    'SSH_CFG_INVALID',
    'SSH_STATE_INVALID',
    'SSH_CANCELLED',
    'SSH_UNKNOWN',
  ])

  const RETRYABLE = new Set([
    'SSH_NET_UNREACHABLE',
    'SSH_NET_REFUSED',
    'SSH_NET_RESET',
    'SSH_NET_TIMEOUT',
    'SSH_TIMEOUT_CONNECT',
    'SSH_TIMEOUT_OPERATION',
    'SSH_TIMEOUT_IDLE',
    'SSH_SFTP_VERIFY_MISMATCH',
    'SSH_SFTP_TRANSFER_ABORTED',
    'SSH_LIMIT_POOL_EXHAUSTED',
    'SSH_LIMIT_QUEUE_FULL',
  ])

  function core() {
    return SSH.require('ssh.core')
  }

  function messageOf(error) {
    return error && error.message ? String(error.message) : String(error)
  }

  function getService(ctx, name) {
    return core().service(ctx, name)
  }

  /** Normalise anything thrown across the wire into the frozen ErrorInfo shape. */
  function normaliseError(error) {
    if (!error) return { code: 'SSH_UNKNOWN', message: 'unknown failure', retryable: false }
    const carried = typeof error.code === 'string' ? error.code : undefined
    const reason = carried && carried.includes('/') ? carried.slice(carried.lastIndexOf('/') + 1) : carried
    const code = reason && KNOWN_CODES.has(reason) ? reason : 'SSH_UNKNOWN'
    const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
    const details = error.details !== undefined ? error.details : undefined
    // A real `Error`, not a bare object: the console prints an Error's message and stack
    // inline, whereas `{code, message}` renders as a folded `Object` — which is exactly
    // how a stream failure stayed invisible (`openShell ended with an error Object`).
    const info = new Error(message)
    info.code = code
    info.retryable = RETRYABLE.has(code)
    if (carried !== undefined && carried !== code) {
      info.details = { ...(details && typeof details === 'object' ? details : { value: details }), carriedCode: carried }
    } else if (details !== undefined) {
      info.details = details
    }
    if (error.cause !== undefined && info.cause === undefined) info.cause = error.cause
    return info
  }

  /**
   * What this page offers a WebSocket-based stream carrier, for diagnostics.
   *
   * `RemoteStreamMuxClient` connects to `ws://<__DSH_TRANSPORT__.streamBaseUrl ??
   * document.baseURI>/api/remote.mux` (`@deepseek-ai/dsh-api-gateway/lib/client.js:728-733`,
   * path at `:106`), and `dsh-client-connection/README.md:28` states that a *static desktop
   * page* has to provide `streamBaseUrl` for the origin of its Host. When it is absent the
   * URL comes from `document.baseURI`, which under a `dsh-app://` shell yields an
   * unreachable `ws://app/…` — a purely client-side failure that leaves no trace on the
   * host. Reporting these three values turns "streams are broken" into a verdict.
   */
  function streamTransportFacts() {
    // Every key is always present, so a caller can read `facts.muxUrl` without guessing
    // whether this environment lacks one (a linkedom test page has no baseURI at all).
    const facts = { streamBaseUrl: null, baseURI: null, muxUrl: null }
    try {
      const globals = globalThis
      const transport = globals.__DSH_TRANSPORT__
      facts.streamBaseUrl =
        transport && typeof transport.streamBaseUrl === 'string' && transport.streamBaseUrl !== '' ? transport.streamBaseUrl : null
      facts.baseURI =
        typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '' ? document.baseURI : null
      const base = facts.streamBaseUrl ?? facts.baseURI
      if (base !== null) {
        const url = new URL('api/remote.mux', base)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        facts.muxUrl = url.href
      }
    } catch (error) {
      facts.error = String(error && error.message ? error.message : error)
    }
    return facts
  }

  /** True for anything that can be consumed with `for await`. */
  function isAsyncIterable(value) {
    return value !== null && value !== undefined && typeof value[Symbol.asyncIterator] === 'function'
  }

  function isIterable(value) {
    return value !== null && value !== undefined && typeof value[Symbol.syncIterator] === 'function'
  }

  /** Wrap a `next()`-style handle into an async iterable. */
  function fromHandle(handle) {
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve(handle.next()),
          return: () => Promise.resolve({ done: true, value: undefined }),
        }
      },
    }
  }

  function asAsyncIterable(value) {
    if (isAsyncIterable(value)) return value
    if (value && typeof value.next === 'function') return fromHandle(value)
    if (isIterable(value)) return (async function* () { for (const item of value) yield item })()
    if (Array.isArray(value)) return (async function* () { for (const item of value) yield item })()
    throw new Error(`stream result is not iterable (${core().describeShape(value)})`)
  }

  // ── Candidate bindings ----------------------------------------------------
  //
  // Each returns `{ call(method, params), open(method, params) }` or null when
  // the composition in force does not offer that carrier. `open` returns
  // something `asAsyncIterable` accepts.
  //
  // Why there are so many: this build's client reaches the host through the API
  // Gateway, whose client face installs a namespace **only** after
  // `ctx.remote.$mount(contribution)` succeeds — and the application's client
  // assembly mounts a fixed, build-time list of generated contributions that does
  // not contain a locally installed plugin like this one
  // (`@deepseek-ai/dsh-api-remotes/lib/client.js`, `apply()` → 23 × `$mount`).
  // A namespace registered on the host at runtime therefore has to be mounted by
  // *us*, with our own contribution, which is what `contribution-mount` below
  // attempts. It is tried after a plain face lookup so an assembly that does
  // provide our namespace keeps working unchanged.

  /** Namespace our host half registers; also the wire namespace. */
  const WIRE_NAMESPACE = 'sshPlugin'

  /**
   * Unary endpoints from ICD §4, as the descriptor list a contribution needs.
   *
   * The Gateway validates contributions strictly (`requireStrictInputs`): every
   * declared parameter must carry a codec whose `mode` is `'strict'`. Our wire
   * convention is ICD §12 R1 form A — **one JSON-string argument** — so one declared
   * parameter is the honest description of our endpoints.
   *
   * **Method names must avoid the namespace service's own members.** The Gateway
   * installs every Remote method onto a `RemoteNamespaceService` instance and refuses
   * a name that is already there:
   *
   *     client api: method "sshPlugin/<name>" conflicts with its namespace service
   *
   * The reserved set (from `@deepseek-ai/dsh-api-gateway/lib/client.js`) is:
   *
   *   - `REMOTE_NAMESPACE_FIELDS`: ctx, empty, invokeRemote, methods, name, namespace;
   *   - that class's own prototype: assertMethodAvailable, has, install, installDirect,
   *     installScoped, **remove**, constructor;
   *   - anything else already on the instance, which includes the Object.prototype
   *     members (toString, valueOf, hasOwnProperty, isPrototypeOf,
   *     propertyIsEnumerable, toLocaleString, __proto__, __defineGetter__,
   *     __defineSetter__, __lookupGetter__, __lookupSetter__) and any cordis `Service`
   *     member.
   *
   * That is why ICD §4.5's `remove` is wired as **`removePath`** on both sides: a
   * method named `remove` was refused at mount time, which silently cost the entire
   * client→host channel. `RESERVED_METHOD_NAMES` below plus the reserved-name test in
   * `test/client/chrome-carrier.test.mjs` stops the next endpoint from repeating it.
   */
  const UNARY_METHODS = [
    'ping', 'getConfig',
    'listProfiles', 'saveProfile', 'deleteProfile', 'duplicateProfile', 'testProfile', 'setSecret', 'clearSecret',
    'connect', 'disconnect', 'listSessions', 'getSession', 'pendingHostKey', 'decideHostKey',
    'execWait', 'shellWrite', 'shellResize', 'shellSignal', 'shellClose', 'listStreams',
    'listDir', 'listLocalDir', 'stat', 'statLocal', 'mkdir', 'rename', 'removePath', 'chmod',
    'cancelTransfer', 'listTransfers', 'queryAudit', 'clearAudit',
  ]

  /**
   * Names a Remote method must not use, as computed from the three rules above.
   *
   * Deliberately a superset of what this build rejects today (cordis `Service` members
   * are version-dependent), so a future endpoint called `dispose` or `updateConfig` is
   * caught here instead of in the user's panel.
   */
  const RESERVED_METHOD_NAMES = Object.freeze([
    'ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace',
    'assertMethodAvailable', 'has', 'install', 'installDirect', 'installScoped', 'remove', 'constructor',
    'dispose', 'start', 'stop', 'config', 'updateConfig', 'state', 'scope', 'isolate', 'effect', 'on', 'emit',
    'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
    '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  ])

  /** Stream endpoints from ICD §4 (`@Remote({ mode: 'stream' })` on the host). */
  const STREAM_METHODS = ['exec', 'openShell', 'followSessions', 'followAudit', 'upload', 'download']

  /**
   * Wire field the host expects for a method's business argument, taken from the host's
   * own signatures in `src/service.ts`.
   *
   * `@deepseek-ai/dsh-api-gateway/lib/index.js` `srcDescriptor()` derives each Remote
   * parameter from the **source parameter name** — `{ name, wire: name, source: 'json',
   * codec: { mode: 'src-json' } }` — so the field is not uniform across our endpoints and
   * a wrong guess is refused with `gateway/arguments-invalid`:
   *
   *   - `ping(params)`                  → `params`   (M0 endpoint)
   *   - `reportSpike(payload)`          → `payload`  (M0 endpoint)
   *   - `followSessions(_raw)`          → `_raw`     (the underscore is part of the name)
   *   - `getConfig()`/`listSessions()`/`listTransfers()`/`clearAudit()` → no parameter, so
   *     `args` must be `{}` (`assertExactArguments` refuses unexpected fields).
   *   - every other endpoint             → `raw`
   *
   * `connection-rpc` sends the mapped field first and probes the candidates below when the
   * host disagrees; `test/client/chrome-carrier.test.mjs` re-derives this table from
   * `src/service.ts` so it cannot drift silently.
   */
  const WIRE_ARG_BY_METHOD = Object.freeze({
    ping: 'params',
    reportSpike: 'payload',
    followSessions: '_raw',
  })

  /** Methods whose host signature takes no argument at all (`args: {}`). */
  const ZERO_ARG_METHODS = Object.freeze(['getConfig', 'listSessions', 'listTransfers', 'clearAudit'])

  /** Probe order when the mapped field is not the one this host wants. */
  const WIRE_ARG_CANDIDATES = Object.freeze(['raw', '_raw', 'params', 'payload'])

  /**
   * A strict codec in the published protocol's shape (`TypertCodec`).
   *
   * `{ mode: 'strict', typeSymbol, create, schema }` — the typert registry validates
   * `typeSymbol` **and** a `create()` factory (`dsh-typert-registry/lib/client.js:1354-1358`:
   * `"… strict codec has no create() factory"`), and boundary decoding calls
   * `codec.create().parse(value)` (host side: `dsh-api-gateway/lib/index.js:1504`). So
   * `create()` returns the parse-capable schema — which is also why a pass-through codec
   * needs no Zod and no new dependency for a bundle whose only external is `react`.
   * The alternative `{ mode: 'src-json' }` needs nothing at all (`:1355` returns early),
   * but the Gateway's client face requires `'strict'` for every declared parameter
   * (`requireStrictInputs`), so strict it is.
   */
  const PASSTHROUGH_SCHEMA = Object.freeze({ parse: (value) => value })
  const STRICT_CODEC = Object.freeze({
    mode: 'strict',
    typeSymbol: 'unknown',
    create: () => PASSTHROUGH_SCHEMA,
    schema: PASSTHROUGH_SCHEMA,
  })

  /**
   * One descriptor, in the shape `@deepseek-ai/dsh-typert-protocol` declares.
   *
   * `id`/`service`/`result` are required by the *typert registry* validator that runs
   * inside `$mount()` (`RemoteStore.register` → `DescriptorStore.validate` →
   * `validateInvocation` → `validateCodec(descriptor.result, …)`), not just by the
   * Gateway's own `validateContribution`.
   */
  function descriptorFor(method, options) {
    const descriptor = {
      id: `@local/dsh-ssh#${WIRE_NAMESPACE}.${method}`,
      service: WIRE_NAMESPACE,
      namespace: WIRE_NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      result: STRICT_CODEC,
      parameters:
        options && options.withoutParameters
          ? []
          : [{ name: 'raw', wire: 'raw', source: 'json', codec: STRICT_CODEC }],
    }
    if (options && options.stream) descriptor.mode = 'stream'
    return descriptor
  }

  /**
   * Contributions to try, most faithful first.
   *
   * Variant 1 declares the JSON-string parameter our host expects. Variant 2 declares
   * none, because a codec object that only satisfies the validator may still fail when
   * the Gateway encodes the call — the ping probe decides, so a wrong variant is
   * discarded rather than adopted.
   */
  function contributionVariants() {
    const pkg = '@local/dsh-ssh'
    return [
      { package: pkg, descriptors: UNARY_METHODS.map((method) => descriptorFor(method)) },
      { package: pkg, descriptors: UNARY_METHODS.map((method) => descriptorFor(method, { withoutParameters: true })) },
      {
        package: pkg,
        descriptors: [
          ...UNARY_METHODS.map((method) => descriptorFor(method)),
          ...STREAM_METHODS.map((method) => descriptorFor(method, { stream: true })),
        ],
      },
    ]
  }

  /** Where an installed namespace face may surface, in the order worth probing. */
  function namespaceFacades(ctx, id) {
    const found = []
    const push = (label, value) => {
      if (value && typeof value === 'object') found.push({ label, value })
    }
    const remote = getService(ctx, 'remote')
    if (remote) {
      push('ctx.remote[NS]', remote[WIRE_NAMESPACE])
      push(`ctx.get('remote.${WIRE_NAMESPACE}')`, getService(ctx, `remote.${WIRE_NAMESPACE}`))
      push('ctx.remote.namespaces[NS]', remote.namespaces && remote.namespaces.get(WIRE_NAMESPACE))
    }
    const typert = getService(ctx, 'typert')
    if (typert) {
      push('ctx.typert.remotes[NS]', typert.remotes && typert.remotes[WIRE_NAMESPACE])
      push('ctx.typert.local[NS]', typert.local && typert.local[WIRE_NAMESPACE])
    }
    return found
  }

  /** Turn a namespace face into a carrier, rejecting faces without our methods. */
  function carrierFromFace(label, face) {
    if (!face || typeof face !== 'object') return null
    const hasPing = typeof face.ping === 'function'
    if (!hasPing) return null
    const call = function (method, params) {
      const fn = face[method]
      if (typeof fn !== 'function') throw new Error(`${label}.${method} is not a function`)
      return fn.call(face, params)
    }
    return { call, open: (method, params) => call(method, params), faceLabel: label }
  }

  /**
   * The fields a contribution must carry, copied from the two validators that run
   * inside `ctx.remote.$mount()`:
   *
   *   1. `@deepseek-ai/dsh-api-gateway/lib/client.js` — `validateContribution()`:
   *      `contribution.descriptors[]` each with `namespace`, `method`,
   *      `invocation.kind`, and a `parameters[]` whose every `codec.mode` is `'strict'`.
   *   2. `@deepseek-ai/dsh-typert-registry` — `RemoteStore.register()` →
   *      `DescriptorStore.validate(descriptors)` → `validateInvocation()`:
   *      `id`, `service`, `namespace`, `method`, optional `implementation`, and a
   *      `result` codec.
   *
   * A mismatch surfaces as `Cannot read properties of undefined (reading 'length')`
   * because the second validator iterates arrays we never supplied. Checking here turns
   * that into a named list of missing fields, which is what the console needs.
   */
  function missingContributionFields(contribution) {
    const missing = []
    if (!contribution || typeof contribution !== 'object') return ['contribution']
    if (typeof contribution.package !== 'string' || contribution.package === '') missing.push('package')
    if (!Array.isArray(contribution.descriptors)) {
      missing.push('descriptors[]')
      return missing
    }
    if (contribution.descriptors.length === 0) missing.push('descriptors[] (empty)')
    contribution.descriptors.forEach((descriptor, index) => {
      const at = `descriptors[${index}]`
      if (!descriptor || typeof descriptor !== 'object') {
        missing.push(at)
        return
      }
      for (const field of ['id', 'service', 'namespace', 'method']) {
        if (typeof descriptor[field] !== 'string' || descriptor[field] === '') missing.push(`${at}.${field}`)
      }
      if (!descriptor.invocation || typeof descriptor.invocation !== 'object' || typeof descriptor.invocation.kind !== 'string') {
        missing.push(`${at}.invocation.kind`)
      }
      if (!descriptor.result || typeof descriptor.result.mode !== 'string') missing.push(`${at}.result (codec)`)
      if (!Array.isArray(descriptor.parameters)) {
        missing.push(`${at}.parameters[]`)
        return
      }
      descriptor.parameters.forEach((parameter, parameterIndex) => {
        const parameterAt = `${at}.parameters[${parameterIndex}]`
        if (typeof parameter.wire !== 'string' || parameter.wire === '') missing.push(`${parameterAt}.wire`)
        if (!parameter.codec || parameter.codec.mode !== 'strict') {
          // The Gateway refuses a non-strict codec outright (`requireStrictInputs`).
          missing.push(`${parameterAt}.codec{mode:'strict'}`)
        }
      })
    })
    return missing
  }

  /**
   * Credential redaction for the diagnostic log.
   *
   * A first attempt redacted by **key name** only, and it leaked a live password: the
   * secret travelled inside the `raw` JSON string under a *generic* key, named by its
   * sibling —
   *
   *     { profileId, field: 'password', value: 'example-not-a-real-secret', persist: true }
   *
   * — so `value` matched nothing. Three rules close that:
   *
   *   1. **Recursive by key name**: any key containing `pass`/`secret`/`token`/`privatekey`/
   *      `credential`/`apikey` is replaced, at any depth (`password`, `passphrase`,
   *      `privateKey`, `secrets.token`, …).
   *   2. **By shape**: an object that *names* a secret in its `field` sibling and carries it
   *      under `value` is redacted too — the `setSecret` shape above.
   *   3. **By value**: every value redacted by rule 1 or 2 is registered, and the whole log
   *      line is scanned for those literals afterwards. A secret that reaches the log
   *      through *any* other route (a nested string, a host sentence, a later call) is
   *      therefore still replaced. This is the client-side equivalent of the host's
   *      `redactors`.
   *
   * The argument is a JSON *string* (ICD §12 R1 form A), so it is parsed before scrubbing —
   * scrubbing the serialized text would be blind to the structure.
   */
  const REDACTED = '«redacted»'
  /** Key names that carry a credential value at any depth. */
  const SECRET_KEY_PATTERN = /pass|secret|token|privatekey|private_key|credential|apikey|api_key/i
  /** Secret literals seen so far, scrubbed from every later log line. */
  const loggedSecretValues = new Set()

  function isSecretKey(key) {
    return typeof key === 'string' && SECRET_KEY_PATTERN.test(key)
  }

  function registerSecretValue(value) {
    if (typeof value === 'string' && value.length >= 3) loggedSecretValues.add(value)
  }

  /** Replace every registered secret literal in a text. */
  function scrubLogged(text) {
    let out = typeof text === 'string' ? text : String(text)
    for (const secret of loggedSecretValues) {
      if (secret !== '' && out.includes(secret)) out = out.split(secret).join(REDACTED)
    }
    return out
  }

  /** Recursively replace credential values (rule 1 and rule 2). */
  function scrubSecrets(node) {
    if (Array.isArray(node)) return node.map((item) => scrubSecrets(item))
    if (node === null || typeof node !== 'object') return node
    const field = typeof node.field === 'string' ? node.field : ''
    const namesSecret = field !== '' && (isSecretKey(field) || field === 'key')
    const out = {}
    for (const [key, value] of Object.entries(node)) {
      if (isSecretKey(key)) {
        registerSecretValue(value)
        out[key] = REDACTED
        continue
      }
      if (key === 'value' && namesSecret) {
        registerSecretValue(value)
        out[key] = REDACTED
        continue
      }
      if (typeof value === 'string' && /^[[{]/.test(value.trim())) {
        // A nested structure may itself be JSON text (that is how it crosses the wire).
        const nested = parseJsonText(value)
        out[key] = nested === undefined ? scrubLogged(value) : scrubSecrets(nested)
        continue
      }
      if (typeof value === 'string') {
        out[key] = scrubLogged(value)
        continue
      }
      out[key] = scrubSecrets(value)
    }
    return out
  }

  function parseJsonText(text) {
    try {
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** Serialize one log payload with every credential replaced (exported for the tests). */
  function redactForLog(payload) {
    let shaped = payload
    if (typeof payload === 'string') {
      const nested = parseJsonText(payload)
      shaped = nested === undefined ? scrubLogged(payload) : scrubSecrets(nested)
    } else {
      shaped = scrubSecrets(payload)
    }
    let text
    try {
      text = typeof shaped === 'string' ? shaped : JSON.stringify(shaped)
    } catch {
      text = String(shaped)
    }
    return scrubLogged(text)
  }

  /**
   * Build marker for this bridge, in the same convention as the plugin body's
   * `ssh-client-…` marker: one greppable string printed when the carrier resolves, so a
   * user can prove which bundle the page actually loaded. It also names the stream entry
   * that answered, because "can this build stream?" is the question a terminal problem
   * turns on.
   */
  const BUILD_MARKER = 'ssh-bridge-2026-09-27.3-stream-signal'

  /**
   * Set once the synthetic contribution was refused (or was missing fields). Retrying it
   * in every 250 ms probe round only repeats the same refusal and floods the console.
   */
  let syntheticMountRefused = false
  /** Why the synthetic mount was refused, replayed in later rounds for diagnostics. */
  let syntheticMountError = null

  const STRATEGIES = [
    {
      id: 'remote-mount',
      label: 'ctx.remote (own contribution mounted when the assembly has not)',
      acquire: async function (ctx) {
        const remote = getService(ctx, 'remote')
        if (!remote) return null

        // 1. The application's client assembly might already install our namespace.
        const direct = carrierFromFace('ctx.remote[sshPlugin]', remote[WIRE_NAMESPACE])
        if (direct) return direct

        const mountErrors = []

        // 2. Mount our own contribution. There is deliberately **no** bare `$mount()`
        //    call any more: `$mount(contribution)` takes a contribution — its absence
        //    surfaced as `Cannot read properties of undefined (reading 'package')` from
        //    the validators, so calling it with no argument only produced a misleading
        //    line in the diagnostics.
        //
        //    The gateway's client face installs a namespace only from a contribution
        //    (`installNamespace(namespace, descriptors)`), and the assembly's own list is
        //    fixed at build time, so a locally installed plugin like this one has to
        //    supply its own descriptor set — which is what `contributionVariants()`
        //    describes.
        if (typeof remote.$mount === 'function') {
          // 2a. Ask the gateway which namespaces the assembly already mounted: a build
          //     whose generated artifact selected us answers here and our face appears.
          for (const candidate of namespaceFacades(ctx)) {
            const carrier = carrierFromFace(candidate.label, candidate.value)
            if (carrier) return carrier
          }

          // 2b. Otherwise mount **our own** contribution. The gateway's client face installs
          //    a namespace only from a contribution (`installNamespace(namespace,
          //    descriptors)`), and the assembly's own list is fixed at build time, so a
          //    locally installed plugin like this one has to supply its own descriptor
          //    set — which is what `contributionVariants()` describes. Each variant is
          //    validated by the gateway; the ping probe in `verify()` is what decides
          //    whether the installed face actually works.
          //
          //    Being honest about the odds: a contribution must satisfy the *typert
          //    registry* too (`id`, `service` and a `result` codec per descriptor), and
          //    the platform reaches those through generated artifacts this package does
          //    not have. So this path is attempted once, its exact refusal is reported,
          //    and the working transport is `connection-rpc` above.
          if (syntheticMountRefused) {
            // Already known to be refused: report the recorded reason instead of silently
            // looking like "no mechanism present", and do not repeat the mount.
            if (syntheticMountError) mountErrors.push(syntheticMountError)
          }
          for (let index = 0; index < contributionVariants().length && !syntheticMountRefused; index += 1) {
            const contribution = contributionVariants()[index]
            const missing = missingContributionFields(contribution)
            if (missing.length > 0) {
              // Our own mistake, reported precisely instead of as `undefined.length`.
              syntheticMountRefused = true
              mountErrors.push(`variant ${index + 1}: contribution is missing ${missing.join(', ')}`)
              console.error('[dsh-ssh] contribution shape check failed', missing)
              break
            }
            try {
              await remote.$mount(contribution)
            } catch (error) {
              mountErrors.push(`variant ${index + 1}: ${messageOf(error)}`)
              continue
            }
            for (const candidate of namespaceFacades(ctx)) {
              const carrier = carrierFromFace(candidate.label, candidate.value)
              if (carrier) return carrier
            }
            mountErrors.push(`variant ${index + 1}: mounted, but no namespace face surfaced`)
          }
          // Every variant was refused (or mounted nothing): remember it — and its exact
          // reason, so later rounds report the same diagnosis instead of repeating the
          // mount or looking as if no mechanism were present.
          syntheticMountRefused = true
          if (mountErrors.length > 0) syntheticMountError = mountErrors.join(' | ')
        } else {
          mountErrors.push('the remote service exposes no $mount()')
        }

        if (mountErrors.length > 0) throw new Error(mountErrors.join(' | '))
        return null
      },
    },
    {
      id: 'typert-remotes',
      label: 'ctx.typert.remotes[<ns>]',
      acquire: async function (ctx) {
        const typert = getService(ctx, 'typert')
        if (!typert) return null
        const containers = [typert.remotes, typert.local].filter(Boolean)
        for (const container of containers) {
          const face = container[NS]
          if (!face) continue
          const call = function (method, params) {
            const fn = face[method]
            if (typeof fn !== 'function') throw new Error(`typert ${NS}.${method} is not a function`)
            return fn.call(face, params)
          }
          return { call, open: (method, params) => call(method, params) }
        }
        return null
      },
    },
    {
      id: 'connection-rpc',
      label: 'ctx.connection.rpc',
      acquire: async function (ctx) {
        const connection = getService(ctx, 'connection')
        const rpc = connection && connection.rpc
        if (!rpc || typeof rpc.call !== 'function') return null

        /** Which stream entry answered (`connection.rpc.open` or `remote.streams`). */
        let streamCarrier = null

        /**
         * The authenticated RPC carrier, exactly as the Gateway's own client face uses it.
         *
         * `@deepseek-ai/dsh-api-gateway/lib/client.js` invokes every Remote method through
         *
         *     connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)
         *
         * and `@deepseek-ai/dsh-client-connection/lib/client.js` implements that as
         * `POST /api/<namespace>/<method>` with a correlated JSON envelope, validating the
         * target as segments matching `/^[A-Za-z0-9_$.-]+$/` (so `sshPlugin/ping` is a legal
         * two-segment endpoint) and returning the server envelope's `result`.
         *
         * This is the channel we want: it is the platform's authenticated fence, it needs
         * no generated artifact and no codec from our bundle, and it is what a mounted
         * namespace would end up calling anyway.
         */
        const endpointOf = (method) => `${NS}/${method}`

        /** Wire field carrying the business argument, tried in order (see the host rules). */
        const ARG_KEYS = WIRE_ARG_CANDIDATES
        /** Remembered per method once a call succeeds, so probing costs nothing later. */
        const argKeyByMethod = new Map()

        /**
         * Candidate `args` objects for one call.
         *
         * The host derives the wire field from the **source parameter name** of the method
         * (`srcDescriptor()` → `{ name, wire: name, source: 'json', codec: { mode: 'src-json' } }`),
         * so our endpoints differ: `ping(params)` → `params`, `reportSpike(payload)` →
         * `payload`, `followSessions(_raw)` → `_raw`, `raw` for the rest, and
         * `getConfig()`/`listSessions()`/… declare no parameter at all.
         * `assertExactArguments()` accepts a *missing* src-json parameter but rejects an
         * *unexpected* key, which is why a wrong guess arrives as
         * `gateway/arguments-invalid` and the next candidate is tried.
         */
        const argCandidates = (method, params) => {
          if (params === undefined) return [{}]
          const value = encodeArg(params)
          const known = argKeyByMethod.get(method) || WIRE_ARG_BY_METHOD[method]
          const keys = known ? [known, ...ARG_KEYS.filter((key) => key !== known)] : ARG_KEYS
          // A trailing `{}` covers a zero-argument endpoint called with a stray argument:
          // the host then runs the method without it and answers with its own argument
          // error (`SSH_CFG_INVALID`), which is clearer than a shape mismatch.
          return [...keys.map((key) => ({ [key]: value })), {}]
        }

        /** `{ok:true,value}` → value, `{ok:false,error}` → throw, anything else → as-is. */
        const unwrap = (result) => {
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            if (result.ok === false && result.error) {
              const failure = result.error
              throw {
                code: typeof failure.code === 'string' ? failure.code : 'SSH_UNKNOWN',
                message: typeof failure.message === 'string' ? failure.message : String(failure.message ?? 'remote call failed'),
                details: failure.details,
              }
            }
            if (result.ok === true && Object.prototype.hasOwnProperty.call(result, 'value')) return result.value
          }
          return result
        }

        /**
         * Encode the business argument the way the host expects to receive it: **one JSON
         * string** (ICD §12 R1 form A / R1.3).
         *
         * This is not cosmetic. `src/api/params.ts` records the measured reason: a
         * source-mode endpoint has no generated parameter codec, and the carrier's
         * delivery of a *rich* payload is lossy — "a six-key object arrived as two keys,
         * dropping even the string after the nested object" (M0 §7.2). A nested structure
         * must therefore cross the wire as text, which the host's `decodePayload()` parses
         * back. Sending the object directly is what produced a bare `SSH_CFG_INVALID`
         * ("参数校验失败") with no field name in it.
         */
        const encodeArg = (params) => {
          if (params === undefined || params === null) return undefined
          if (typeof params === 'string') return params
          try {
            return JSON.stringify(params)
          } catch {
            // A cyclic or otherwise unencodable payload is passed through so the host
            // answers with its own diagnostic instead of us inventing one.
            return params
          }
        }

        /** One compact line per direction, as the Lead asked: body out, envelope back. */
        const describeArgs = (args) => {
          let text = '{}'
          try {
            text = redactForLog(args)
          } catch {
            text = '<unencodable>'
          }
          return text.length > 400 ? `${text.slice(0, 400)}…` : text
        }
        const describeResult = (result) => {
          if (result && typeof result === 'object' && result.ok === false && result.error) {
            return scrubLogged(`error ${result.error.code ?? '?'}: ${result.error.message ?? ''}`)
          }
          if (result && typeof result === 'object' && result.ok === true) return 'ok'
          return `ok (${typeof result})`
        }

        /** One unary call, probing the argument shape when the host refuses ours. */
        const callWithArgs = async (method, params, options) => {
          const candidates = argCandidates(method, params)
          let lastError = null
          for (let index = 0; index < candidates.length; index += 1) {
            const endpoint = endpointOf(method)
            try {
              console.info(`[dsh-ssh] rpc send ${endpoint} ${describeArgs({ args: candidates[index] })}`)
              const result = await rpc.call('/api', endpoint, { args: candidates[index] }, options && options.signal)
              console.info(`[dsh-ssh] rpc recv ${endpoint} ${describeResult(result)}`)
              const key = Object.keys(candidates[index])[0]
              if (key !== undefined) argKeyByMethod.set(method, key)
              return unwrap(result)
            } catch (error) {
              lastError = error
              const code = error && typeof error.code === 'string' ? error.code : ''
              const refusedArgs = code.includes('arguments-invalid') || code.includes('input-invalid')
              console.warn(`[dsh-ssh] rpc recv ${endpoint} error ${code || '(none)'}: ${messageOf(error)}`)
              if (!refusedArgs || index === candidates.length - 1) throw error
            }
          }
          throw lastError
        }

        /**
         * The platform's two stream entries, in the order the Gateway itself tries them
         * (`@deepseek-ai/dsh-api-gateway/lib/client.js:1651-1655`):
         *
         *   1. `connection.rpc.open?('/api', endpoint, payload, signal, uplink)` — an
         *      in-process stream opener. A plain Web composition does **not** provide one,
         *      which is why every attempt used to die with "no stream opener".
         *   2. `remote.streams.open(endpoint, payload, signal, uplink)` — the Gateway's own
         *      `RemoteStreamMuxClient` (`:325`), "one physical WebSocket shared among
         *      independently cancellable Remote streams" (`:320-323`). The Gateway **starts
         *      it for us** whenever `connection.rpc.open === undefined` (`:1600`), and its
         *      `open()` is an `async *` generator (`:374`) yielding the host's ICD §3 frames
         *      (`open`/`data`/`end`/`error`), multiplexed by `streamId`.
         *
         * **`signal` is mandatory**, in this exact position: `open()` begins with
         * `signal.throwIfAborted()` (`:375`) and registers `signal.addEventListener('abort',
         * …)` (`:388`). Passing `undefined` there is what produced the reported
         * `Cannot read properties of undefined (reading 'throwIfAborted')` — a failure that
         * happens entirely inside the client, leaving no trace on the host.
         *
         * Both entries take the same `(endpoint, payload, signal, uplink)` payload rule as a
         * unary call, so the single JSON-string argument applies here too.
         */
        const openStream = (method, params, options) => {
          const endpoint = endpointOf(method)
          const key = WIRE_ARG_BY_METHOD[method] || 'raw'
          const args = params === undefined ? {} : { [key]: encodeArg(params) }
          console.info(`[dsh-ssh] rpc stream ${endpoint} ${describeArgs({ args })}`)

          // The caller's signal when it has one, otherwise ours — never `undefined`.
          const controller = new AbortController()
          const callerSignal = options && options.signal
          const signal = callerSignal || controller.signal
          if (callerSignal && typeof callerSignal.addEventListener === 'function') {
            if (callerSignal.aborted) controller.abort(callerSignal.reason)
            else callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true })
          }

          if (typeof rpc.open === 'function') {
            const opened = rpc.open('/api', endpoint, { args }, signal, undefined)
            return opened && typeof opened.then === 'function' ? opened : Promise.resolve(opened)
          }

          const remote = getService(ctx, 'remote')
          const mux = remote && remote.streams
          if (mux && typeof mux.open === 'function') {
            streamCarrier = 'remote.streams'
            // The mux owns a WebSocket (`:507`). Its failures are the ones that used to be
            // invisible: they happen *before* the host is contacted, so the host log shows
            // nothing at all. Enrich them with the transport facts so the next console line
            // says whether this page has a stream origin or is falling back to
            // `document.baseURI` (unreachable under `dsh-app://`).
            const facts = streamTransportFacts()
            return (async function* streamViaMux() {
              try {
                yield* mux.open(endpoint, { args }, signal, undefined)
              } catch (error) {
                const failure = error instanceof Error ? error : new Error(String((error && error.message) || error))
                // Preserve whatever the host already told us: a mid-stream failure carries
                // its own ICD §5 code (`SSH_NET_RESET`, …) and it must not be rewritten.
                if (typeof failure.code !== 'string' && error && typeof error.code === 'string') failure.code = error.code
                if (failure.details === undefined && error && error.details !== undefined) failure.details = error.details
                if (typeof failure.retryable !== 'boolean' && error && typeof error.retryable === 'boolean') {
                  failure.retryable = error.retryable
                }
                failure.code = typeof failure.code === 'string' ? failure.code : 'SSH_NET_UNREACHABLE'
                if (typeof failure.retryable !== 'boolean') failure.retryable = true
                failure.details = {
                  ...(failure.details && typeof failure.details === 'object' ? failure.details : {}),
                  streamCarrier: 'remote.streams',
                  ...facts,
                  hint:
                    /throwIfAborted|AbortSignal/.test(failure.message)
                      ? 'the mux was called without a usable AbortSignal; this is a bridge bug, not a host problem'
                      : facts.streamBaseUrl === null
                        ? 'this page provides no __DSH_TRANSPORT__.streamBaseUrl, so the Gateway mux WebSocket is derived from document.baseURI and cannot reach the host'
                        : 'the Gateway mux WebSocket at muxUrl did not answer; check that the Host serves /api/remote.mux',
                }
                console.warn(
                  `[dsh-ssh] stream carrier failed for ${endpoint}: ${failure.code}: ${failure.message} ` +
                    `(streamBaseUrl=${String(facts.streamBaseUrl)} baseURI=${String(facts.baseURI)} muxUrl=${String(facts.muxUrl)})`,
                )
                throw failure
              } finally {
                // Reached when the consumer stops early (`break`/`cancel()` → return()),
                // which is what releases the multiplexed subscription.
                if (!controller.signal.aborted) controller.abort()
              }
            })()
          }

          // Neither entry exists: this is a **capability** gap, not an unknown failure.
          // `SSH_NET_UNREACHABLE` is the ICD §5 code for "the link cannot carry this",
          // and it is retryable: a composition that gains the mux (or a carrier with an
          // in-process opener) starts working without a reload.
          streamCarrier = null
          const failure = {
            code: 'SSH_NET_UNREACHABLE',
            message:
              `this build exposes no stream carrier for ${endpoint}: neither connection.rpc.open nor ctx.remote.streams is available, ` +
              'so terminal, exec, transfer progress, live session/audit logs and probeStream cannot start. ' +
              'Unary calls (connect, profiles, files, secrets) keep working.',
            retryable: true,
            details: { reason: 'no-stream-carrier', endpoint },
          }
          console.warn(`[dsh-ssh] no stream carrier: ${failure.message}`)
          throw failure
        }

        return {
          id: 'connection-rpc',
          call: (method, params, options) => callWithArgs(method, params, options),
          callForms: [(method, params) => callWithArgs(method, params)],
          open: openStream,
          /** Which stream entry answered, for diagnostics and the build marker. */
          streamCarrier: () => streamCarrier,
          /** Exposed for the tests: the wire field chosen for a method, once known. */
          argKeyFor: (method) => argKeyByMethod.get(method),
        }
      },
    },
  ]

  /**
   * Create the bridge for one client run.
   * @param ctx the restricted client Cordis context handed to `apply`.
   */
  function createBridge(ctx) {
    let resolvedId = null
    let carrier = null
    let resolvePromise = null
    const attempts = []
    const transportListeners = new Set()
    let transport = { kind: 'unknown', status: 'connecting', generation: 0 }
    /**
     * Set once the full retry window failed. Further calls then probe once instead of
     * blocking for the whole window again, while a background timer keeps looking for a
     * carrier that mounts late — fast failure *and* automatic recovery.
     */
    let exhausted = false
    let recoveryTimer = null

    function publishTransport(patch) {
      transport = { ...transport, ...patch, generation: transport.generation + 1 }
      for (const listener of [...transportListeners]) {
        try {
          listener(transport)
        } catch (error) {
          console.error('[dsh-ssh] transport listener failed', error)
        }
      }
    }

    /**
     * Record one carrier attempt.
     *
     * Keyed by (carrier, stage) rather than appended: `resolve()` re-runs after a
     * failure, and a transcript that grew on every retry would bury the reason
     * the first attempt failed.
     */
    function recordAttempt(id, ok, error, extra) {
      const stage = extra && extra.stage
      const entry = {
        id,
        ok,
        at: new Date().toISOString(),
        error: error ? normaliseError(error) : undefined,
        extra: extra || undefined,
      }
      const existing = attempts.findIndex(
        (candidate) => candidate.id === id && (candidate.extra && candidate.extra.stage) === stage,
      )
      if (existing >= 0) attempts[existing] = entry
      else attempts.push(entry)
    }

    /** Verify one candidate against a real ping; the round trip is the proof. */
    async function verify(id) {
      const strategy = STRATEGIES.find((candidate) => candidate.id === id)
      if (!strategy) throw new Error(`unknown bridge strategy "${id}"`)
      let acquired = null
      try {
        acquired = await strategy.acquire(ctx)
      } catch (error) {
        recordAttempt(id, false, error, { stage: 'acquire' })
        return null
      }
      if (!acquired) {
        recordAttempt(id, false, undefined, { stage: 'acquire', note: 'carrier not offered' })
        return null
      }
      try {
        // Verify against the first call shape that answers; a carrier may expose
        // several, and only a real answer distinguishes the right one.
        const forms = acquired.callForms || [acquired.call]
        let lastError = null
        for (let index = 0; index < forms.length; index++) {
          try {
            const answer = await forms[index]('ping', { echo: `spike:${id}` })
            if (answer && answer.pong === true) {
              resolvedId = id
              carrier = { ...acquired, call: forms[index] }
              recordAttempt(id, true, undefined, { stage: 'ping', formIndex: index, answer })
              publishTransport({ kind: id, status: 'ready' })
              return answer
            }
            lastError = new Error('ping answered without pong')
          } catch (error) {
            lastError = error
          }
        }
        recordAttempt(id, false, lastError, { stage: 'ping' })
        return null
      } catch (error) {
        recordAttempt(id, false, error, { stage: 'ping' })
        return null
      }
    }

    /** Try every candidate in order, remembering the first that answers. */
    async function resolve() {
      if (carrier) return resolvedId
      if (resolvePromise) return resolvePromise
      resolvePromise = (async () => {
        for (const strategy of STRATEGIES) {
          const answer = await verify(strategy.id)
          if (answer) return resolvedId
        }
        return null
      })()
      try {
        return await resolvePromise
      } finally {
        resolvePromise = null
      }
    }

    /** One console line per candidate: name, what was probed, and why it did not work. */
    function logAttempts(prefix) {
      try {
        const lines = attempts.map((entry, index) => {
          const stage = (entry.extra && entry.extra.stage) || 'probe'
          if (entry.ok) return `${index + 1}. ${entry.id} → ok (${stage})`
          const reason =
            (entry.extra && entry.extra.note) ||
            (entry.error && entry.error.message) ||
            'no reason recorded'
          return `${index + 1}. ${entry.id} → ${stage}: ${reason}`
        })
        const namespaces = STRATEGIES.map((strategy) => strategy.label).join(' | ')
        console.info(`[dsh-ssh] carrier attempts: ${prefix}`)
        for (const line of lines) console.info(`[dsh-ssh]   ${line}`)
        console.info(`[dsh-ssh]   candidates: ${namespaces}`)
      } catch {
        /* diagnostics must never break a call */
      }
    }

    /**
     * Resolve with a bounded retry.
     *
     * A carrier can be mounted *after* our `apply()` (that is the normal case for
     * anything the shell installs lazily), so a single failed probe is a snapshot, not
     * a verdict. While the window is open the transport stays `connecting` — the panel
     * must not paint a terminal failure from an early probe.
     */
    async function resolveWithRetry(options = {}) {
      const intervalMs = typeof options.intervalMs === 'number' ? options.intervalMs : 250
      const requested = typeof options.timeoutMs === 'number' ? options.timeoutMs : 15000
      // Already exhausted once: probe once so the UI stays responsive, and let the
      // background recovery timer find a late carrier.
      let timeoutMs = exhausted ? Math.min(requested, intervalMs) : requested
      let deadline = Date.now() + Math.max(0, timeoutMs)
      let round = 0
      for (;;) {
        const id = await resolve()
        if (id) {
          exhausted = false
          stopRecovery()
          // The build marker exists so a user can prove *which* bundle the page loaded
          // without reading the console for a timestamp. It names the stream carrier this
          // build can reach, which is the fact a terminal problem turns on.
          const streamEntry = carrier && typeof carrier.streamCarrier === 'function' ? carrier.streamCarrier() : null
          console.info(`[dsh-ssh] carrier resolved: ${id}`)
          console.info(`[dsh-ssh] ${BUILD_MARKER} stream=${streamEntry || (carrier && typeof carrier.open === 'function' ? 'carrier' : 'none')}`)
          return id
        }
        round += 1
        // One exhaustive transcript is enough; later rounds would only repeat it.
        if (round === 1) {
          logAttempts(`no candidate answered (waiting up to ${timeoutMs}ms)`)
          // Nothing to wait for *yet*: no candidate mechanism is even present
          // ("carrier not offered" everywhere). Waiting the full window would freeze
          // every panel action, so fail fast and keep the background recovery timer
          // looking — a service that mounts late still gets picked up.
          if (nothingOffered()) {
            timeoutMs = Math.min(timeoutMs, 1000)
            deadline = Date.now() + timeoutMs
            console.info('[dsh-ssh] no carrier mechanism present yet; failing fast, recovery timer armed')
          }
        }
        if (Date.now() >= deadline) {
          if (!exhausted) {
            exhausted = true
            publishTransport({ status: 'lost', kind: 'none' })
            console.error(`[dsh-ssh] carrier unresolved after ${round} probe(s) and ${timeoutMs}ms`)
            scheduleRecovery()
          }
          return null
        }
        publishTransport({ status: 'connecting' })
        await new Promise((done) => setTimeout(done, intervalMs))
      }
    }

    /** True when every candidate reported that the composition simply has no such seat. */
    function nothingOffered() {
      if (attempts.length === 0) return false
      return attempts.every((entry) => !entry.ok && !entry.error && entry.extra && entry.extra.note === 'carrier not offered')
    }

    /**
     * Keep looking for a carrier that appears after the window closed.
     *
     * Nothing in the panel should be permanently dead because the transport was late;
     * the moment a probe answers, `resolve()` publishes `ready` and the UI recovers.
     */
    function scheduleRecovery() {
      if (recoveryTimer !== null) return
      const timer = setInterval(async () => {
        if (carrier) {
          stopRecovery()
          return
        }
        const id = await resolve()
        if (id) {
          exhausted = false
          console.info(`[dsh-ssh] carrier recovered after exhaustion: ${id}`)
          stopRecovery()
        }
      }, 5000)
      // Node keeps the process alive for pending timers; browsers return a number.
      if (timer && typeof timer.unref === 'function') timer.unref()
      recoveryTimer = timer
    }

    function stopRecovery() {
      if (recoveryTimer === null) return
      try {
        clearInterval(recoveryTimer)
      } catch {
        /* ignore */
      }
      recoveryTimer = null
    }

    /**
     * The failure a caller sees when the transport is not up yet.
     *
     * `retryable` and a §5 code that renders as a sentence (`err.SSH_NET_UNREACHABLE`)
     * keep it out of the "terminal error" bucket in the UI: the panel shows a retry
     * affordance instead of a developer note. The technical transcript stays in
     * `details.attempts` for `bridge.diagnostics()`.
     */
    function transportNotReady() {
      return {
        code: 'SSH_NET_UNREACHABLE',
        message: 'no working client→host carrier is available yet (transport-not-ready); retrying is safe',
        retryable: true,
        details: { reason: 'transport-not-ready', attempts },
      }
    }

    async function call(method, params, opts) {
      const options = opts || {}
      if (!carrier) {
        // Re-resolve on *every* call: the first failure must not be sticky.
        const id = await resolveWithRetry({
          timeoutMs: options.resolveTimeoutMs,
          intervalMs: options.resolveIntervalMs,
        })
        if (!id) throw transportNotReady()
      }
      try {
        const result = carrier.call(method, params)
        const value = await (options.timeoutMs ? withTimeout(result, options.timeoutMs) : result)
        // A successful round trip is the proof the transport is usable, so recover the
        // published state instead of leaving an earlier probe's failure on screen.
        if (transport.status !== 'ready') publishTransport({ kind: resolvedId, status: 'ready' })
        return value
      } catch (error) {
        throw normaliseError(error)
      }
    }

    function withTimeout(promise, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`bridge call timed out after ${timeoutMs}ms`)), timeoutMs)
        Promise.resolve(promise).then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    /**
     * Subscribe to a stream method.
     * @returns `{ streamId, cancel(), done }` — `streamId` fills in from the
     *          first `open` frame, so callers read it off the frame instead.
     */
    function stream(method, params, onFrame, opts) {
      const options = opts || {}
      let cancelled = false
      let handle = null
      let streamId = null
      const state = { streamId: null, frames: 0, lastSeq: -1, ended: false, error: null }

      const done = (async () => {
        if (!carrier) {
          const id = await resolveWithRetry({
            timeoutMs: options.resolveTimeoutMs,
            intervalMs: options.resolveIntervalMs,
          })
          if (!id) {
            const info = transportNotReady()
            info.message = 'no working client→host carrier is available yet; the stream was not opened'
            state.error = info
            onFrame({ t: 'end', streamId: 'st_unknown', reason: 'error', error: info })
            return state
          }
        }
        try {
          const opened = await carrier.open(method, params, options)
          // A stream method may hand back a handle with its own stream id.
          if (opened && typeof opened === 'object' && typeof opened.streamId === 'string') {
            streamId = opened.streamId
            state.streamId = streamId
          }
          handle = opened
          for await (const frame of asAsyncIterable(opened)) {
            if (cancelled) break
            if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') {
              console.warn('[dsh-ssh] dropping malformed frame', frame)
              continue
            }
            if (frame.t === 'open' && typeof frame.streamId === 'string') {
              streamId = frame.streamId
              state.streamId = frame.streamId
            }
            if (frame.t === 'data') {
              if (typeof frame.seq === 'number') {
                if (frame.seq <= state.lastSeq) continue // duplicate after a reconnect
                state.lastSeq = frame.seq
              }
              state.frames += 1
            }
            if (frame.t === 'end') {
              state.ended = true
              if (frame.error) state.error = frame.error
            }
            onFrame(frame)
            if (frame.t === 'end') break
          }
        } catch (error) {
          const info = normaliseError(error)
          state.error = info
          if (!cancelled) {
            onFrame({ t: 'end', streamId: streamId || 'st_unknown', reason: 'error', error: info })
          }
        }
        return state
      })()

      return {
        get streamId() {
          return streamId
        },
        get state() {
          return state
        },
        cancel() {
          cancelled = true
          try {
            if (handle && typeof handle.dispose === 'function') handle.dispose()
            else if (handle && typeof handle.return === 'function') handle.return()
            else if (handle && typeof handle.close === 'function') handle.close()
          } catch (error) {
            console.warn('[dsh-ssh] stream cancel failed', error)
          }
          try {
            if (options.signal && typeof options.signal.removeEventListener === 'function') {
              options.signal.removeEventListener('abort', onAbort)
            }
          } catch {
            /* ignore */
          }
        },
        done,
      }

      function onAbort() {
        try {
          if (handle && typeof handle.dispose === 'function') handle.dispose()
        } catch {
          /* ignore */
        }
      }
    }

    /** Candidate inventory + the probe transcript, for the UI and for bug reports. */
    function diagnostics() {
      const serviceOf = {
        'remote-mount': 'remote',
        'contribution-mount': 'remote',
        'typert-remotes': 'typert',
        'connection-rpc': 'connection',
      }
      const inventory = STRATEGIES.map((strategy) => {
        const name = serviceOf[strategy.id]
        let present = false
        try {
          present = Boolean(name && getService(ctx, name))
        } catch {
          present = false
        }
        return { id: strategy.id, label: strategy.label, service: name || null, servicePresent: present }
      })
      const serviceShapes = {}
      for (const name of ['remote', 'typert', 'connection', 'slots', 'locale', 'sidebarRightTabs', 'sidebarRight']) {
        serviceShapes[name] = core().describeShape(getService(ctx, name))
      }
      return { resolvedId, transport, exhausted, attempts: [...attempts], inventory, serviceShapes }
    }

    return {
      call,
      stream,
      resolve,
      probe: () => call('ping', { echo: 'ui' }),
      diagnostics,
      transportState: () => transport,
      onTransportChange(listener) {
        transportListeners.add(listener)
        return () => transportListeners.delete(listener)
      },
      context: () => ({ namespace: NS, resolvedId, pluginId: SSH.id }),
      /** Stop the recovery timer when the client run goes away. */
      dispose() {
        stopRecovery()
      },
    }
  }

  return {
    createBridge,
    STRATEGIES: STRATEGIES.map((s) => ({ id: s.id, label: s.label })),
    normaliseError,
    /** Endpoint names our descriptors declare (ICD §4), for the reserved-name test. */
    UNARY_METHODS,
    STREAM_METHODS,
    /** Names a Remote method may not use on this platform (gateway `remove` etc.). */
    RESERVED_METHOD_NAMES,
    /** Wire fields the host may expect for a method's argument, in probe order. */
    WIRE_ARG_CANDIDATES,
    WIRE_ARG_BY_METHOD,
    ZERO_ARG_METHODS,
    /** Contribution fields `$mount()` validates; exported so the check is testable. */
    missingContributionFields,
    descriptorFor,
    /** Credential redactor for the diagnostic log (never print a secret). */
    redactForLog,
    /** Secret literals already seen, so a test can prove the registry is populated. */
    loggedSecretValues,
    /** Proof-of-load string, also printed when the carrier resolves. */
    BUILD_MARKER,
    /** WebSocket/transport facts the mux depends on (streamBaseUrl, baseURI, muxUrl). */
    streamTransportFacts,
    NS,
  }
})
