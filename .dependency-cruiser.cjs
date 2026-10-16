// Layer rules: shared is pure, core never sees vscode, webviews never see
// Node or core, and nothing has cycles.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      severity: 'error',
      from: {
        orphan: true,
        pathNot: [
          String.raw`\.d\.ts$`,
          String.raw`\.test\.tsx?$`,
          '(^|/)test/',
          'webview/test/',
          'test-helpers/',
          // Entry points and tool configs have no importers by design.
          String.raw`^src/host/extension\.ts$`,
          String.raw`^src/hook/main\.ts$`,
          String.raw`^webview/src/main\.tsx$`,
          String.raw`\.config\.(ts|mts|mjs)$`,
        ],
      },
      to: {},
    },
    {
      name: 'shared-is-pure',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^(src/(core|host|hook)/|webview/)|^vscode$', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'shared-no-node',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'core-no-vscode',
      severity: 'error',
      from: { path: '^src/(core|hook)/' },
      to: { path: '^vscode$|^src/host/' },
    },
    {
      name: 'webview-no-node',
      severity: 'error',
      from: { path: '^webview/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'webview-only-shared',
      severity: 'error',
      from: { path: '^webview/' },
      to: { path: '^src/(core|host|hook)/' },
    },
    {
      name: 'not-to-test',
      severity: 'error',
      from: { pathNot: String.raw`\.test\.tsx?$|(^|/)test/|test-helpers/` },
      to: { path: '(^|/)test/|test-helpers/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|out|coverage|reports)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
    },
    externalModuleResolutionStrategy: 'node_modules',
  },
};
