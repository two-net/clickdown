import { Component, ElementRef, afterRenderEffect, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Backend, LoadError } from './backend';
import { cap, color } from './format';
import { ItemList } from './item-list';
import { Frame, Navigator, SORTS, describe } from './navigator';
import { TaskDetail } from './task-detail';

/** The selection's color at each depth: the deeper, the darker. */
const SELECTION = ['var(--d2)', 'var(--d2)', 'var(--d3)', 'var(--d3)', 'var(--d4)'];
/** The keys the search box passes on to the rows; every other key types, or moves in the text. */
const BOX_KEYS = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Enter', 'Escape'];

@Component({
  selector: 'app-root',
  imports: [ItemList, TaskDetail],
  templateUrl: './app.html',
  host: { '(document:keydown)': 'onKey($event)' },
})
export class App {
  protected readonly nav = inject(Navigator);
  protected readonly backend = inject(Backend);
  protected readonly cap = cap;
  protected readonly color = color;
  protected readonly describe = describe;
  protected readonly sorts = SORTS;
  protected readonly heard = signal(''); // a search's result, for screen readers
  private tokenChecked = false; // /api/user answered, so ClickUp accepts the token
  private readonly tokenError = signal<LoadError | null>(null);
  /** Only a token ClickUp rejects takes over the screen; other refusals stay in their view. */
  protected readonly fatal = computed(() => {
    const error = this.tokenError();
    return error?.kind === 'unauthorized' ? error : null;
  });
  protected readonly depth = computed(() => SELECTION[this.nav.rail()?.current ?? 0]);
  private readonly help = viewChild<ElementRef<HTMLDialogElement>>('help');
  private readonly railEl = viewChild<ElementRef<HTMLElement>>('rail');
  private shown = 0; // the key of the frame whose view was last set up

  constructor() {
    void this.checkToken();
    this.nav.start();
    // The toast says it once when a rate-limit wait starts, so screen readers hear it too.
    let waiting = false;
    effect(() => {
      const seconds = this.backend.retryIn();
      if (seconds && !waiting) this.nav.say(`ClickUp’s rate limit is reached. ClickDown retries in ${seconds} s.`);
      waiting = seconds > 0;
    });
    effect(() => {
      if (this.fatal()) document.title = 'ClickDown stopped';
    });
    // A search's result, for screen readers, once typing pauses: the toast would flash on every key.
    effect((onCleanup) => {
      const frame = this.nav.top()[0];
      const text = frame?.query().trim() ? frame.summary() : '';
      this.heard.set(''); // emptied first, so a count that didn't change is heard again
      const timer = setTimeout(() => this.heard.set(text), 600);
      onCleanup(() => clearTimeout(timer));
    });
    afterRenderEffect(() => {
      this.nav.rail(); // only when you move: the narrow rail scrolls sideways, to where you are
      const rail = this.railEl()?.nativeElement;
      if (rail) rail.scrollLeft = rail.scrollWidth;
    });
    afterRenderEffect(() => this.present());
  }

  protected onKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const help = this.help()?.nativeElement;
    if (help?.open) { // the dialog handles Esc itself
      if (event.key === '?') {
        help.close?.();
        event.preventDefault();
      }
      return;
    }
    if (this.fatal() && event.key.toLowerCase() !== 'r') return;
    const target = event.target instanceof Element ? event.target : null;
    // The search box keeps the keys that edit its text, and every key while an IME composes (keyCode 229:
    // Safari's Enter that ends a composition).
    const typing = target instanceof HTMLInputElement;
    if (typing && (event.isComposing || event.keyCode === 229 || !BOX_KEYS.includes(event.key))) return;
    if ((event.key === 'Enter' || event.key === ' ') && target?.closest('button, a')) return; // their own action
    const frame = this.nav.top()[0];
    if (!frame) return;
    // A task scrolls, unless its subtasks have focus (the selection is hidden otherwise).
    const scroll = frame.kind === 'task' && !target?.closest('.task-doc .rows');
    switch (event.key) {
      case 'ArrowDown': case 'j': case 'J': this.move(frame, 1, scroll); break;
      case 'ArrowUp': case 'k': case 'K': this.move(frame, -1, scroll); break;
      case 'PageDown': this.move(frame, 10, scroll); break;
      case 'PageUp': this.move(frame, -10, scroll); break;
      case 'Home': this.move(frame, -Infinity, scroll); break;
      case 'End': this.move(frame, Infinity, scroll); break;
      case 'Enter': case 'ArrowRight': if (!scroll) this.nav.activate(frame); break;
      // One step out at a time, so a held key doesn't run through them: the search's text, the search box, the level.
      case 'Escape':
        if (event.repeat) break;
        if (frame.query()) frame.search('');
        else if (typing) this.focusIn(frame, '.rows');
        else this.nav.pop();
        break;
      case 'Backspace': case 'ArrowLeft': this.nav.pop(); break;
      case '/': if (!this.focusIn(frame, '.find')) return; break; // none in a task: the browser keeps its own /
      // A held key repeats ~30 times a second: each sort would say so, and each refresh would cost ClickUp requests.
      case 's': case 'S': if (frame.kind !== 'list' || !frame.ready() || event.repeat) return; this.nav.sortNext(frame); break;
      case 'r': case 'R': if (!event.repeat) void this.refresh(frame); break;
      case '?': this.openHelp(); break;
      default: return;
    }
    event.preventDefault();
  }

  protected openHelp() {
    const help = this.help()?.nativeElement;
    help?.showModal?.();
    if (help) help.scrollTop = 0; // a closed dialog keeps its scroll, so it would reopen below its top
  }

  protected closeHelp() {
    this.help()?.nativeElement.close?.();
  }

  /** A click on the dialog itself, not its contents, is a click on the backdrop. */
  protected onHelpClick(event: MouseEvent) {
    if (event.target === this.help()?.nativeElement) this.closeHelp();
  }

  /**
   * R, and the Retry button. Also re-reads the settings: the server may have been down at boot, or
   * restarted with another only_lists or token.
   */
  protected async refresh(frame: Frame) {
    if (this.fatal()) { // after a restart with a new token
      if (await this.checkToken()) {
        await this.backend.loadSettings();
        this.nav.start();
      }
      return;
    }
    if (frame.busy() === 'Loading more') return;
    const checked = this.tokenChecked;
    if (!checked) void this.checkToken();
    const onlyLists = this.backend.settings().only_lists.join();
    const known = this.backend.settingsKnown();
    await this.backend.loadSettings();
    const changed = this.backend.settings().only_lists.join() !== onlyLists;
    if (changed && checked) void this.checkToken();
    if (changed || (!known && this.backend.settingsKnown())) this.nav.start(); // the address is read anew
    else if (frame === this.nav.top()[0]) { // unless the user moved on meanwhile
      // The levels above it that an address opened but that didn't load retry too, the one on screen first.
      for (const f of [...this.nav.stack()].reverse()) if (f === frame || (!f.ready() && f.error())) void this.nav.load(f);
    }
  }

  protected errorTitle(error: LoadError): string {
    switch (error.kind) {
      case 'network': return 'Can’t reach ClickUp';
      case 'unreachable': return 'ClickDown server isn’t running';
      case 'unauthorized': return 'ClickUp refused this';
      default: return 'ClickUp returned an error';
    }
  }

  protected errorText(error: LoadError): string {
    switch (error.kind) {
      case 'network': return 'The request failed before ClickUp answered. Check the connection, then retry.';
      case 'unreachable': return 'Nothing answers on 127.0.0.1:4280. Start it with cargo run in src/ClickDown, then retry.';
      case 'unauthorized': return `ClickUp said: ${error.message}. If the token was revoked, edit ${error.configPath} and restart cargo run.`;
      default: return error.message;
    }
  }

  /** After each render: set up a view that just appeared, and put focus on its rows once they exist. */
  private present() {
    const frame = this.nav.top()[0];
    if (!frame || this.fatal()) return;
    const ready = frame.ready() || !!frame.error();
    frame.items(); // rows come and go with a search, a page or a refresh, and focus goes with them
    const view = document.querySelector<HTMLElement>(`.view[data-key="${frame.key}"]`);
    const body = view?.querySelector<HTMLElement>('.view-body');
    if (!view || !body) return;
    document.title = `${frame.name()} – ClickDown`;
    const appeared = frame.key !== this.shown;
    if (appeared) {
      this.shown = frame.key;
      this.closeHelp(); // Back or Forward while the keys were shown: the new view gets the focus
      body.scrollTop = frame.scrollTop;
      // A level an address opened was never on screen, so its selected row can be out of view.
      if (frame.kind !== 'task') view.querySelector('.rows [aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
      // Kept for coming back. A plain listener: a template (scroll) binding would re-check every row on each frame.
      body.addEventListener('scroll', () => (frame.scrollTop = body.scrollTop), { passive: true });
    }
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || focused === body;
    if (appeared || (ready && lost)) {
      const rows = frame.kind === 'task' ? null : view.querySelector<HTMLElement>('.rows');
      (rows ?? body).focus({ preventScroll: true });
    }
  }

  /** "/" and Esc: focus on this view's search box (its text selected, so typing starts afresh) or its rows. False if there's none. */
  private focusIn(frame: Frame, selector: '.find' | '.rows'): boolean {
    const el = document.querySelector<HTMLElement>(`.view[data-key="${frame.key}"] ${selector}`);
    el?.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement) el.select();
    return !!el;
  }

  /** In a task, the movement keys scroll it; everywhere else they move the selection. */
  private move(frame: Frame, by: number, scroll: boolean) {
    if (!scroll) {
      // From a button (Sort, the rail), focus goes to the rows, where the selection is shown and announced.
      if (!document.activeElement?.closest('.find, .rows')) this.focusIn(frame, '.rows');
      return frame.move(by);
    }
    const body = document.querySelector<HTMLElement>(`.view[data-key="${frame.key}"] .view-body`);
    if (!body) return;
    const behavior = this.backend.motion() ? 'smooth' : 'auto';
    if (!Number.isFinite(by)) body.scrollTo?.({ top: by > 0 ? body.scrollHeight : 0, behavior });
    else body.scrollBy?.({ top: Math.abs(by) > 1 ? Math.sign(by) * body.clientHeight * 0.85 : by * 72, behavior });
  }

  /** ClickUp answers /api/user only for a token it accepts; a 401 there shows the stopped screen. */
  private async checkToken(): Promise<boolean> {
    try {
      await this.backend.get<unknown>('/api/user');
      this.tokenChecked = true;
      this.tokenError.set(null);
      return true;
    } catch (e) {
      this.tokenError.set(e as LoadError);
      return false;
    }
  }
}
