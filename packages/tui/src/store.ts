import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { getTrackerPath } from './config.js'
import { TrackerStateSchema } from 'command-center-shared'
import type { TrackerState } from 'command-center-shared'

export class Store extends EventEmitter {
  private _state: TrackerState | null = null
  private _trackerPath: string
  private _modified = false
  private _loadError: string | null = null

  constructor() {
    super()
    this._trackerPath = getTrackerPath()
    this.loadFromDisk()
  }

  get state(): TrackerState | null {
    return this._state
  }

  get modified(): boolean {
    return this._modified
  }

  get loadError(): string | null {
    return this._loadError
  }

  loadFromDisk(): boolean {
    this._loadError = null
    try {
      if (!fs.existsSync(this._trackerPath)) {
        this._loadError = `Tracker file not found: ${this._trackerPath}`
        this._state = null
        return false
      }
      const raw = fs.readFileSync(this._trackerPath, 'utf-8')
      const parsed = JSON.parse(raw)
      this._state = TrackerStateSchema.parse(parsed) as TrackerState
      this._modified = false
      this.emit('change', this._state)
      return true
    } catch (e: any) {
      this._loadError = `Failed to load tracker: ${e.message || e}`
      this._state = null
      return false
    }
  }

  saveToDisk(): boolean {
    if (!this._state) return false
    try {
      const tmp = this._trackerPath + '.tmp.' + Date.now()
      fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2) + '\n', 'utf-8')
      fs.renameSync(tmp, this._trackerPath)
      this._modified = false
      this.emit('change', this._state)
      return true
    } catch {
      return false
    }
  }

  get trackerPath(): string {
    return this._trackerPath
  }
}
