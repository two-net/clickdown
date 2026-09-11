import { Component, ElementRef, afterRenderEffect, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Backend, LoadError } from './backend';
import { cap, color } from './format';
import { ItemList } from './item-list';
import { Frame, Navigator, describe } from './navigator';
import { TaskDetail } from './task-detail';

/** The selection's color at each depth: the deeper, the darker. */
const SELECTION = ['var(--d2)', 'var(--d2)', 'var(--d3)', 'var(--d3)', 'var(--d4)'];

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
  protected readonly letters = [...'ClickDown'];
  protected readonly splash = signal(this.backend.motion());
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private shown = 0; // the key of the frame whose view was last set up

  constructor() {
    void this.checkToken();
    this.nav.start();
    if (this.splash()) setTimeout(() => this.splash.set(false), 1060);
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
    afterRenderEffect(() => this.present());
  }

  protected onKey(event: KeyboardEvent) {
    if (this.splash()) { // the key only skips the splash
      this.skipSplash();
      event.preventDefault();
      return;
    }
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
      case 'Escape': case 'Backspace': case 'ArrowLeft': this.nav.pop(); break;
      // A held key repeats ~30 times a second; each refresh would cost ClickUp requests.
      case 'r': case 'R': if (!event.repeat) void this.refresh(frame); break;
      case '?': this.openHelp(); break;
      default: return;
    }
    event.preventDefault();
  }

  protected skipSplash() {
    this.host.classList.add('splash-skipped'); // a quicker fall
    this.splash.set(false);
  }

  protected openHelp() {
    this.help()?.nativeElement.showModal?.();
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
    await this.backend.loadSettings();
    const changed = this.backend.settings().only_lists.join() !== onlyLists;
    if (changed && checked) void this.checkToken();
    if (changed) this.nav.start();
    else if (frame === this.nav.top()[0]) void this.nav.load(frame); // unless the user moved on meanwhile
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
    this.nav.rail();
    const rail = this.railEl()?.nativeElement;
    if (rail) rail.scrollLeft = rail.scrollWidth; // the narrow rail scrolls sideways
    const frame = this.nav.top()[0];
    if (!frame || this.fatal()) return;
    const ready = frame.ready() || !!frame.error();
    const view = document.querySelector<HTMLElement>(`.view[data-key="${frame.key}"]`);
    const body = view?.querySelector<HTMLElement>('.view-body');
    if (!view || !body) return;
    document.title = `${frame.task()?.name ?? frame.title} – ClickDown`;
    const appeared = frame.key !== this.shown;
    if (appeared) {
      this.shown = frame.key;
      body.scrollTop = frame.scrollTop;
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

  /** In a task, the movement keys scroll it; everywhere else they move the selection. */
  private move(frame: Frame, by: number, scroll: boolean) {
    if (!scroll) return frame.move(by);
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
