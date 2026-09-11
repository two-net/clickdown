import { Component, computed, inject, input } from '@angular/core';
import { ago, cap, color, day, dueInfo, duration, fullDate, plural } from './format';
import { ItemList } from './item-list';
import { Frame, Navigator, describe } from './navigator';

/** A task, as a document: properties, description, subtasks and comments. */
@Component({
  selector: 'app-task-detail',
  imports: [ItemList],
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
            <dd><span [title]="fullDate(t.date_created)">{{ ago(t.date_created) }} by {{ t.creator?.username || 'someone' }}</span></dd>
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
  protected readonly ago = ago;
  protected readonly cap = cap;
  protected readonly color = color;
  protected readonly day = day;
  protected readonly describe = describe;
  protected readonly dueInfo = dueInfo;
  protected readonly duration = duration;
  protected readonly fullDate = fullDate;
  protected readonly plural = plural;
  /** ClickUp pages comments newest first; they read oldest first. */
  protected readonly oldestFirst = computed(() => [...(this.frame().comments() ?? [])].reverse());
  protected readonly commentCount = computed(() => {
    const comments = this.frame().comments();
    return comments?.length ? `${comments.length}${this.frame().olderComments() ? '+' : ''}` : '';
  });
  protected iso(ms: number): string {
    return new Date(ms).toISOString();
  }
}
