/**
 * @module ssh.i18n
 * @order 60
 *
 * Translation for the whole client half (ICD §8.5).
 *
 * The dictionary lives in `ssh.i18n.dict`, which is generated from
 * `locale/{zh,en}.json`; this module only decides *which* locale is active and how
 * a key becomes a string:
 *
 *   1. an explicit choice stored under `dsh-ssh.locale` (ICD §8.6) wins;
 *   2. otherwise the DSH locale service is followed — the panel re-renders when the
 *      user switches language in the shell;
 *   3. `<html lang>` and `navigator.language` are the last resort before `en`.
 *
 * `registerLocale(ctx)` is the ICD §8.1 registration (`ctx.locale.register('ssh', …)`).
 * `ensureRegistered()` calls it lazily from the first rendered component, so the full
 * key set is live even before the plugin body is changed over to it; a registration
 * can never damage the shell because every step is guarded.
 */

SSH.define('ssh.i18n', function (SSH) {
  const { useCallback, useSyncExternalStore } = SSH.react
  const dict = SSH.require('ssh.i18n.dict')

  /** Namespace DSH's locale service keys this dictionary under (ICD §0). */
  const NS = 'ssh'
  /** ICD §8.6 persistence key for an explicit locale override. */
  const STORAGE_KEY = 'dsh-ssh.locale'
  /** Locales the bundle ships, in display order. */
  const LOCALES = Object.freeze(Object.keys(dict.dictionaries))
  /** Missing keys render as themselves; tests rely on that being visible. */
  const ERROR_PREFIX = 'err.'

  function normalizeLocale(value) {
    if (typeof value !== 'string') return null
    const lower = value.trim().toLowerCase().replace(/_/g, '-')
    if (lower === '') return null
    const primary = lower.split('-')[0]
    return LOCALES.includes(primary) ? primary : null
  }

  /** `{name}` interpolation; an unknown placeholder is left untouched on purpose. */
  function interpolate(template, params) {
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
        ? String(params[name])
        : match,
    )
  }

  function readOverride() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      return raw === 'auto' ? null : normalizeLocale(raw)
    } catch {
      return null
    }
  }

  function writeOverride(locale) {
    try {
      if (locale === null || locale === 'auto') window.localStorage.removeItem(STORAGE_KEY)
      else window.localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      /* storage may be unavailable; the in-memory choice still applies */
    }
  }

  /** Locale advertised by the DSH locale service, whichever shape it exposes. */
  function serviceLocale(service) {
    if (!service) return null
    for (const read of ['getSnapshot', 'getLocale']) {
      try {
        if (typeof service[read] === 'function') {
          const value = service[read]()
          const normalized = normalizeLocale(value && value.id ? value.id : value)
          if (normalized) return normalized
        }
      } catch {
        /* a foreign service must never break rendering */
      }
    }
    return null
  }

  function documentLocale() {
    try {
      const fromHtml = normalizeLocale(document.documentElement && document.documentElement.lang)
      if (fromHtml) return fromHtml
    } catch {
      /* no document (tests, SSR) */
    }
    try {
      return normalizeLocale(typeof navigator !== 'undefined' ? navigator.language : null)
    } catch {
      return null
    }
  }

  /**
   * Create a translator. `onChange` is called whenever the active locale changes,
   * which is what makes `useT()` re-render.
   */
  function createI18n(options = {}) {
    const listeners = new Set()
    let service = options.service || null
    let override = readOverride()
    let locale = computeLocale()
    let serviceOff = null
    /** Cached `locale.bind(NS)` for the current service; reset when the service changes. */
    let bound = null
    let boundFor = null

    function computeLocale() {
      return override || serviceLocale(service) || documentLocale() || LOCALES[0]
    }

    /**
     * The shell's own translator for our namespace, used as a *secondary* source.
     *
     * `plugin.js` registers a small M0 dictionary (including `spike.title`) directly
     * with the shell's locale service, and other seats may register more later. Asking
     * the service after our own table means those keys resolve too, without this module
     * having to own them — and without changing the frozen §8.5 key set.
     */
    function serviceTranslate(key, params) {
      if (!service || typeof service.bind !== 'function') return null
      try {
        if (boundFor !== service) {
          bound = service.bind(NS)
          boundFor = service
        }
        if (typeof bound !== 'function') return null
        const value = bound(key)
        if (typeof value === 'string' && value !== '' && value !== key) return interpolate(value, params)
      } catch {
        /* a foreign service must never break rendering */
      }
      return null
    }

    function t(key, params) {
      const table = dict.dictionaries[locale] || {}
      const fallback = dict.dictionaries[LOCALES[0]] || {}
      const text = table[key] ?? fallback[key]
      if (typeof text === 'string') return interpolate(text, params)
      const fromService = serviceTranslate(key, params)
      return fromService === null ? key : fromService
    }

    function snapshot() {
      return locale
    }

    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-ssh] locale listener failed', error)
        }
      }
    }

    function refresh() {
      const next = computeLocale()
      if (next === locale) return locale
      locale = next
      notify()
      return locale
    }

    return {
      t,
      /** `err.<CODE>` for the ICD §5 table. */
      error(code, params) {
        return t(ERROR_PREFIX + code, params)
      },
      has: (key) => typeof (dict.dictionaries[locale] || {})[key] === 'string',
      keys: () => dict.KEYS,
      locales: () => LOCALES,
      getLocale: snapshot,
      /** Explicit choice wins until it is cleared with `'auto'`. */
      setLocale(next) {
        const normalized = next === 'auto' ? null : normalizeLocale(next)
        override = normalized
        writeOverride(next === 'auto' ? 'auto' : normalized)
        return refresh()
      },
      /** Called when the surrounding service gains or changes a locale. */
      attach(next) {
        if (service === next) return
        if (serviceOff) {
          try {
            serviceOff()
          } catch {
            /* ignore */
          }
          serviceOff = null
        }
        service = next || null
        // The bound translator belongs to the previous service; drop it so the next
        // lookup rebinds instead of calling into a detached service.
        bound = null
        boundFor = null
        if (service && typeof service.subscribe === 'function') {
          try {
            serviceOff = service.subscribe(() => refresh())
          } catch {
            serviceOff = null
          }
        }
        refresh()
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      /** Where a key came from, for diagnostics: our table, the shell, or nowhere. */
      describe() {
        return {
          namespace: NS,
          locale,
          source: override ? 'override' : serviceLocale(service) ? 'service' : 'environment',
          locales: [...LOCALES],
          keys: dict.KEYS.length,
          service: Boolean(service),
          serviceBound: typeof bound === 'function' || Boolean(service && typeof service.bind === 'function'),
        }
      },
    }
  }

  let singleton = null

  /**
   * The client-run singleton, wired to whatever runtime exists right now.
   *
   * Created lazily rather than at module definition time because `ssh.plugin`
   * materialises later — reading it here must not create an import cycle.
   */
  function getI18n() {
    const runtime = currentRuntime()
    const service = runtime && runtime.ctx ? safeGet(runtime.ctx, 'locale') : undefined
    if (!singleton) singleton = createI18n({ service })
    else singleton.attach(service)
    return singleton
  }

  function currentRuntime() {
    try {
      const plugin = SSH.require('ssh.plugin')
      return plugin && typeof plugin.currentRuntime === 'function' ? plugin.currentRuntime() : null
    } catch {
      return null
    }
  }

  function safeGet(ctx, name) {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) ?? undefined : undefined
    } catch {
      return undefined
    }
  }

  let registration = null

  /** Register the full dictionaries on a context. Idempotent per context. */
  function registerLocale(ctx) {
    const locale = safeGet(ctx, 'locale')
    if (!locale || typeof locale.register !== 'function') {
      return { ok: false, reason: 'locale service is absent', dispose() {} }
    }
    let dispose = null
    const run = () => {
      try {
        dispose = locale.register(NS, { ...dict.dictionaries })
      } catch (error) {
        // A hot reload re-runs apply() while the *previous* registration is still
        // live (its disposer runs after the new one), so the shell refuses a second
        // registration of the same namespace+locale:
        //   'locale namespace "ssh" already has locale "zh"'
        // Letting that escape disabled the whole dictionary and every string fell
        // back to its key name. The dictionaries are identical by construction, so
        // an already-present registration is success, not failure — and the existing
        // registration keeps serving translations.
        const message = error instanceof Error ? error.message : String(error)
        if (!/already has locale/i.test(message)) throw error
      }
      return dispose
    }
    if (typeof ctx.effect === 'function') ctx.effect(run, 'dsh-ssh: chrome dictionaries')
    else run()
    return {
      ok: true,
      keys: dict.KEYS.length,
      dispose() {
        if (typeof dispose === 'function') dispose()
      },
    }
  }

  /**
   * Register once per client run, from the first component that renders.
   *
   * The plugin body may also call `registerLocale` explicitly (recommended); this
   * path exists so the chrome works against the M0 plugin body, which still ships a
   * three-key dictionary of its own.
   */
  function ensureRegistered() {
    if (registration) return registration
    const runtime = currentRuntime()
    if (!runtime || !runtime.ctx) return null
    try {
      registration = registerLocale(runtime.ctx)
    } catch (error) {
      registration = { ok: false, reason: String(error && error.message) }
    }
    return registration
  }

  /** Translation bound to the live locale; re-renders the caller on a locale change. */
  function useT() {
    const i18n = getI18n()
    ensureRegistered()
    const locale = useSyncExternalStore(
      (listener) => i18n.subscribe(listener),
      () => i18n.getLocale(),
      () => i18n.getLocale(),
    )
    return useCallback((key, params) => i18n.t(key, params), [i18n, locale])
  }

  /**
   * Module-level translator — **the surface other modules look for**.
   *
   * Three lookup conventions are already in use elsewhere in this package, and all of
   * them have to answer, because a miss silently degrades every string to its key name
   * (the incident that produced `panel.title` / `conn.new` in the live panel):
   *
   *   `ssh.i18n.t(key)`                  → session UI kit (`session/ui.js`)
   *   `ssh.chrome.i18n.t(key)`           → connection UI (`conn/ui.js`)
   *   `SSH.i18n(key)`                    → the registry-level slot both probe first
   *
   * The first two are the exports below; the third is assigned at the end of this
   * factory, so it exists the moment this module is materialised.
   */
  function t(key, params) {
    return getI18n().t(key, params)
  }

  /** `err.<CODE>` convenience for the ICD §5 table. */
  function error(code, params) {
    return getI18n().error(code, params)
  }

  const api = {
    NS,
    STORAGE_KEY,
    LOCALES,
    ERROR_PREFIX,
    dictionaries: dict.dictionaries,
    KEYS: dict.KEYS,
    normalizeLocale,
    interpolate,
    createI18n,
    getI18n,
    registerLocale,
    ensureRegistered,
    useT,
    t,
    error,
    /** Diagnostics for the tests, the console and the log tab. */
    describe: () => getI18n().describe(),
    /**
     * One-line self check: does the dictionary resolve, or is everything falling back
     * to key names? Returned rather than thrown so it can be logged safely anywhere.
     */
    selfCheck(key = 'conn.new') {
      const i18n = getI18n()
      const value = i18n.t(key)
      return { key, value, translated: value !== key, locale: i18n.getLocale(), keys: dict.KEYS.length }
    },
  }

  // The registry-level slot: `session/ui.js` checks `SSH.i18n` before it tries the
  // module registry, so it must be a callable translator, not an object.
  try {
    SSH.i18n = t
  } catch {
    /* a frozen registry is not worth failing the module over */
  }

  return api
})
