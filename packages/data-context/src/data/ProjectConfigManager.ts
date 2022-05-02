import { CypressError, getError } from '@packages/errors'
import { IpcHandler, LoadConfigReply, ProjectConfigIpc, SetupNodeEventsReply } from './ProjectConfigIpc'
import assert from 'assert'
import type { AllModeOptions, FullConfig, TestingType } from '@packages/types'
import debugLib from 'debug'
import path from 'path'
import _ from 'lodash'
import chokidar from 'chokidar'
import { validate as validateConfig, validateNoBreakingConfigLaunchpad, validateNoBreakingConfigRoot, validateNoBreakingTestingTypeConfig } from '@packages/config'
import { CypressEnv } from './CypressEnv'
import { autoBindDebug } from '../util/autoBindDebug'
import type { EventRegistrar } from './EventRegistrar'
import type { DataContext } from '../DataContext'

const debug = debugLib(`cypress:lifecycle:ProjectConfigManager`)

const UNDEFINED_SERIALIZED = '__cypress_undefined__'

type ProjectConfigManagerOptions = {
  ctx: DataContext
  configFile: string | false
  projectRoot: string
  handlers: IpcHandler[]
  hasCypressEnvFile: boolean
  eventRegistrar: EventRegistrar
  onError: (cypressError: CypressError, title?: string | undefined) => void
  onInitialConfigLoaded: (initialConfig: Cypress.ConfigOptions) => void
  onFinalConfigLoaded: (finalConfig: FullConfig) => Promise<void>
  refreshLifecycle: () => Promise<void>
}

type ConfigManagerState = 'pending' | 'loadingConfig' | 'loadedConfig' | 'loadingNodeEvents' | 'ready' | 'errored'

export class ProjectConfigManager {
  private _configFilePath: string | undefined
  private _cachedFullConfig: FullConfig | undefined
  private _eventsIpc?: ProjectConfigIpc
  private _pathToWatcherRecord: Record<string, chokidar.FSWatcher> = {}
  private _watchers = new Set<chokidar.FSWatcher>()
  private _registeredEventsTarget: TestingType | undefined
  private _testingType: TestingType | null = null
  private _state: ConfigManagerState = 'pending'
  private _loadConfigPromise: Promise<LoadConfigReply> | undefined
  private _cachedLoadConfig: LoadConfigReply | undefined
  private _cypressEnv: CypressEnv

  constructor (private options: ProjectConfigManagerOptions) {
    this._cypressEnv = new CypressEnv({
      envFilePath: this.envFilePath,
      validateConfigFile: (filePath, config) => {
        this.validateConfigFile(filePath, config)
      },
    })

    return autoBindDebug(this)
  }

  get isLoadingNodeEvents () {
    return this._state === 'loadingNodeEvents'
  }

  get isReady () {
    return this._state === 'ready'
  }

  get isLoadingConfigFile () {
    return this._state === 'loadingConfig'
  }

  get isInError () {
    return this._state === 'errored'
  }

  get configFilePath () {
    assert(this._configFilePath, 'configFilePath is undefined')

    return this._configFilePath
  }

  set configFilePath (configFilePath) {
    this._configFilePath = configFilePath
  }

  setTestingType (testingType: TestingType | null) {
    this._testingType = testingType
  }

  private get envFilePath () {
    return path.join(this.options.projectRoot, 'cypress.env.json')
  }

  private get loadedConfigFile (): Partial<Cypress.ConfigOptions> | null {
    return this._cachedLoadConfig?.initialConfig ?? null
  }

  async initializeConfig (): Promise<LoadConfigReply['initialConfig']> {
    try {
      this._state = 'loadingConfig'

      // Clean things up for a new load
      this.closeWatchers()
      this._cachedLoadConfig = undefined
      this._cachedFullConfig = undefined

      const loadConfigReply = await this.loadConfig()

      // This is necessary as there is a weird timing issue where an error occurs and the config results get loaded
      // TODO: see if this can be !== 'errored'
      if (this._state === 'loadingConfig') {
        debug(`config is loaded for file`, this.configFilePath, this._testingType)
        this.validateConfigFile(this.configFilePath, loadConfigReply.initialConfig)

        this._state = 'loadedConfig'
        this._cachedLoadConfig = loadConfigReply

        this.options.onInitialConfigLoaded(loadConfigReply.initialConfig)

        this.watchFiles([
          ...loadConfigReply.requires,
          this.configFilePath,
        ])
      }

      return loadConfigReply.initialConfig
    } catch (error) {
      debug(`catch %o`, error)
      if (this._eventsIpc) {
        this._eventsIpc.cleanupIpc()
      }

      this._state = 'errored'
      this.closeWatchers()

      throw error
    } finally {
      this.options.ctx.emitter.toLaunchpad()
    }
  }

  loadTestingType () {
    // If we have set a testingType, and it's not the "target" of the
    // registeredEvents (switching testing mode), we need to get a fresh
    // config IPC & re-execute the setupTestingType
    if (this._registeredEventsTarget && this._testingType !== this._registeredEventsTarget) {
      this.options.refreshLifecycle().catch(this.onLoadError)
    } else if (this._eventsIpc && !this._registeredEventsTarget && this._cachedLoadConfig) {
      this.setupNodeEvents(this._cachedLoadConfig).catch(this.onLoadError)
    }
  }

  private async setupNodeEvents (loadConfigReply: LoadConfigReply): Promise<void> {
    assert(this._eventsIpc, 'Expected _eventsIpc to be defined at this point')
    this._state = 'loadingNodeEvents'

    try {
      assert(this._testingType, 'Cannot setup node events without a testing type')
      this._registeredEventsTarget = this._testingType
      const config = await this.getFullInitialConfig()
      const setupNodeEventsReply = await this._eventsIpc?.callSetupNodeEventsWithConfig(this._testingType, config, this.options.handlers)

      await this.handleSetupTestingTypeReply(this._eventsIpc, loadConfigReply, setupNodeEventsReply)
      this._state = 'ready'
    } catch (error) {
      debug(`catch setupNodeEvents %o`, error)
      this._state = 'errored'
      if (this._eventsIpc) {
        this._eventsIpc.cleanupIpc()
      }

      this.closeWatchers()

      throw error
    } finally {
      this.options.ctx.emitter.toLaunchpad()
    }
  }

  private async handleSetupTestingTypeReply (ipc: ProjectConfigIpc, loadConfigReply: LoadConfigReply, result: SetupNodeEventsReply) {
    this.options.eventRegistrar.reset()

    for (const { event, eventId } of result.registrations) {
      debug('register plugins process event', event, 'with id', eventId)

      this.options.eventRegistrar.registerEvent(event, function (...args: any[]) {
        return new Promise((resolve, reject) => {
          const invocationId = _.uniqueId('inv')

          debug('call event', event, 'for invocation id', invocationId)

          ipc.once(`promise:fulfilled:${invocationId}`, (err: any, value: any) => {
            if (err) {
              debug('promise rejected for id %s %o', invocationId, ':', err.stack)
              reject(_.extend(new Error(err.message), err))

              return
            }

            if (value === UNDEFINED_SERIALIZED) {
              value = undefined
            }

            debug(`promise resolved for id '${invocationId}' with value`, value)

            return resolve(value)
          })

          const ids = { invocationId, eventId }

          // no argument is passed for cy.task()
          // This is necessary because undefined becomes null when it is sent through ipc.
          if (event === 'task' && args[1] === undefined) {
            args[1] = {
              __cypress_task_no_argument__: true,
            }
          }

          ipc.send('execute:plugins', event, ids, args)
        })
      })
    }

    const cypressEnv = await this.loadCypressEnvFile()
    const fullConfig = await this.buildBaseFullConfig(loadConfigReply.initialConfig, cypressEnv, this.options.ctx.modeOptions)

    const finalConfig = this._cachedFullConfig = this.options.ctx._apis.configApi.updateWithPluginValues(fullConfig, result.setupConfig ?? {}, this._testingType ?? 'e2e')

    await this.options.onFinalConfigLoaded(finalConfig)

    this.watchFiles([
      ...result.requires,
      this.envFilePath,
    ])

    return result
  }

  resetLoadingState () {
    this._loadConfigPromise = undefined
    this._registeredEventsTarget = undefined
    this._state = 'pending'
  }

  private loadConfig () {
    if (!this._loadConfigPromise) {
      // If there's already a dangling IPC from the previous switch of testing type, we want to clean this up
      if (this._eventsIpc) {
        this._eventsIpc.cleanupIpc()
      }

      this._eventsIpc = new ProjectConfigIpc(this.options.ctx.nodePath, this.options.projectRoot, this.configFilePath, this.options.configFile, (cypressError: CypressError, title?: string | undefined) => {
        this._state = 'errored'
        this.options.ctx.onError(cypressError, title)
      }, this.options.ctx.onWarning)

      this._loadConfigPromise = this._eventsIpc.loadConfig()
    }

    return this._loadConfigPromise
  }

  private validateConfigFile (file: string | false, config: Cypress.ConfigOptions) {
    validateConfig(config, (errMsg) => {
      if (_.isString(errMsg)) {
        throw getError('CONFIG_VALIDATION_MSG_ERROR', 'configFile', file || null, errMsg)
      }

      throw getError('CONFIG_VALIDATION_ERROR', 'configFile', file || null, errMsg)
    })

    return validateNoBreakingConfigLaunchpad(
      config,
      (type, obj) => {
        const error = getError(type, obj)

        this.options.ctx.onWarning(error)

        return error
      },
      (type, obj) => {
        const error = getError(type, obj)

        this.options.onError(error)

        throw error
      },
    )
  }

  onLoadError = (error: any) => {
    this.closeWatchers()
    this.options.onError(error, 'Error Loading Config')
  }

  private watchFiles (paths: string[]) {
    if (this.options.ctx.isRunMode) {
      return
    }

    const filtered = paths.filter((p) => !p.includes('/node_modules/'))

    for (const path of filtered) {
      if (!this._pathToWatcherRecord[path]) {
        this._pathToWatcherRecord[path] = this.addWatcherFor(path)
      }
    }
  }

  private addWatcherFor (file: string) {
    const w = this.addWatcher(file)

    w.on('all', (evt) => {
      debug(`changed ${file}: ${evt}`)
      this.options.refreshLifecycle().catch(this.onLoadError)
    })

    w.on('error', (err) => {
      debug('error watching config files %O', err)
      this.options.ctx.onWarning(getError('UNEXPECTED_INTERNAL_ERROR', err))
    })

    return w
  }

  private addWatcher (file: string | string[]) {
    const w = chokidar.watch(file, {
      ignoreInitial: true,
      cwd: this.options.projectRoot,
    })

    this._watchers.add(w)

    return w
  }

  private validateConfigRoot (config: Cypress.ConfigOptions, testingType: TestingType) {
    return validateNoBreakingConfigRoot(
      config,
      (type, obj) => {
        return getError(type, obj)
      },
      (type, obj) => {
        throw getError(type, obj)
      },
      testingType,
    )
  }

  private validateTestingTypeConfig (config: Cypress.ConfigOptions, testingType: TestingType) {
    return validateNoBreakingTestingTypeConfig(
      config,
      testingType,
      (type, ...args) => {
        return getError(type, ...args)
      },
      (type, ...args) => {
        throw getError(type, ...args)
      },
    )
  }

  private async buildBaseFullConfig (configFileContents: Cypress.ConfigOptions, envFile: Cypress.ConfigOptions, options: Partial<AllModeOptions>, withBrowsers = true) {
    assert(this._testingType, 'Cannot build base full config without a testing type')
    this.validateConfigRoot(configFileContents, this._testingType)

    const testingTypeOverrides = configFileContents[this._testingType] ?? {}
    const optionsOverrides = options.config?.[this._testingType] ?? {}

    this.validateTestingTypeConfig(testingTypeOverrides, this._testingType)
    this.validateTestingTypeConfig(optionsOverrides, this._testingType)

    // TODO: pass in options.config overrides separately, so they are reflected in the UI
    configFileContents = { ...configFileContents, ...testingTypeOverrides, ...optionsOverrides }

    // TODO: Convert this to be synchronous, it's just FS checks
    let fullConfig = await this.options.ctx._apis.configApi.setupFullConfigWithDefaults({
      cliConfig: options.config ?? {},
      projectName: path.basename(this.options.projectRoot),
      projectRoot: this.options.projectRoot,
      config: _.cloneDeep(configFileContents),
      envFile: _.cloneDeep(envFile),
      options: {
        ...options,
        testingType: this._testingType,
        configFile: path.basename(this.configFilePath),
      },
    })

    if (withBrowsers) {
      const browsers = await this.options.ctx.browser.machineBrowsers()

      if (!fullConfig.browsers || fullConfig.browsers.length === 0) {
        // @ts-ignore - we don't know if the browser is headed or headless at this point.
        // this is handled in open_project#launch.
        fullConfig.browsers = browsers
        fullConfig.resolved.browsers = { 'value': fullConfig.browsers, 'from': 'runtime' }
      }

      fullConfig.browsers = fullConfig.browsers?.map((browser) => {
        if (browser.family === 'chromium' || fullConfig.chromeWebSecurity) {
          return browser
        }

        return {
          ...browser,
          warning: browser.warning || getError('CHROME_WEB_SECURITY_NOT_SUPPORTED', browser.name).message,
        }
      })

      // If we have withBrowsers set to false, it means we're coming from the legacy config.get API
      // in tests, which shouldn't be validating the config
      this.validateConfigFile(this.options.configFile, fullConfig)
    }

    return _.cloneDeep(fullConfig)
  }

  async getFullInitialConfig (options: Partial<AllModeOptions> = this.options.ctx.modeOptions, withBrowsers = true): Promise<FullConfig> {
    if (this._cachedFullConfig) {
      return this._cachedFullConfig
    }

    const [configFileContents, envFile] = await Promise.all([
      this.getConfigFileContents(),
      this.reloadCypressEnvFile(),
    ])

    this._cachedFullConfig = await this.buildBaseFullConfig(configFileContents, envFile, options, withBrowsers)

    return this._cachedFullConfig
  }

  async getConfigFileContents () {
    if (this._cachedLoadConfig?.initialConfig) {
      return this._cachedLoadConfig?.initialConfig
    }

    return this.initializeConfig()
  }

  async loadCypressEnvFile () {
    return this._cypressEnv.loadCypressEnvFile()
  }

  async reloadCypressEnvFile () {
    this._cypressEnv = new CypressEnv({
      envFilePath: this.envFilePath,
      validateConfigFile: (filePath, config) => {
        this.validateConfigFile(filePath, config)
      },
    })

    return this._cypressEnv.loadCypressEnvFile()
  }

  isTestingTypeConfigured (testingType: TestingType): boolean {
    const config = this.loadedConfigFile

    if (!config) {
      return false
    }

    if (!_.has(config, testingType)) {
      return false
    }

    if (testingType === 'component') {
      return Boolean(config.component?.devServer)
    }

    return true
  }

  private closeWatchers () {
    for (const watcher of this._watchers.values()) {
      // We don't care if there's an error while closing the watcher,
      // the watch listener on our end is already removed synchronously by chokidar
      watcher.close().catch((e) => {})
    }
    this._watchers = new Set()
    this._pathToWatcherRecord = {}
  }

  destroy () {
    if (this._eventsIpc) {
      this._eventsIpc.cleanupIpc()
    }

    this._state = 'pending'
    this._cachedLoadConfig = undefined
    this._cachedFullConfig = undefined
    this._registeredEventsTarget = undefined
    this.closeWatchers()
  }
}
