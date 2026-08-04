import Store from 'electron-store'

export interface AppSettings {
  autoLaunch: boolean
}

const DEFAULTS: AppSettings = {
  autoLaunch: false
}

export class Settings {
  private store: Store<AppSettings>

  constructor() {
    this.store = new Store<AppSettings>({ defaults: DEFAULTS })
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.store.get(key)
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.store.set(key, value)
  }

  getAll(): AppSettings {
    return this.store.store
  }
}
