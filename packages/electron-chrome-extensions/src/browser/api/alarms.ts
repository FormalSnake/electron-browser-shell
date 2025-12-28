import { Extension } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

interface AlarmInfo {
  name: string
  scheduledTime: number
  periodInMinutes?: number
}

interface AlarmData {
  info: AlarmInfo
  timeout: NodeJS.Timeout
}

const createScopedIdentifier = (extensionId: string, name: string) => `${extensionId}-${name}`

export class AlarmsAPI {
  // Map of extensionId -> Map of alarmName -> AlarmData
  private alarms = new Map<string, Map<string, AlarmData>>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('alarms.create', this.create, { permission: 'alarms' })
    handle('alarms.get', this.get, { permission: 'alarms' })
    handle('alarms.getAll', this.getAll, { permission: 'alarms' })
    handle('alarms.clear', this.clear, { permission: 'alarms' })
    handle('alarms.clearAll', this.clearAll, { permission: 'alarms' })

    // Clean up alarms when extension unloads
    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event: Electron.Event, extension: Extension) => {
      this.clearAllForExtension(extension.id)
    })
  }

  private getExtensionAlarms(extensionId: string): Map<string, AlarmData> {
    if (!this.alarms.has(extensionId)) {
      this.alarms.set(extensionId, new Map())
    }
    return this.alarms.get(extensionId)!
  }

  private create = (
    { extension }: ExtensionEvent,
    arg1: string | chrome.alarms.AlarmCreateInfo,
    arg2?: chrome.alarms.AlarmCreateInfo,
  ) => {
    let name: string
    let alarmInfo: chrome.alarms.AlarmCreateInfo

    // Handle overloaded function signature
    if (typeof arg1 === 'string') {
      name = arg1
      alarmInfo = arg2 || {}
    } else {
      name = ''
      alarmInfo = arg1 || {}
    }

    const extensionAlarms = this.getExtensionAlarms(extension.id)

    // Clear existing alarm with same name
    if (extensionAlarms.has(name)) {
      const existing = extensionAlarms.get(name)!
      clearTimeout(existing.timeout)
      extensionAlarms.delete(name)
    }

    // Calculate delay in milliseconds
    let delayMs: number
    if (typeof alarmInfo.when === 'number') {
      delayMs = Math.max(0, alarmInfo.when - Date.now())
    } else if (typeof alarmInfo.delayInMinutes === 'number') {
      delayMs = alarmInfo.delayInMinutes * 60 * 1000
    } else if (typeof alarmInfo.periodInMinutes === 'number') {
      // If only periodInMinutes is set, fire immediately then repeat
      delayMs = 0
    } else {
      // Default: fire immediately
      delayMs = 0
    }

    // Chrome enforces minimum alarm period of 1 minute in production
    // but allows shorter times for testing. We'll be lenient here.
    const periodMs = alarmInfo.periodInMinutes ? alarmInfo.periodInMinutes * 60 * 1000 : undefined

    const scheduledTime = Date.now() + delayMs

    const info: AlarmInfo = {
      name,
      scheduledTime,
      periodInMinutes: alarmInfo.periodInMinutes,
    }

    const fireAlarm = () => {
      // Update scheduled time for next firing if periodic
      if (periodMs) {
        info.scheduledTime = Date.now() + periodMs
      }

      this.ctx.router.sendEvent(extension.id, 'alarms.onAlarm', {
        name: info.name,
        scheduledTime: info.scheduledTime,
        periodInMinutes: info.periodInMinutes,
      })

      // If periodic, schedule next firing
      if (periodMs) {
        const alarmData = extensionAlarms.get(name)
        if (alarmData) {
          alarmData.timeout = setTimeout(fireAlarm, periodMs)
          alarmData.info.scheduledTime = info.scheduledTime
        }
      } else {
        // One-time alarm, remove from registry
        extensionAlarms.delete(name)
      }
    }

    const timeout = setTimeout(fireAlarm, delayMs)

    extensionAlarms.set(name, { info, timeout })
  }

  private get = ({ extension }: ExtensionEvent, name?: string): AlarmInfo | undefined => {
    const alarmName = name || ''
    const extensionAlarms = this.getExtensionAlarms(extension.id)
    const alarmData = extensionAlarms.get(alarmName)
    return alarmData?.info
  }

  private getAll = ({ extension }: ExtensionEvent): AlarmInfo[] => {
    const extensionAlarms = this.getExtensionAlarms(extension.id)
    return Array.from(extensionAlarms.values()).map((data) => data.info)
  }

  private clear = ({ extension }: ExtensionEvent, name?: string): boolean => {
    const alarmName = name || ''
    const extensionAlarms = this.getExtensionAlarms(extension.id)
    const alarmData = extensionAlarms.get(alarmName)

    if (alarmData) {
      clearTimeout(alarmData.timeout)
      extensionAlarms.delete(alarmName)
      return true
    }

    return false
  }

  private clearAll = ({ extension }: ExtensionEvent): boolean => {
    return this.clearAllForExtension(extension.id)
  }

  private clearAllForExtension(extensionId: string): boolean {
    const extensionAlarms = this.alarms.get(extensionId)
    if (!extensionAlarms || extensionAlarms.size === 0) {
      return false
    }

    for (const alarmData of extensionAlarms.values()) {
      clearTimeout(alarmData.timeout)
    }
    extensionAlarms.clear()
    return true
  }
}
