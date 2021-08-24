import { Buffer, Neovim, Window } from '@chemzqm/neovim'
import debounce from 'debounce'
import { Disposable } from 'vscode-languageserver-protocol'
import events from '../events'
import { Documentation, parseDocuments } from '../markdown'
import { disposeAll } from '../util'
import { Mutex } from '../util/mutex'
import { equals } from '../util/object'
const isVim = process.env.VIM_NODE_RPC == '1'
const logger = require('../util/logger')('model-float')

export interface WindowConfig {
  width: number
  height: number
  col: number
  row: number
  relative: 'cursor' | 'win' | 'editor'
  style?: string
  cursorline?: number
  title?: string
  border?: number[]
  autohide?: number
  close?: number
}

export interface FloatWinConfig {
  maxHeight?: number
  maxWidth?: number
  preferTop?: boolean
  autoHide?: boolean
  offsetX?: number
  title?: string
  border?: number[]
  cursorline?: boolean
  close?: boolean
  highlight?: string
  borderhighlight?: string
  modes?: string[]
  excludeImages?: boolean
}

/**
 * Float window/popup factory for create float/popup around current cursor.
 */
export default class FloatFactory implements Disposable {
  private winid = 0
  private _bufnr = 0
  private closeTs: number
  private targetBufnr: number
  private mutex: Mutex = new Mutex()
  private disposables: Disposable[] = []
  private cursor: [number, number]
  private onCursorMoved: ((bufnr: number, cursor: [number, number]) => void) & { clear(): void }
  constructor(private nvim: Neovim) {
    this.onCursorMoved = debounce(this._onCursorMoved.bind(this), 300)
  }

  private bindEvents(autoHide: boolean, alignTop: boolean): void {
    let eventNames = ['InsertLeave', 'InsertEnter', 'BufEnter']
    for (let ev of eventNames) {
      events.on(ev as any, bufnr => {
        if (bufnr == this._bufnr) return
        this.close()
      }, null, this.disposables)
    }
    events.on('MenuPopupChanged', () => {
      // avoid intersect with pum
      if (events.pumAlignTop == alignTop) {
        this.close()
      }
    }, null, this.disposables)
    this.disposables.push(Disposable.create(() => {
      this.onCursorMoved.clear()
    }))
    events.on('CursorMoved', this.onCursorMoved.bind(this, autoHide), this, this.disposables)
    events.on('CursorMovedI', this.onCursorMoved.bind(this, autoHide), this, this.disposables)
  }

  public unbind(): void {
    if (this.disposables.length) {
      disposeAll(this.disposables)
      this.disposables = []
    }
  }

  public _onCursorMoved(autoHide: boolean, bufnr: number, cursor: [number, number]): void {
    if (bufnr == this._bufnr) return
    if (bufnr == this.targetBufnr && equals(cursor, this.cursor)) {
      // cursor not moved
      return
    }
    if (autoHide || bufnr != this.targetBufnr || !events.insertMode) {
      this.close()
      return
    }
  }

  /**
   * Create float window/popup at cursor position.
   *
   * @deprecated use show method instead
   */
  public async create(docs: Documentation[], allowSelection = false, offsetX = 0): Promise<void> {
    await this.show(docs, {
      modes: allowSelection ? ['n', 's'] : ['n'],
      offsetX
    })
  }

  /**
   * Show documentations in float window/popup around cursor.
   * Window and buffer are reused when possible.
   * Window is closed automatically on change buffer, InsertEnter, CursorMoved and CursorMovedI.
   *
   * @param docs List of documentations.
   * @param config Configuration for floating window/popup.
   */
  public async show(docs: Documentation[], config: FloatWinConfig = {}): Promise<void> {
    if (docs.length == 0 || docs.every(doc => doc.content.length == 0)) {
      this.close()
      return
    }
    let curr = Date.now()
    let release = await this.mutex.acquire()
    try {
      await this.createPopup(docs, config, curr)
      release()
    } catch (e) {
      this.nvim.echoError(e)
      release()
    }
  }

  private async createPopup(docs: Documentation[], opts: FloatWinConfig, timestamp: number): Promise<void> {
    docs = docs.filter(o => o.content.trim().length > 0)
    let { lines, codes, highlights } = parseDocuments(docs)
    let config: any = {
      pumAlignTop: events.pumAlignTop,
      preferTop: typeof opts.preferTop === 'boolean' ? opts.preferTop : false,
      offsetX: opts.offsetX || 0,
      title: opts.title || '',
      close: opts.close ? 1 : 0,
      codes,
      highlights,
      modes: opts.modes || ['n', 'i', 'ic', 's']
    }
    if (opts.maxHeight) config.maxHeight = opts.maxHeight
    if (opts.maxWidth) config.maxWidth = opts.maxWidth
    if (opts.border && !opts.border.every(o => o == 0)) {
      config.border = opts.border
    }
    if (opts.title && !config.border) config.border = [1, 1, 1, 1]
    if (opts.highlight) config.highlight = opts.highlight
    if (opts.borderhighlight) config.borderhighlight = [opts.borderhighlight]
    if (opts.cursorline) config.cursorline = 1
    let autoHide = opts.autoHide == false ? false : true
    if (autoHide) config.autohide = 1
    this.unbind()
    let arr = await this.nvim.call('coc#float#create_cursor_float', [this.winid, this._bufnr, lines, config])
    if (isVim) this.nvim.command('redraw', true)
    if (!arr || arr.length == 0) {
      this.winid = undefined
      return
    }
    let [targetBufnr, cursor, winid, bufnr, alignTop] = arr as [number, [number, number], number, number, number]
    if (this.closeTs > timestamp) {
      this.winid = undefined
      this.nvim.call('coc#float#close', [winid], true)
      return
    }
    this.winid = winid
    this._bufnr = bufnr
    this.targetBufnr = targetBufnr
    this.cursor = cursor
    this.bindEvents(autoHide, alignTop == 1)
  }

  /**
   * Close float window
   */
  public close(): void {
    let { winid, nvim } = this
    this.closeTs = Date.now()
    this.unbind()
    if (winid) {
      this.winid = undefined
      nvim.pauseNotification()
      nvim.call('coc#float#close', [winid], true)
      if (isVim) this.nvim.command('redraw', true)
      void nvim.resumeNotification(false, true)
    }
  }

  public checkRetrigger(bufnr: number): boolean {
    if (this.winid && this.targetBufnr == bufnr) return true
    return false
  }

  public get bufnr(): number {
    return this._bufnr
  }

  public get buffer(): Buffer | null {
    return this.bufnr ? this.nvim.createBuffer(this.bufnr) : null
  }

  public get window(): Window | null {
    return this.winid ? this.nvim.createWindow(this.winid) : null
  }

  public async activated(): Promise<boolean> {
    if (!this.winid) return false
    return await this.nvim.call('coc#float#valid', [this.winid]) != 0
  }

  public dispose(): void {
    this.cursor = undefined
    this.close()
  }
}
