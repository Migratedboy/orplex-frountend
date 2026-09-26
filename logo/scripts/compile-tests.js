// Compiles the shared module + its node:test suite to dist-tests/ for `npm test`.
const { execFileSync } = require('child_process');
const path = require('path');

execFileSync(
  process.execPath,
  [
    path.join('node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/focuslock.ts',
    'src/shared/focuslock.test.ts',
    '--outDir',
    'dist-tests',
    '--rootDir',
    'src',
    '--module',
    'commonjs',
    '--target',
    'ES2022',
    '--moduleResolution',
    'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--types',
    'node',
    '--strict',
  ],
  { stdio: 'inherit' }
);
console.log('[compile-tests] done');
