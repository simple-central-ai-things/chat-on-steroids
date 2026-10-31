import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The SCGC gateway suite (node:test) runs under its own tsconfig and the
    // scgc-gateway-tests workflow, not under vitest. The rest are vitest's
    // default excludes, which a custom exclude list would otherwise drop.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'test/scgc-gateway/**'
    ],
    environment: 'node',
    // Real filesystem, real child processes and a real HTTP server, so the
    // defaults are too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // CI sets COS_TEST_RETRY: timing-sensitive tests can fail at random on shared runners (the Intel
    // macOS release runner is up to 6x slower than a laptop). A retry keeps a flake from turning a
    // run red; the flaky reporter names every test that needed one, so flakes stay visible.
    retry: Number(process.env.COS_TEST_RETRY) || 0,
    reporters: process.env.GITHUB_ACTIONS ? ['default', './scripts/flaky-reporter.mjs'] : ['default'],
    env: {
      // Never let a test bind — or worse, fall through to — the shipped bridge range.
      // The developer's own installed app is usually listening on 8765 while the suite
      // runs, and a test that lost the bind race used to talk to it with a test token.
      CLF_BRIDGE_PORTS: '0',
      // In-process evidence arrives in microseconds or never; the production windows only
      // exist for a real browser that is seconds late. Without this the suite spent minutes
      // waiting out fifteen-second timeouts to prove calls stay unattributed.
      CLF_EVIDENCE_MS: '1500'
    }
  }
});
