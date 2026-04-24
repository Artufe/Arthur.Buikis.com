import { spawn } from 'node:child_process';

process.env.NODE_ENV = 'development';

const child = spawn('next', ['dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NODE_ENV: 'development' },
});

child.on('exit', (code) => process.exit(code ?? 0));
