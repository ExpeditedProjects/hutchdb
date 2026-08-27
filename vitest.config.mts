import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
        },
      },
      {
        // Integration tests hit real infrastructure (Postgres via
        // HUTCH_TEST_DATABASE_URL), so they run in the plain node
        // environment. fileParallelism is off because every integration
        // file shares one scratch database and truncates between tests —
        // parallel files would clobber each other's rows.
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
})
