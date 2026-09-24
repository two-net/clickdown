import { Component, computed, inject, input } from '@angular/core';
import { age, ago, bytes, cap, color, day, dueInfo, duration, fullDate, plural, stamp } from './format';
import { ItemList } from './item-list';
import { Attachment } from './models';
import { Frame, Navigator, describe } from './navigator';

/** Files as links, so nothing loads until one is opened. */
@Component({
  selector: 'app-files',
  template: `
    <ul class="files">
      @for (a of files(); track a.id) {
        <li class="file">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5m-5-5 5 5m-5-5v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          @if (a.url) {
            <a [href]="a.url">{{ a.title || 'Untitled file' }}</a>
          } @else {
            <span>{{ a.title || 'Untitled file' }}</span>
          }
          <span class="file-meta">
            @if (a.size != null) {
              <span class="num">{{ bytes(a.size) }}</span>
            }
            @if (a.date && byline()) {
              <span [title]="fullDate(a.date)">{{ ago(a.date) }} by {{ a.user?.username || 'someone' }}</span>
            }
          </span>
        </li>
      }
    </ul>
  `,
})
export class Files {
  readonly files = input.required<Attachment[]>();
  /** When and by whom; under a comment, its head already says. */
  readonly byline = input(true);
  protected readonly ago = ago;
  protected readonly bytes = bytes;
  protected readonly fullDate = fullDate;
}

/** A task, as a document: properties, description, subtasks, attachments and comments. */
@Component({
  selector: 'app-task-detail',
  imports: [Files, ItemList],
  template: `
    @let f = frame();
    @if (f.task(); as t) {
      @let due = dueInfo(t.due_date, t.status.type === 'closed');
      <article class="task-doc">
        <dl class="props">
          <dt>Assignees</dt>
          <dd>
            @for (a of t.assignees; track a.id) {
              <span class="person"><span class="av" [style.--av]="color(a.color)" aria-hidden="true">{{ a.initials }}</span>{{ a.username }}</span>
            } @empty {
              <span class="muted">Unassigned</span>
            }
          </dd>
          <dt>Priority</dt>
          <dd>
            @if (t.priority; as p) {
              <span class="person"><svg class="flag" viewBox="0 0 16 16" [style.--p]="color(p.color)" aria-hidden="true"><path d="M3 1.5h1.5v13H3z"/><path d="M4.5 2.2h8l-1.8 3.2 1.8 3.2h-8z"/></svg>{{ cap(p.priority) }}</span>
            } @else {
              <span class="muted">None</span>
            }
          </dd>
          <dt>Due</dt>
          <dd>
            @if (due) {
              <span class="due" [class.overdue]="due.overdue" [title]="due.title">{{ day(t.due_date) }}{{ due.overdue ? ', overdue' : '' }}</span>
            } @else {
              <span class="muted">No due date</span>
            }
          </dd>
          @if (t.start_date) {
            <dt>Start</dt>
            <dd><span [title]="fullDate(t.start_date)">{{ day(t.start_date) }}</span></dd>
          }
          @if (t.time_estimate) {
            <dt>Estimate</dt>
            <dd>{{ duration(t.time_estimate) }}</dd>
          }
          @if (t.points != null) {
            <dt>Points</dt>
            <dd>{{ t.points }}</dd>
          }
          @if (t.tags.length) {
            <dt>Tags</dt>
            <dd><span class="tags">@for (tag of t.tags; track tag.name) {<span class="tag" [style.--t]="color(tag.tag_bg || tag.tag_fg)">{{ tag.name }}</span>}</span></dd>
          }
          @if (t.date_created) {
            <dt>Created</dt>
            <dd><span [title]="stamp(t.date_created)">{{ age(t.date_created) }} by {{ t.creator?.username || 'someone' }}</span></dd>
          }
          @if (t.date_updated) {
            <dt>Updated</dt>
            <dd><span [title]="fullDate(t.date_updated)">{{ ago(t.date_updated) }}</span></dd>
          }
        </dl>

        <h2 class="section-h">Description</h2>
        @if (t.description_html) {
          <div class="md" [innerHTML]="t.description_html"></div>
        } @else {
          <p class="muted">No description.</p>
        }

        @if (t.subtasks.length) {
          <h2 class="section-h">Subtasks <span class="count num">{{ t.subtasks.length }}</span></h2>
          <app-item-list [frame]="f" />
        }

        @if (t.attachments.length) {
          <h2 class="section-h">Attachments <span class="count num">{{ t.attachments.length }}</span></h2>
          <app-files [files]="t.attachments" />
        }

        <h2 class="section-h">Comments <span class="count num">{{ commentCount() }}</span></h2>
        <div class="comments" [attr.aria-busy]="f.comments() === null && !f.commentsError()">
          @if (f.commentsError(); as error) {
            <p class="muted">Comments didn’t load. {{ describe(error) }} <button class="linkish" type="button" (click)="nav.loadComments(f)">Load comments</button></p>
          } @else if (f.comments()) {
            @if (f.olderComments()) {
              <button class="linkish older" type="button" [disabled]="f.olderBusy()" (click)="nav.loadComments(f, true)">{{ f.olderBusy() ? 'Loading older comments…' : 'Load older comments' }}</button>
            }
            @for (c of oldestFirst(); track c.id) {
              <div class="comment">
                <span class="av lg" [style.--av]="color(c.user?.color)" aria-hidden="true">{{ c.user?.initials || '?' }}</span>
                <div>
                  <div class="comment-head">
                    <span class="comment-name">{{ c.user?.username || 'Unknown user' }}</span>
                    @if (c.date) {
                      <time class="comment-time" [attr.datetime]="iso(c.date)" [title]="fullDate(c.date)">{{ ago(c.date) }}</time>
                    }
                    @if (c.reply_count) {
                      <span class="comment-time">· {{ plural(c.reply_count, 'reply', 'replies') }}</span>
                    }
                  </div>
                  <p class="comment-text">{{ c.comment_text }}</p>
                  @if (commentFiles().get(c.id); as files) {
                    <app-files [files]="files" [byline]="false" />
                  }
                </div>
              </div>
            } @empty {
              <p class="muted">No comments yet.</p>
            }
          } @else {
            <div aria-hidden="true">
              @for (n of [1, 2]; track n) {
                <div class="sk-row comment-sk"><span class="sk-dot"></span><span class="sk-bar"></span></div>
              }
            </div>
          }
        </div>
        <p class="readonly-note">ClickDown is read-only. To change this task, edit it in ClickUp.</p>
      </article>
    } @else {
      <div class="task-doc sk task-sk" aria-hidden="true">
        @for (n of [1, 2, 3, 4, 5, 6, 7, 8, 9]; track n) {
          <div class="sk-bar"></div>
        }
      </div>
      <span class="sr-only">Loading</span>
    }
  `,
})
export class TaskDetail {
  readonly frame = input.required<Frame>();
  protected readonly nav = inject(Navigator);
  protected readonly age = age;
  protected readonly ago = ago;
  protected readonly cap = cap;
  protected readonly color = color;
  protected readonly day = day;
  protected readonly describe = describe;
  protected readonly dueInfo = dueInfo;
  protected readonly duration = duration;
  protected readonly fullDate = fullDate;
  protected readonly plural = plural;
  protected readonly stamp = stamp;
  /** ClickUp pages comments newest first; they read oldest first. */
  protected readonly oldestFirst = computed(() => [...(this.frame().comments() ?? [])].reverse());
  /** A comment's files by comment id, oldest first like its text: ClickUp lists them, newest first, with the task's own. */
  protected readonly commentFiles = computed(() => {
    const files = new Map<string, Attachment[]>();
    for (const a of this.frame().task()?.attachments ?? []) if (a.parent_id) files.set(a.parent_id, [a, ...(files.get(a.parent_id) ?? [])]);
    return files;
  });
  protected readonly commentCount = computed(() => {
    const comments = this.frame().comments();
    return comments?.length ? `${comments.length}${this.frame().olderComments() ? '+' : ''}` : '';
  });
  protected iso(ms: number): string {
    return new Date(ms).toISOString();
  }
}
