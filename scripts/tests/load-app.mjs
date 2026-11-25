// Load the TypeScript app with its existing Vite dependency, without a WebView.
import { createServer } from 'vite'

export async function loadModules() {
  globalThis.document ??= { getElementById: () => null }
  const vite = await createServer({
    configFile: false,
    envDir: false,
    logLevel: 'error',
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
  })
  try {
    const { App } = await vite.ssrLoadModule('/src/main.ts')
    const { VoiceDictation } = await vite.ssrLoadModule('/src/input/voice.ts')
    const { GlassesDisplay } = await vite.ssrLoadModule('/src/glasses.ts')
    const config = await vite.ssrLoadModule('/src/config.ts')
    const sdk = await import('@evenrealities/even_hub_sdk')
    return { App, VoiceDictation, GlassesDisplay, config, sdk }
  } finally {
    await vite.close()
  }
}
