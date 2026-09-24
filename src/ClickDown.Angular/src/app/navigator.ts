import { Location } from '@angular/common';
import { Injectable, Signal, WritableSignal, computed, inject, linkedSignal, signal } from '@angular/core';
import { NavigationEnd, PRIMARY_OUTLET, Router } from '@angular/router';
import { Backend, LoadError } from './backend';
import { cap, matches, plural } from './format';
import { Comment, CommentsPage, Folder, List, SharedHierarchy, Space, Status, Task, TaskDetail, TasksPage, Team } from './models';

export type Kind = 'lists' | 'workspaces' | 'spaces' | 'space' | 'folder' | 'list' | 'task';

/** One row; `open` is the kind of frame it opens, or 'more' for a list's next page of tasks. */
export interface Item {
  open: Kind | 'more'; id: string; name: string;
  color?: string | null; members?: number; statuses?: Status[]; // workspaces and spaces
  lists?: number | null; tasks?: number | null; // folders and lists
  task?: Task;
}

/** Rows under one heading: a status in a list, "Folders" in a space, or no heading at all. */
export interface Group { label: string | null; status?: Status; items: Item[] }

/** One step of the rail. `d` is its depth, from 0 (Workspace) to 4 (Task). */
export interface Level {
  d: number; name: string; value: string | null; label: string;
  reached: boolean; current: boolean; ahead: boolean; skipped: boolean; stemOn: boolean;
  target: number; clickable: boolean; step: number; color: string; nextColor: string;
}

const NO_DUE = Number.MAX_VALUE; // after every real due date; two of them tie, as MAX - MAX is 0
const PRIORITY = new Map([['urgent', 0], ['high', 1], ['normal', 2], ['low', 3]]); // no priority: 4, last
const rank = (t: Task) => PRIORITY.get(t.priority?.priority ?? '') ?? 4;
const byName = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' }); // "Task 9" before "Task 10"

/** How a list's tasks can be ordered within each status, one natural direction each; S picks the next. Ties keep ClickUp's order. */
export const SORTS: { name: string; says: string; compare?: (a: Task, b: Task) => number }[] = [
  { name: 'ClickUp’s order', says: 'in ClickUp’s order' },
  { name: 'Due date', says: 'by due date, soonest first', compare: (a, b) => (a.due_date || NO_DUE) - (b.due_date || NO_DUE) },
  { name: 'Priority', says: 'by priority, urgent first', compare: (a, b) => rank(a) - rank(b) },
  { name: 'Name', says: 'by name, A to Z', compare: (a, b) => byName.compare(a.name, b.name) },
];

/** What a search looks through: a task's name, the ID its row shows, its tags and assignees; any other row's name. */
const searched = ({ name, task: t }: Item): (string | null)[] =>
  t ? [name, t.custom_id || t.id, ...t.tags.map((tag) => tag.name), ...t.assignees.map((a) => a.username)] : [name];

let lastKey = 0;

/** One level of the descent. It keeps its own data, so going back is instant. */
export class Frame {
  readonly key = ++lastKey; // unique per frame, so re-opening the same item still animates
  /** Its row's name. An address gives only the id, so until the frame above loads it's e.g. "List 7". */
  readonly title: WritableSignal<string>;
  readonly all = signal<Group[]>([]); // every row loaded, before the search and the sort
  readonly query = signal(''); // the search box's text
  /** What's on screen: the rows that match the search, a list's tasks sorted within each status. "Load more" stays: the next page may match. */
  readonly groups = computed(() => {
    const query = this.query().trim();
    const compare = this.kind === 'list' ? SORTS[this.sort()].compare : undefined;
    if (!query && !compare) return this.all();
    return this.all()
      .map((g) => {
        const items = g.items.filter((i) => i.open === 'more' || matches(query, searched(i)));
        return { ...g, items: compare && g.status ? items.sort((a, b) => compare(a.task!, b.task!)) : items };
      })
      .filter((g) => g.items.length);
  });
  readonly items = computed(() => this.groups().flatMap((g) => g.items)); // what ↑/↓ move through
  readonly ready = signal(false); // data arrived at least once
  readonly busy = signal<'Refreshing' | 'Loading more' | null>(null);
  readonly error = signal<LoadError | null>(null); // once ready, a failed refresh: the rows stay
  /** The selected row. When the rows change (a refresh, a page, a search, a sort), it stays on its row, or in its place if that row went. */
  readonly highlight = linkedSignal<Item[], number>({
    source: this.items,
    computation: (items, prev) => {
      const was = prev?.source[prev.value];
      const at = was ? items.findIndex((i) => i.open === was.open && i.id === was.id) : -1;
      return at >= 0 ? at : Math.max(0, Math.min(prev?.value ?? 0, items.length - 1));
    },
  });
  /** The selected row's element id, for aria-activedescendant on the rows and the search box. */
  readonly active = computed(() => {
    const item = this.items()[this.highlight()];
    return item ? this.optionId(item) : null;
  });
  readonly task = signal<TaskDetail | null>(null);
  /** What the head, the rail and the tab call it. */
  readonly name = computed(() => this.task()?.name ?? this.title());
  readonly comments = signal<Comment[] | null>(null); // newest first, as ClickUp pages them; null while loading
  readonly commentsError = signal<LoadError | null>(null);
  readonly olderComments = signal(false);
  readonly olderBusy = signal(false); // loading the page of older comments
  readonly summary = computed(() => {
    const all = this.summarize();
    if (!this.query().trim() || !this.all().length) return all;
    const found = this.items().filter((i) => i.open !== 'more').length;
    return `${found ? plural(found, 'match', 'matches') : 'No matches'} among ${all}`;
  });
  tasks: Task[] = []; // a list's tasks, every page so far
  page = 0;
  lastPage = true;
  scrollTop = 0;
  opened?: Frame; // what an address opened below it before its rows came: they name it, and select its row
  generation = 0; // bumped by every load, so answers to an older load are dropped
  commentsGeneration = 0;

  constructor(readonly kind: Kind, readonly id: string, title: string, readonly shared: boolean,
              readonly sort: Signal<number>) { // the Navigator's, an index into SORTS
    this.title = signal(title);
  }

  /** The search box's text. Typing selects the first match; emptying the box keeps the row you're on, if any matched. */
  search(query: string) {
    const none = this.items().every((i) => i.open === 'more');
    this.query.set(query);
    if (query.trim() || none) this.highlight.set(0);
  }

  /** A row's element id, by the row rather than its place, so a screen reader hears a new match at the same place. */
  optionId(item: Item): string {
    return `v${this.key}-${item.open}-${item.id}`;
  }

  move(by: number) {
    if (!this.ready()) return;
    this.highlight.update((h) => Math.max(0, Math.min(this.items().length - 1, h + by)));
  }

  private summarize(): string {
    const rows = this.all().flatMap((g) => g.items).filter((i) => i.open !== 'more'); // everything loaded, searched or not
    const count = (open: Kind) => rows.filter((i) => i.open === open).length;
    switch (this.kind) {
      case 'workspaces':
        return plural(rows.length, 'workspace');
      case 'spaces': {
        const shared = rows.length - count('space'); // folders and lists shared with you
        const spaces = rows.length - shared;
        if (!shared) return plural(spaces, 'space');
        return spaces ? `${plural(spaces, 'space')}, ${shared} shared with you` : `${shared} shared with you`;
      }
      case 'space': {
        const parts = [];
        if (count('folder')) parts.push(plural(count('folder'), 'folder'));
        if (count('list')) parts.push(plural(count('list'), 'list'));
        return parts.length ? new Intl.ListFormat('en-US').format(parts) : 'Empty';
      }
      case 'list':
        return `${plural(rows.length, 'open task')}${this.lastPage ? '' : ' so far'}, closed ones hidden`;
      case 'task':
        return '';
      default: // lists, folder
        return plural(rows.length, 'list');
    }
  }
}

/** What a failed load says in a banner or toast. */
export function describe(error: LoadError): string {
  switch (error.kind) {
    case 'network': return 'Can’t reach ClickUp.';
    case 'unreachable': return 'The ClickDown server isn’t running.';
    default: return error.message;
  }
}

const one = (items: Item[]): Group[] => (items.length ? [{ label: null, items }] : []);
const teamRow = (t: Team): Item => ({ open: 'spaces', id: t.id, name: t.name, color: t.color, members: t.member_count });
const spaceRow = (s: Space): Item => ({ open: 'space', id: s.id, name: s.name, color: s.color, statuses: s.statuses });
const folderRow = (f: Folder): Item => ({ open: 'folder', id: f.id, name: f.name, lists: f.list_count, tasks: f.task_count });
const listRow = (l: List): Item => ({ open: 'list', id: l.id, name: l.name, tasks: l.task_count });
const taskRow = (t: Task): Item => ({ open: 'task', id: t.id, name: t.name, task: t });

/** A list's tasks under their statuses, in the workflow's order, then the "Load more" row. */
function byStatus(tasks: Task[], lastPage: boolean): Group[] {
  const groups = new Map<string, Group>();
  for (const t of tasks) {
    let group = groups.get(t.status.status);
    if (!group) groups.set(t.status.status, (group = { label: cap(t.status.status), status: t.status, items: [] }));
    group.items.push(taskRow(t));
  }
  const sorted = [...groups.values()].sort((a, b) => (a.status?.orderindex ?? 0) - (b.status?.orderindex ?? 0));
  const more: Item = { open: 'more', id: '__more', name: 'Load more tasks' };
  return lastPage ? sorted : [...sorted, { label: null, items: [more] }];
}

/** The rail's steps, and which kind of frame chose each one. */
const LEVELS: { name: string; kind: Kind }[] = [
  { name: 'Workspace', kind: 'spaces' },
  { name: 'Space', kind: 'space' },
  { name: 'Folder', kind: 'folder' },
  { name: 'List', kind: 'list' },
  { name: 'Task', kind: 'task' },
];
/** The depth at which each kind of frame asks you to choose: a space's view offers folders and lists, and so on. */
const DEPTH: Record<Kind, number> = { workspaces: 0, spaces: 1, space: 2, folder: 3, lists: 3, list: 4, task: 4 };
const depthColor = (d: number) => `var(--d${Math.min(d, 4) + 1})`;
/** What each kind of frame's rows open: the only steps an address may take. */
const OPENS: Record<Kind, Kind[]> = {
  lists: ['list'], workspaces: ['spaces'], spaces: ['space', 'folder', 'list'], space: ['folder', 'list'],
  folder: ['list'], list: ['task'], task: ['task'],
};
/** The rail's name for a kind: "List". The address uses it too, in lowercase. */
const levelName = (kind: Kind) => LEVELS.find((l) => l.kind === kind)?.name ?? '';
type Step = Pick<Frame, 'kind' | 'id'>;
/** Where frames are, after the # in the address bar: /workspace/9/space/5/list/7/task/86abc. The root adds nothing. */
const address = (steps: Step[]) => '/' + steps.slice(1).map((s) => `${levelName(s.kind).toLowerCase()}/${s.id}`).join('/');

@Injectable({ providedIn: 'root' })
export class Navigator {
  private readonly backend = inject(Backend);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  readonly stack = signal<Frame[]>([]);
  /** The top frame as a one-element array, so `@for` animates frames in and out. */
  readonly top = computed(() => this.stack().slice(-1));
  /** Whether the last move went back; picks the slide direction. */
  readonly back = signal(false);
  /** How lists order their tasks, an index into SORTS: one choice for the visit, so the next list opens the same way. */
  readonly sort = signal(0);
  readonly toast = signal({ text: '', shown: false });
  private toastTimer?: ReturnType<typeof setTimeout>;
  private depthMove = { from: -1, to: -1 }; // the latest change of depth, which the rail animates

  /** The breadcrumb, drawn as a descent: every level, what was chosen there, and where a click goes back to. */
  readonly rail = computed(() => {
    const stack = this.stack();
    const top = stack.at(-1);
    if (!top) return null;
    const current = DEPTH[top.kind];
    if (current !== this.depthMove.to) this.depthMove = { from: this.depthMove.to, to: current };
    const { from, to } = this.depthMove;
    const moved = from >= 0 && from !== to;
    const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
    const at = (kind: Kind) => stack.findIndex((f) => f.kind === kind);
    const shared = stack.find((f) => f.shared); // opened from "Shared with you", so its space is unknown
    const levels = LEVELS.map(({ name, kind }, d): Level => {
      const target = kind === 'task' ? (top.kind === 'task' ? stack.length - 1 : -1) : at(kind);
      const frame = stack[target];
      const skipped = !frame && ((d === 1 && !!shared) || (d === 2 && at('list') >= 0));
      const value = frame ? frame.name()
        : !skipped ? null : d === 1 ? 'Shared with you' : shared?.kind === 'list' ? null : 'No folder';
      const reached = !skipped && value !== null;
      const label = skipped
        ? d === 1 ? 'Space: none, this was shared with you directly'
          : value ? 'Folder: none, this list isn’t in a folder' : 'Folder: none, this list was shared with you directly'
        : reached ? `${name}: ${value}` : d === current ? `${name}: choose one` : `${name}: not open yet`;
      return {
        d, name, value, label, reached, skipped,
        current: d === current,
        ahead: !reached && !skipped && d > current,
        stemOn: d < current,
        target,
        clickable: reached && target >= 0 && target < stack.length - 1,
        step: moved && d >= lo && d < hi ? (to > from ? d - lo : hi - 1 - d) : 0,
        color: depthColor(d),
        nextColor: depthColor(d + 1),
      };
    });
    const onlyLists = stack[0].kind === 'lists';
    return {
      rootLabel: onlyLists ? 'All your lists' : 'All workspaces',
      rootEnabled: stack.length > 1,
      levels: onlyLists ? levels.slice(3) : levels,
      current,
      down: moved && to > from,
      popDelay: moved && to > from ? (hi - lo - 1) * 70 + 150 : 0,
    };
  });

  constructor() {
    // Back, Forward, a bookmark or an edited address: the frames follow.
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.follow(e.urlAfterRedirects);
    });
  }

  /** Starts over at the address: the settings or the token may have changed, so every frame loads again. */
  start() {
    this.stack.set([]);
    this.depthMove = { from: -1, to: -1 };
    this.follow(this.location.path() || '/'); // the address bar's: at boot the router hasn't read it yet
  }

  /** Opens a row, as a new entry in the browser's history. */
  push(kind: Kind, id: string) {
    this.go(address([...this.stack(), { kind, id }]));
  }

  popTo(index: number) {
    if (index < 0 || index >= this.stack().length - 1) return;
    this.go(address(this.stack().slice(0, index + 1)));
  }

  pop() {
    this.popTo(this.stack().length - 2);
  }

  /** Opens the highlighted row, or loads the next page when "Load more" is highlighted. */
  activate(frame: Frame) {
    const item = frame.ready() ? frame.items()[frame.highlight()] : undefined;
    if (item?.open === 'more') void this.loadMore(frame);
    else if (item) this.push(item.open, item.id);
  }

  /** A click on row `index`. A view on its way out ignores clicks. */
  open(frame: Frame, index: number) {
    if (frame !== this.stack().at(-1)) return;
    frame.highlight.set(index);
    this.activate(frame);
  }

  /** S, and the Sort button: every list's tasks in the next order. Only the pages loaded are sorted, so it says so. */
  sortNext(frame: Frame) {
    const sort = (this.sort() + 1) % SORTS.length;
    this.sort.set(sort);
    const loaded = frame.lastPage || !SORTS[sort].compare ? '' : `, among the ${plural(frame.tasks.length, 'task')} loaded so far`;
    this.say(`Sorted ${SORTS[sort].says}${loaded}.`);
  }

  /** The first load, or a refresh: a ready frame keeps showing its rows until the answer arrives. */
  async load(frame: Frame) {
    const generation = ++frame.generation;
    if (frame.ready()) frame.busy.set('Refreshing');
    else frame.error.set(null);
    if (frame.kind === 'task') void this.loadComments(frame);
    try {
      const apply = await this.retrieve(frame);
      if (generation !== frame.generation) return;
      apply();
      frame.ready.set(true);
      frame.error.set(null); // the highlight stays on its row by itself
      const { opened } = frame; // by an address, maybe gone back from since
      frame.opened = undefined;
      const stack = this.stack();
      if (opened && !this.place(frame, opened) && stack.includes(opened)) { // it isn't here: the address ends above it
        this.go(address(stack.slice(0, stack.indexOf(opened))), true);
      }
    } catch (e) {
      if (generation === frame.generation) frame.error.set(e as LoadError);
    } finally {
      if (generation === frame.generation) frame.busy.set(null);
    }
  }

  /** The next page of a list's tasks. A failure keeps what's on screen and says so. */
  async loadMore(frame: Frame) {
    if (frame.busy() || frame.lastPage) return;
    const generation = frame.generation;
    frame.busy.set('Loading more');
    try {
      const page = frame.page + 1;
      const { tasks, last_page } = await this.backend.get<TasksPage>(`/api/list/${frame.id}/task?page=${page}`);
      if (generation !== frame.generation) return;
      const known = new Set(frame.tasks.map((t) => t.id)); // a task can move between pages meanwhile
      const fresh = tasks.filter((t) => !known.has(t.id));
      frame.tasks = [...frame.tasks, ...fresh];
      frame.page = page;
      frame.lastPage = last_page;
      frame.all.set(byStatus(frame.tasks, last_page));
      const ids = new Set(fresh.map((t) => t.id));
      const shown = frame.items().filter((i) => ids.has(i.id)); // in screen order: searched and sorted
      if (shown[0]) frame.highlight.set(frame.items().indexOf(shown[0])); // none shown: the selection stays where it is
      const matching = frame.query().trim() ? `, ${shown.length || 'none'} matching the search` : '';
      if (this.stack().includes(frame)) {
        this.say(`Loaded ${plural(fresh.length, 'more task')}${matching}${last_page ? '. That’s all of them.' : '.'}`);
      }
    } catch (e) {
      if (generation === frame.generation && this.stack().includes(frame)) {
        this.say(`More tasks didn’t load. ${describe(e as LoadError)}`);
      }
    } finally {
      if (generation === frame.generation) frame.busy.set(null);
    }
  }

  /** A task's comments, or with `older` the page before the oldest one shown. */
  async loadComments(frame: Frame, older = false) {
    const oldest = frame.comments()?.at(-1);
    if (older && (!oldest || frame.olderBusy())) return;
    const generation = ++frame.commentsGeneration;
    frame.olderBusy.set(older);
    if (!older) frame.commentsError.set(null);
    try {
      const query = older && oldest ? `?start=${oldest.date}&start_id=${oldest.id}` : '';
      const page = await this.backend.get<CommentsPage>(`/api/task/${frame.id}/comment${query}`);
      if (generation !== frame.commentsGeneration) return;
      frame.comments.update((shown) => {
        if (!older || !shown) return page.comments;
        const known = new Set(shown.map((c) => c.id));
        return [...shown, ...page.comments.filter((c) => !known.has(c.id))];
      });
      frame.olderComments.set(page.has_more);
    } catch (e) {
      if (generation !== frame.commentsGeneration) return;
      // Only a first load has nothing to keep on screen; otherwise the comments stay and a toast says why.
      if (!older && !frame.comments()) frame.commentsError.set(e as LoadError);
      else if (this.stack().includes(frame)) {
        this.say(`${older ? 'Older comments didn’t load' : 'Comments didn’t refresh'}. ${describe(e as LoadError)}`);
      }
    } finally {
      if (generation === frame.commentsGeneration) frame.olderBusy.set(false);
    }
  }

  /** Where a task sits, for its view's head. */
  whereIs(frame: Frame): string {
    const task = frame.task();
    if (!task) return '';
    if (!task.parent) return `In ${task.list?.name || 'a list'}`;
    const stack = this.stack();
    const parent = stack[stack.indexOf(frame) - 1];
    const known = parent?.kind === 'task' && parent.id === task.parent;
    return `Subtask of ${known ? parent.name() : 'another task'}`;
  }

  /** Shows a short message at the bottom; screen readers announce it too. */
  say(text: string) {
    this.toast.set({ text, shown: true });
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.update((t) => ({ ...t, shown: false })), 3600);
  }

  /** The frames move at once; the address bar and the history catch up. */
  private go(url: string, replaceUrl = false) {
    this.follow(url);
    void this.router.navigateByUrl(url, { replaceUrl });
  }

  /**
   * Shows what an address asks for: the root (the lists in only_lists in config.toml if set, else the
   * workspaces), then each step down. Frames already open on the way stay as they are; the others open and
   * load, the one on screen first. A step no row could take ends the descent, and the address bar then says
   * where: a level that doesn't follow the one above at once, and a row the level above doesn't have (moved,
   * archived, mistyped) once its rows arrive.
   */
  private follow(url: string) {
    const onlyLists = this.backend.settings().only_lists.length > 0;
    const want: Step[] = [{ kind: onlyLists ? 'lists' : 'workspaces', id: '' }];
    const segments = this.router.parseUrl(url).root.children[PRIMARY_OUTLET]?.segments.map((s) => s.path) ?? [];
    for (let i = 0; i + 1 < segments.length; i += 2) {
      const kind = OPENS[want[want.length - 1].kind].find((k) => levelName(k).toLowerCase() === segments[i]);
      if (!kind || !/^[\w-]+$/.test(segments[i + 1])) break; // the server's /api paths allow no more
      want.push({ kind, id: segments[i + 1] });
    }
    const stack = this.stack();
    let kept = 0;
    while (kept < want.length && stack[kept]?.kind === want[kept].kind && stack[kept]?.id === want[kept].id) kept++;
    if (kept < want.length || kept < stack.length) {
      const frames = stack.slice(0, kept);
      for (const { kind, id } of want.slice(kept)) {
        const parent = frames.at(-1);
        const title = parent ? `${levelName(kind)} ${id}` : onlyLists ? 'Your lists' : 'Workspaces';
        const shared = parent?.kind === 'spaces' && kind !== 'space'; // under "Shared with you"
        const frame = new Frame(kind, id, title, shared, this.sort);
        if (parent && !(parent.ready() && this.place(parent, frame))) {
          parent.opened = frame;
          if (parent.ready()) void this.load(parent); // its rows may be older than the address: they're asked again
        }
        frames.push(frame);
      }
      this.back.set(kept === want.length);
      this.stack.set(frames);
      // The one on screen first: the browser opens only 6 connections to the server, and the rest wait.
      for (const frame of frames.slice(kept).reverse()) void this.load(frame);
    }
    // Settings the server hasn't sent may be wrong about only_lists, so the address waits for them (see r).
    if (address(want) !== url && this.backend.settingsKnown()) void this.router.navigateByUrl(address(want), { replaceUrl: true });
  }

  /**
   * Names a frame after its row in the frame above and selects the row, so going back lands on it. False when
   * the row isn't there, unless it's a task: a list's rows are its open tasks, a page at a time.
   */
  private place(parent: Frame, child: Frame): boolean {
    const row = parent.all().flatMap((g) => g.items).find((i) => i.open === child.kind && i.id === child.id);
    if (!row) return child.kind === 'task';
    child.title.set(row.name);
    const at = parent.items().indexOf(row); // -1 when a search hides it
    if (at >= 0) parent.highlight.set(at);
    return true;
  }

  /** Reads what the frame shows and returns how to put it in place. */
  private async retrieve(f: Frame): Promise<() => void> {
    const api = <T>(path: string) => this.backend.get<T>(`/api/${path}`);
    const show = (groups: Group[]) => () => f.all.set(groups);
    switch (f.kind) {
      case 'lists': { // only_lists in config.toml: just those lists
        // A bad id (a typo, a deleted list) doesn't hide the others; its row opens to show why.
        const ids = [...new Set(this.backend.settings().only_lists)]; // each once: a row's id is its element's
        const lists = await Promise.allSettled(ids.map((id) => api<List>(`list/${id}`)));
        const failed = lists.filter((l) => l.status === 'rejected');
        if (failed.length === ids.length && failed[0]) throw failed[0].reason; // e.g. the server is down
        return show(one(lists.map((l, i): Item => l.status === 'fulfilled'
          ? listRow(l.value)
          : { open: 'list', id: ids[i], name: `List ${ids[i]} (couldn’t be loaded)` })));
      }
      case 'workspaces': {
        const { teams } = await api<{ teams: Team[] }>('team');
        return show(one(teams.map(teamRow)));
      }
      case 'spaces': {
        // Folders and lists shared with you directly ("Shared with me" in ClickUp) can sit in
        // spaces you can't open, so they are listed here too.
        const [{ spaces }, { shared }] = await Promise.all([
          api<{ spaces: Space[] }>(`team/${f.id}/space`),
          api<SharedHierarchy>(`team/${f.id}/shared`),
        ]);
        const sharedRows = [...shared.folders.map(folderRow), ...shared.lists.map(listRow)];
        return show([{ label: null, items: spaces.map(spaceRow) }, { label: 'Shared with you', items: sharedRows }]
          .filter((g) => g.items.length));
      }
      case 'space': {
        const [{ folders }, { lists }] = await Promise.all([
          api<{ folders: Folder[] }>(`space/${f.id}/folder`),
          api<{ lists: List[] }>(`space/${f.id}/list`),
        ]);
        return show([{ label: 'Folders', items: folders.map(folderRow) }, { label: 'Lists', items: lists.map(listRow) }]
          .filter((g) => g.items.length));
      }
      case 'folder': {
        const { lists } = await api<{ lists: List[] }>(`folder/${f.id}/list`);
        return show(one(lists.map(listRow)));
      }
      case 'list': {
        const { tasks, last_page } = await api<TasksPage>(`list/${f.id}/task?page=0`);
        return () => {
          f.tasks = tasks;
          f.page = 0;
          f.lastPage = last_page;
          f.all.set(byStatus(tasks, last_page));
        };
      }
      case 'task': {
        const task = await api<TaskDetail>(`task/${f.id}`);
        return () => {
          f.task.set(task);
          f.all.set(one(task.subtasks.map(taskRow)));
        };
      }
    }
  }
}
