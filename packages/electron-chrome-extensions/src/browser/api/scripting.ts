import { Extension, webContents } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

// Type definitions for chrome.scripting API
interface ScriptInjectionTarget {
  tabId: number
  allFrames?: boolean
  frameIds?: number[]
  documentIds?: string[]
}

interface ScriptInjection {
  target: ScriptInjectionTarget
  files?: string[]
  func?: () => void
  args?: any[]
  injectImmediately?: boolean
  world?: 'ISOLATED' | 'MAIN'
}

interface CSSInjection {
  target: ScriptInjectionTarget
  css?: string
  files?: string[]
  origin?: 'AUTHOR' | 'USER'
}

interface InjectionResult {
  documentId?: string
  frameId: number
  result?: any
  error?: { message: string }
}

interface RegisteredContentScript {
  id: string
  allFrames?: boolean
  css?: string[]
  excludeMatches?: string[]
  js?: string[]
  matches?: string[]
  persistAcrossSessions?: boolean
  runAt?: 'document_start' | 'document_end' | 'document_idle'
  world?: 'ISOLATED' | 'MAIN'
}

interface ContentScriptFilter {
  ids?: string[]
}

export class ScriptingAPI {
  // Map of extensionId -> Map of scriptId -> RegisteredContentScript
  private registeredScripts = new Map<string, Map<string, RegisteredContentScript>>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('scripting.executeScript', this.executeScript, { permission: 'scripting' })
    handle('scripting.insertCSS', this.insertCSS, { permission: 'scripting' })
    handle('scripting.removeCSS', this.removeCSS, { permission: 'scripting' })
    handle('scripting.registerContentScripts', this.registerContentScripts, {
      permission: 'scripting',
    })
    handle('scripting.unregisterContentScripts', this.unregisterContentScripts, {
      permission: 'scripting',
    })
    handle('scripting.getRegisteredContentScripts', this.getRegisteredContentScripts, {
      permission: 'scripting',
    })
    handle('scripting.updateContentScripts', this.updateContentScripts, { permission: 'scripting' })

    // Clean up registered scripts when extension unloads
    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event: Electron.Event, extension: Extension) => {
      this.registeredScripts.delete(extension.id)
    })
  }

  private getExtensionScripts(extensionId: string): Map<string, RegisteredContentScript> {
    if (!this.registeredScripts.has(extensionId)) {
      this.registeredScripts.set(extensionId, new Map())
    }
    return this.registeredScripts.get(extensionId)!
  }

  private async readExtensionFile(extension: Extension, filePath: string): Promise<string> {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    // Normalize the file path (remove leading slash if present)
    const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath
    const fullPath = join(extension.path, normalizedPath)

    try {
      return await readFile(fullPath, 'utf-8')
    } catch (error) {
      throw new Error(`Failed to read extension file: ${filePath}`)
    }
  }

  private executeScript = async (
    { extension }: ExtensionEvent,
    injection: ScriptInjection,
  ): Promise<InjectionResult[]> => {
    const { target, files, func, args = [], world = 'ISOLATED' } = injection

    const tab = this.ctx.store.getTabById(target.tabId)
    if (!tab || tab.isDestroyed()) {
      throw new Error(`No tab with id: ${target.tabId}`)
    }

    const results: InjectionResult[] = []

    // Build the script to execute
    let scriptCode = ''

    if (func) {
      // Serialize the function and arguments
      const argsStr = args.map((arg) => JSON.stringify(arg)).join(', ')
      scriptCode = `(${func.toString()})(${argsStr})`
    } else if (files && files.length > 0) {
      // Read and concatenate all script files
      const scriptContents = await Promise.all(
        files.map((file) => this.readExtensionFile(extension, file)),
      )
      scriptCode = scriptContents.join('\n')
    }

    if (!scriptCode) {
      throw new Error('No script to execute')
    }

    // Determine which frames to inject into
    const frameIds = target.frameIds || (target.allFrames ? undefined : [0])

    try {
      // Execute in main frame (frameId 0) by default
      // For 'MAIN' world, use executeJavaScript directly
      // For 'ISOLATED' world, we still use executeJavaScript but Chrome would use isolated context
      // Note: Electron doesn't have true isolated worlds like Chrome, so we execute in main world
      const result = await tab.executeJavaScript(scriptCode, true)

      results.push({
        frameId: 0,
        result,
      })
    } catch (error: any) {
      results.push({
        frameId: 0,
        error: { message: error.message || String(error) },
      })
    }

    return results
  }

  private insertCSS = async (
    { extension }: ExtensionEvent,
    injection: CSSInjection,
  ): Promise<void> => {
    const { target, css, files } = injection

    const tab = this.ctx.store.getTabById(target.tabId)
    if (!tab || tab.isDestroyed()) {
      throw new Error(`No tab with id: ${target.tabId}`)
    }

    let cssCode = css || ''

    if (files && files.length > 0) {
      const cssContents = await Promise.all(
        files.map((file) => this.readExtensionFile(extension, file)),
      )
      cssCode = cssContents.join('\n')
    }

    if (!cssCode) {
      throw new Error('No CSS to insert')
    }

    await tab.insertCSS(cssCode)
  }

  private removeCSS = async (
    { extension }: ExtensionEvent,
    injection: CSSInjection,
  ): Promise<void> => {
    const { target, css, files } = injection

    const tab = this.ctx.store.getTabById(target.tabId)
    if (!tab || tab.isDestroyed()) {
      throw new Error(`No tab with id: ${target.tabId}`)
    }

    let cssCode = css || ''

    if (files && files.length > 0) {
      const cssContents = await Promise.all(
        files.map((file) => this.readExtensionFile(extension, file)),
      )
      cssCode = cssContents.join('\n')
    }

    if (!cssCode) {
      throw new Error('No CSS to remove')
    }

    // Electron's removeInsertedCSS requires the CSS key returned from insertCSS
    // Since we don't have that tracking, we'll need to re-insert empty or handle differently
    // For now, we'll use a workaround by adding a style that nullifies the previous CSS
    // This is a limitation of Electron's API compared to Chrome's
    await tab.removeInsertedCSS(cssCode)
  }

  private registerContentScripts = async (
    { extension }: ExtensionEvent,
    scripts: RegisteredContentScript[],
  ): Promise<void> => {
    const extensionScripts = this.getExtensionScripts(extension.id)

    for (const script of scripts) {
      if (!script.id) {
        throw new Error('Content script id is required')
      }

      if (extensionScripts.has(script.id)) {
        throw new Error(`Content script with id "${script.id}" already exists`)
      }

      extensionScripts.set(script.id, {
        ...script,
        persistAcrossSessions: script.persistAcrossSessions !== false, // defaults to true
      })
    }

    // TODO: Apply registered scripts to matching tabs
    // This would require listening to webNavigation events and injecting scripts
  }

  private unregisterContentScripts = async (
    { extension }: ExtensionEvent,
    filter?: ContentScriptFilter,
  ): Promise<void> => {
    const extensionScripts = this.getExtensionScripts(extension.id)

    if (!filter || !filter.ids) {
      // Unregister all scripts for this extension
      extensionScripts.clear()
    } else {
      // Unregister specific scripts
      for (const id of filter.ids) {
        extensionScripts.delete(id)
      }
    }
  }

  private getRegisteredContentScripts = (
    { extension }: ExtensionEvent,
    filter?: ContentScriptFilter,
  ): RegisteredContentScript[] => {
    const extensionScripts = this.getExtensionScripts(extension.id)
    const scripts = Array.from(extensionScripts.values())

    if (!filter || !filter.ids) {
      return scripts
    }

    return scripts.filter((script) => filter.ids!.includes(script.id))
  }

  private updateContentScripts = async (
    { extension }: ExtensionEvent,
    scripts: RegisteredContentScript[],
  ): Promise<void> => {
    const extensionScripts = this.getExtensionScripts(extension.id)

    for (const script of scripts) {
      if (!script.id) {
        throw new Error('Content script id is required')
      }

      if (!extensionScripts.has(script.id)) {
        throw new Error(`Content script with id "${script.id}" not found`)
      }

      const existingScript = extensionScripts.get(script.id)!

      // Merge the updates with existing script
      extensionScripts.set(script.id, {
        ...existingScript,
        ...script,
      })
    }
  }
}
