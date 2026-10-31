import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

function devBackend(): Plugin {
  let child: ChildProcess | undefined
  const stop = () => {
    if (child && !child.killed) {
      child.kill()
      child = undefined
    }
  }
  return {
    name: 'dev-backend',
    apply: 'serve',
    configureServer(server) {
      const backendDir = join(import.meta.dirname, 'backend')
      const python =
        process.platform === 'win32'
          ? join(backendDir, '.venv', 'Scripts', 'python.exe')
          : join(backendDir, '.venv', 'bin', 'python')
      if (!existsSync(python)) {
        server.config.logger.warn(
          `[dev-backend] no venv at ${python} — run init.ps1/init.sh to set up the backend; frontend will run without it`,
        )
        return
      }
      child = spawn(python, ['-m', 'uvicorn', 'app.main:app'], {
        cwd: backendDir,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env },
      })
      child.on('exit', (code) => {
        if (code != null && code !== 0)
          server.config.logger.error(`[dev-backend] uvicorn exited with code ${code}`)
        child = undefined
      })
      server.httpServer?.once('close', stop)
      for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) process.once(sig, stop)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), devBackend()],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
})
