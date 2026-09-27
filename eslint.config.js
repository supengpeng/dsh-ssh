/**
 * ESLint flat config for @local/dsh-ssh.
 *
 * Scope decision (documented in docs/TESTING.md):
 *   - TypeScript under `src/**` is gated by `tsc -p tsconfig.json --noEmit`,
 *     which is the FIRST gate of scripts/verify-all.mjs. ESLint core cannot parse
 *     TypeScript, and pulling @typescript-eslint into a plugin package that is
 *     loaded inside the DSH process is not worth the dependency, so the TS layer
 *     deliberately relies on the compiler.
 *   - ESLint therefore covers the first-party JavaScript: `client/src/**`,
 *     `scripts/**`, `test/**`. That is where the *house rules* live that the
 *     compiler cannot see (bundle module headers, no ESM syntax in the client
 *     bundle sources, DSH theme tokens instead of hardcoded colors, no focused
 *     tests left behind).
 *   - `client/src/vendor/**` is upstream code (bundled @xterm/xterm) and is
 *     exempt from the first-party rules; ICD §8.6 only requires the plugin's own
 *     code to use `--dsw-*` tokens.
 *
 * Errors here are hard failures in scripts/verify-all.mjs.
 */

/** Node.js globals used by the host half, build scripts and tests. */
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  globalThis: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'readonly',
  exports: 'readonly',
  fetch: 'readonly',
}

/** Browser globals the client half touches (bundle runs inside the DSH page). */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  navigator: 'readonly',
  HTMLElement: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  getComputedStyle: 'readonly',
  matchMedia: 'readonly',
  CustomEvent: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  performance: 'readonly',
  ClipboardEvent: 'readonly',
  Event: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  Node: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  ResizeObserver: 'readonly',
  MutationObserver: 'readonly',
}

/**
 * The assembler wraps every `client/src/**` file in
 * `SSH.define('<name>', function (SSH) { … })`, so `SSH` is the file-level
 * registry binding (`SSH.define` at the top level, `SSH.require` inside the
 * factory). It is not an import (ICD §0.4) and must not be declared as one.
 */
const sshBundleGlobals = { SSH: 'readonly' }

/** Rules that encode the project's hard rules (ICD §0.4, §8.6). */
const houseRules = {
  // --- client bundle sources: `SSH.define` only, no ESM syntax -------------
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ImportDeclaration',
      message: 'client bundle sources must not use `import` (the assembler does no ESM parsing); use SSH.require(...)',
    },
    {
      selector: 'ExportNamedDeclaration',
      message: 'client bundle sources must not use `export`; return the module object from SSH.define(...)',
    },
    {
      selector: 'ExportDefaultDeclaration',
      message: 'client bundle sources must not use `export default`; return the module object from SSH.define(...)',
    },
    {
      selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
      message: 'hardcoded hex color: use a --dsw-* theme token instead (ICD §8.6)',
    },
    {
      selector: 'Literal[value=/rgba?\\(/]',
      message: 'hardcoded rgb()/rgba() color: use a --dsw-* theme token instead (ICD §8.6)',
    },
    {
      selector: 'CallExpression[callee.property.name="only"]',
      message: 'focused test left behind (describe.only / it.only / test.only)',
    },
  ],
}

/**
 * The client half uses React hooks, and the sources carry
 * `// eslint-disable-next-line react-hooks/exhaustive-deps` where the dependency
 * list is deliberately narrowed. Without the plugin those disable comments are
 * themselves errors ("definition for rule not found"), so the rule id is
 * registered as an explicit no-op. Hook-dependency *correctness* is covered by
 * the component tests instead; see docs/TESTING.md → "known lint gaps".
 */
const reactHooksStub = {
  rules: {
    'exhaustive-deps': {
      meta: { type: 'problem', docs: { description: 'registered as a no-op (see eslint.config.js)' }, schema: [] },
      create: () => ({}),
    },
  },
}

export default [
  {
    ignores: [
      'lib/**',
      'node_modules/**',
      'coverage/**',
      'docs/img/**',
      'client/src/vendor/**',
      '**/*.min.js',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    plugins: { 'react-hooks': reactHooksStub },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...nodeGlobals, ...browserGlobals },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // Unused *variables and imports* are real cruft; unused callback arguments
      // are not worth failing a build over (`args: 'none'`).
      'no-unused-vars': [
        'error',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-unsafe-negation': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-control-regex': 'off',
      eqeqeq: ['error', 'smart'],
      // Style-only rule: reported, not fatal (errors are reserved for correctness).
      'prefer-const': ['warn', { destructuring: 'all' }],
      'no-var': 'error',
      'object-shorthand': ['warn', 'properties'],
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'no-template-curly-in-string': 'warn',
      'no-unsafe-optional-chaining': 'error',
      'no-async-promise-executor': 'error',
      // `new Promise((resolve) => setTimeout(resolve, ms))` is idiomatic and the
      // executor's return value is ignored by the language.
      'no-promise-executor-return': 'off',
      // Returning a promise without `await` inside an async function is a style
      // choice; `await` is often kept deliberately for stack traces.
      'no-return-await': 'off',
      // Throwing wire-shaped plain objects is the contract in this codebase
      // (`ErrorInfo` = { code, message, retryable, details }).
      'no-throw-literal': 'off',
    },
  },
  {
    // First-party client sources: the strictest set (bundle contract + theme).
    files: ['client/src/**/*.js'],
    languageOptions: {
      globals: { ...nodeGlobals, ...browserGlobals, ...sshBundleGlobals },
    },
    rules: {
      ...houseRules,
      // The wire error shape IS a plain object (`ErrorInfo` = { code, message,
      // retryable, details }), so rejecting with a literal is the contract, not
      // a mistake.
      'no-throw-literal': 'off',
      // Deliberate promise memoisation (`resolvePromise = null` in a finally
      // after awaiting it) is flagged as a race by this rule; the pattern is
      // reviewed and intentional.
      'require-atomic-updates': 'off',
    },
  },
  {
    // Tests: house rules without the client-bundle constraints.
    files: ['test/**/*.mjs'],
    rules: {
      ...houseRules,
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.property.name="only"]',
          message: 'focused test left behind (test.only / t.only)',
        },
        {
          selector: 'CallExpression[callee.property.name="skip"][arguments.length=0]',
          message: 't.skip() without a reason string: a skipped test must say why',
        },
      ],
    },
  },
  {
    // Build scripts run in Node with CommonJS-friendly globals available.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: nodeGlobals },
  },
]
