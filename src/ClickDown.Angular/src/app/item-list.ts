import { Component, ElementRef, afterRenderEffect, computed, inject, input } from '@angular/core';
import { age, cap, color, dueInfo, plural, stamp } from './format';
import { Task } from './models';
import { Frame, Kind, Navigator } from './navigator';

/** The one listbox: workspaces, spaces, folders, lists, tasks, and a task's subtasks. */
@Component({
  selector: 'app-item-list',
  template: `
    @let f = frame();
    @if (!f.ready() && f.kind !== 'task') {
      <div class="sk" aria-hidden="true">
        @for (n of f.kind === 'list' ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4]; track n) {
          <div class="sk-row"><span class="sk-dot"></span><span class="sk-bar"></span><span class="sk-bar"></span></div>
        }
      </div>
      <span class="sr-only">Loading</span>
    } @else if (!f.items().length && f.kind !== 'task') {
      <div class="state"><p>{{ f.all().length ? 'Nothing here matches “' + f.query().trim() + '”. Esc clears the search.' : empty[f.kind] }}</p></div>
    } @else {
      <div class="rows" role="listbox" tabindex="0" [id]="'v' + f.key + '-rows'" [attr.aria-label]="f.kind === 'task' ? 'Subtasks' : f.name()"
           [attr.aria-activedescendant]="f.active()">
        @for (g of f.groups(); track $index; let gi = $index) {
          <div role="group" [attr.aria-label]="g.status ? g.label + ', ' + plural(g.items.length, 'task') : g.label">
            @if (g.status) {
              <div class="group-head" aria-hidden="true"><span class="sdot" [style.--s]="color(g.status.color)"></span>{{ g.label }}<span class="count num">{{ g.items.length }}</span></div>
            } @else if (g.label) {
              <div class="sub-head" aria-hidden="true">{{ g.label }}</div>
            }
            @for (item of g.items; track item.open + item.id; let j = $index) {
              @let i = starts()[gi] + j;
              <div class="row" [class.more]="item.open === 'more'" role="option" [id]="f.optionId(item)"
                   [attr.aria-selected]="i === f.highlight()" (click)="click(f, i, $event)">
                @if (item.task; as t) {
                  @let due = dueInfo(t.due_date, t.status.type === 'closed');
                  @let id = t.custom_id || t.id;
                  <span class="row-icon"><span class="sdot" [style.--s]="color(t.status.color)" aria-hidden="true"></span></span>
                  <span class="row-name">{{ t.name }}</span>
                  <span class="row-meta task-meta">@if (f.kind === 'task') {<span class="pill" [style.--s]="color(t.status.color)" [title]="cap(t.status.status)"><span class="sdot" aria-hidden="true"></span><span>{{ cap(t.status.status) }}</span></span>} @else {<span class="tags">@for (tag of t.tags.slice(0, 2); track tag.name) {<span class="tag" [style.--t]="color(tag.tag_bg || tag.tag_fg)" [title]="tag.name">{{ tag.name }}</span>}</span>}<span class="task-id" [title]="id"><span class="sr-only">ID </span><bdi>{{ id }}</bdi></span><span>@if (t.priority; as p) {<span [title]="cap(p.priority) + ' priority'"><svg class="flag" viewBox="0 0 16 16" [style.--p]="color(p.color)" aria-hidden="true"><path d="M3 1.5h1.5v13H3z"/><path d="M4.5 2.2h8l-1.8 3.2 1.8 3.2h-8z"/></svg><span class="sr-only">{{ cap(p.priority) }} priority.</span></span>}</span><span>@if (due) {<span class="due" [class.overdue]="due.overdue" [title]="due.title">{{ due.text }}@if (due.overdue) {<span class="sr-only">, overdue</span>}</span>}</span><span>@if (t.date_created) {<span class="created" [title]="stamp(t.date_created)"><span class="sr-only">Created </span>{{ age(t.date_created) }}</span>}</span><span>@if (t.assignees.length) {<span class="avatars" [title]="names(t)">@for (a of t.assignees.slice(0, 3); track a.id) {<span class="av" [style.--av]="color(a.color)" aria-hidden="true">{{ a.initials }}</span>}<span class="sr-only">Assigned to {{ names(t) }}.</span></span>}</span></span>
                } @else if (item.open === 'more') {
                  <span class="row-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                  <span class="row-name">{{ f.busy() === 'Loading more' ? 'Loading more tasks…' : 'Load more tasks' }}</span>
                  <span class="row-meta">Next page of up to 100</span>
                } @else if (item.open === 'folder') {
                  <span class="row-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>
                  <span class="row-name">{{ item.name }}</span>
                  <span class="row-meta">{{ item.lists != null ? plural(item.lists, 'list') : item.tasks != null ? plural(item.tasks, 'task') : '' }}</span>
                } @else if (item.open === 'list') {
                  <span class="row-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 7h10M9.5 12h10M9.5 17h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="5" cy="7" r="1.3" fill="currentColor"/><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="5" cy="17" r="1.3" fill="currentColor"/></svg></span>
                  <span class="row-name">{{ item.name }}</span>
                  <span class="row-meta">{{ item.tasks != null ? plural(item.tasks, 'task') : '' }}</span>
                } @else {
                  <span class="row-icon"><span class="sq" [style.--sq]="color(item.color, '#245775')" aria-hidden="true">{{ item.name.charAt(0) }}</span></span>
                  <span class="row-name">{{ item.name }}</span>
                  <span class="row-meta">
                    @if (item.statuses; as statuses) {
                      <span class="strip" aria-hidden="true">@for (s of statuses; track $index) {<i [style.--s]="color(s.color)" [title]="cap(s.status)"></i>}</span>{{ plural(statuses.length, 'status', 'statuses') }}
                    } @else {
                      {{ plural(item.members ?? 0, 'member') }}
                    }
                  </span>
                }
              </div>
            }
          </div>
        }
      </div>
    }
  `,
})
export class ItemList {
  readonly frame = input.required<Frame>();
  protected readonly nav = inject(Navigator);
  protected readonly age = age;
  protected readonly cap = cap;
  protected readonly color = color;
  protected readonly dueInfo = dueInfo;
  protected readonly plural = plural;
  protected readonly stamp = stamp;
  /** Where each group's rows start in the frame's flat list of items. */
  protected readonly starts = computed(() => {
    let n = 0;
    return this.frame().groups().map((g) => (n += g.items.length) - g.items.length);
  });
  protected readonly empty: Record<Kind, string> = {
    lists: 'None of the lists in only_lists was found.',
    workspaces: 'This token can’t see any workspaces.',
    spaces: 'There are no spaces in this workspace that you can see, and nothing is shared with you.',
    space: 'This space has no folders or lists yet.',
    folder: 'This folder has no lists yet.',
    list: 'No open tasks in this list. ClickDown shows open tasks only, so closed ones stay hidden.',
    task: '',
  };

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    let last = ''; // no scrolling on the first render: a task view must stay at its top
    afterRenderEffect(() => {
      const f = this.frame();
      const at = `${f.highlight()} ${f.query()} ${f.sort()}`; // a search or a sort moves the rows under the selection too
      if (last && at !== last) host.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
      last = at;
    });
  }

  private static readonly NAMES = new Intl.ListFormat('en-US');

  protected names(task: Task): string {
    return ItemList.NAMES.format(task.assignees.map((a) => a.username ?? '?'));
  }

  /** A click focuses the list, so the keys go on from here, then opens the row. */
  protected click(frame: Frame, index: number, event: MouseEvent) {
    (event.currentTarget as HTMLElement).closest<HTMLElement>('.rows')?.focus({ preventScroll: true });
    this.nav.open(frame, index);
  }
}
