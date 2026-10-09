import { defineConfig } from '@playwright/test';

// E2E_PORT lets a second checkout run e2e beside one already serving :3000.
const port = Number(process.env.E2E_PORT ?? 3000);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  webServer: {
    command: `pnpm dev -p ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // Headless Chromium only offers software WebGL when explicitly allowed.
        launchOptions: { args: process.platform === 'darwin'
          ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
          : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
      },
    },
  ],
});
