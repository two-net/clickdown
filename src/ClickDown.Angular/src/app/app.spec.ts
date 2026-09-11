import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { App } from './app';
import { Backend } from './backend';

const ada = { user: { id: 1, username: 'Ada', email: null, color: '#7b68ee', initials: 'A' } };
const rejected = { error: 'unauthorized', message: 'Token invalid', config_path: '/x/config.toml' };
const task = (id: string, status: string, orderindex: number, extra: object = {}) => ({
  id, custom_id: null, name: `Task ${id}`, status: { status, color: '#87909e', type: 'custom', orderindex },
  priority: null, assignees: [], tags: [], due_date: null, date_created: null, parent: null, ...extra,
});

describe('App', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Backend).settings.set({ animations: false, only_lists: [] }); // no splash to skip
  });

  afterEach(() => http.verify());

  /** A key press; false when the app took it (preventDefault). */
  const press = (key: string, target: EventTarget = document) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const type = (box: HTMLInputElement, value: string) => {
    box.value = value;
    box.dispatchEvent(new Event('input'));
  };
  const text = (fixture: ComponentFixture<App>) => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const names = (el: HTMLElement) => [...el.querySelectorAll('.row-name')].map((n) => n.textContent);
  const selected = (el: HTMLElement) => el.querySelector('[aria-selected="true"] .row-name')?.textContent;
  async function settle(fixture: ComponentFixture<App>) {
    await new Promise((done) => setTimeout(done));
    await fixture.whenStable();
  }

  /** Boots and walks Acme → Eng → Bugs, a list that isn't in a folder. */
  async function openList() {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/user').flush(ada);
    http.expectOne('/api/team').flush({ teams: [{ id: '9', name: 'Acme', color: '#245775', member_count: 3 }] });
    await settle(fixture);
    press('Enter');
    http.expectOne('/api/team/9/space').flush({ spaces: [{ id: '5', name: 'Eng', color: null, statuses: [] }] });
    http.expectOne('/api/team/9/shared').flush({ shared: { folders: [], lists: [] } });
    await settle(fixture);
    press('Enter');
    http.expectOne('/api/space/5/folder').flush({ folders: [] });
    http.expectOne('/api/space/5/list').flush({ lists: [{ id: '7', name: 'Bugs', task_count: 4 }] });
    await settle(fixture);
    press('Enter');
    return fixture;
  }

  it('shows the workspaces and where you are', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/user').flush(ada);
    http.expectOne('/api/team').flush({ teams: [{ id: '9', name: 'Acme', color: null, member_count: 3 }] });
    await settle(fixture);

    expect(text(fixture)).not.toContain('Signed in as');
    expect(text(fixture)).toContain('Acme');
    expect(text(fixture)).toContain('3 members');
    expect(text(fixture)).toContain('1 workspace');
    expect(fixture.nativeElement.querySelector('.lvl.is-current')?.textContent).toContain('Workspace');
  });

  it('re-reads the settings on r, and one refused id in only_lists hides no list', async () => {
    const fixture = TestBed.createComponent(App); // booted while the server was down
    http.expectOne('/api/user').flush('proxy error', { status: 500, statusText: 'Internal Server Error' });
    http.expectOne('/api/team').flush('proxy error', { status: 500, statusText: 'Internal Server Error' });
    await settle(fixture);
    expect(text(fixture)).toContain('ClickDown server isn’t running');

    press('r'); // after starting it with only_lists
    http.expectOne('/api/user').flush(ada);
    http.expectOne('/api/settings').flush({ animations: false, only_lists: ['901', '902'] });
    await settle(fixture);
    http.expectOne('/api/list/901').flush({ id: '901', name: 'Roadmap', task_count: 3 });
    http.expectOne('/api/list/902').flush(rejected, { status: 401, statusText: 'Unauthorized' }); // "Team not authorized"
    await settle(fixture);

    expect(text(fixture)).toContain('Roadmap');
    expect(text(fixture)).toContain('List 902 (couldn’t be loaded)');
    expect(text(fixture)).toContain('All your lists');
    expect(text(fixture)).not.toContain('Workspaces'); // and afterEach's verify(): no /api/team
    expect(text(fixture)).not.toContain('didn’t accept the token');
  });

  it('stops on a token ClickUp rejects', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/user').flush(rejected, { status: 401, statusText: 'Unauthorized' });
    http.expectOne('/api/team').flush(rejected, { status: 401, statusText: 'Unauthorized' });
    await settle(fixture);

    expect(text(fixture)).toContain('ClickUp didn’t accept the token');
    expect(text(fixture)).toContain('/x/config.toml');
    expect(document.title).toBe('ClickDown stopped');
  });

  it('groups a list by status, pages through it, and survives a failed page', async () => {
    const fixture = await openList();
    http.expectOne('/api/list/7/task?page=0').flush({
      tasks: [
        task('a', 'in progress', 1),
        task('b', 'to do', 0, { custom_id: 'BUG-12', date_created: new Date(2019, 8, 5, 7, 4).getTime() }),
        task('c', 'in progress', 1),
      ],
      last_page: false,
    });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const heads = [...el.querySelectorAll('.group-head')].map((h) => h.textContent);
    expect(heads).toEqual(['To do1', 'In progress2']);
    expect([...el.querySelectorAll('.task-id')].map((id) => id.textContent)).toEqual(['ID BUG-12', 'ID a', 'ID c']); // custom ID first
    expect(el.querySelector('.task-id')?.getAttribute('title')).toBe('BUG-12'); // in full, however narrow the column
    const created = el.querySelectorAll('.created'); // only task b has a date
    expect(created.length).toBe(1);
    expect(created[0].textContent).toMatch(/^Created \d+ years ago$/);
    expect(created[0].getAttribute('title')).toBe('05 Sep 2019 07:04');
    expect(text(fixture)).toContain('3 open tasks so far, closed ones hidden');
    expect(el.querySelectorAll('.lvl.stem-on').length).toBe(4);
    expect(text(fixture)).toContain('No folder');

    press('End');
    press('Enter');
    http.expectOne('/api/list/7/task?page=1').flush(
      { error: 'clickup', status: 500, message: 'Internal error' },
      { status: 502, statusText: 'Bad Gateway' },
    );
    await settle(fixture);
    expect(text(fixture)).toContain('More tasks didn’t load. Internal error');
    expect(text(fixture)).toContain('Task a');
    expect(text(fixture)).toContain('Load more tasks');
    expect(el.querySelector('.state.error')).toBeNull();

    press('Enter');
    http.expectOne('/api/list/7/task?page=1').flush({ tasks: [task('c', 'in progress', 1), task('d', 'to do', 0)], last_page: true });
    await settle(fixture);
    expect(text(fixture)).toContain('Loaded 1 more task. That’s all of them.');
    expect(text(fixture)).toContain('4 open tasks, closed ones hidden');
    expect(el.querySelector('[aria-selected="true"]')?.textContent).toContain('Task d');
    expect(text(fixture)).not.toContain('Load more tasks');
  });

  it('keeps the rows when a refresh fails, and the keys keep working', async () => {
    const fixture = TestBed.createComponent(App);
    const teams = { teams: [{ id: '1', name: 'Acme', color: null, member_count: 1 }, { id: '2', name: 'Home', color: null, member_count: 1 }] };
    http.expectOne('/api/user').flush(ada);
    http.expectOne('/api/team').flush(teams);
    await settle(fixture);

    press('r');
    http.expectOne('/api/settings').flush({ animations: false, only_lists: [] });
    await settle(fixture);
    http.expectOne('/api/team').flush({ error: 'clickup', status: 500, message: 'Internal error' }, { status: 502, statusText: 'Bad Gateway' });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.banner.error')?.textContent).toContain('Refresh failed. Internal error');
    expect(text(fixture)).toContain('Home');

    press('ArrowDown');
    await settle(fixture);
    expect(el.querySelector('[aria-selected="true"]')?.textContent).toContain('Home');

    press('r'); // a refresh that drops the selected row leaves the selection in its place
    http.expectOne('/api/settings').flush({ animations: false, only_lists: [] });
    await settle(fixture);
    http.expectOne('/api/team').flush({ teams: [teams.teams[0]] });
    await settle(fixture);
    expect(el.querySelector('[aria-selected="true"]')?.textContent).toContain('Acme');
  });

  it('shows ClickUp’s rate-limit numbers only while it sends them', async () => {
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/user').flush(ada, { headers: { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '97' } });
    await settle(fixture);
    expect(text(fixture)).toContain('97 of 100 requests left this minute');

    http.expectOne('/api/team').flush({ teams: [] });
    await settle(fixture);
    expect(text(fixture)).not.toContain('requests left');
  });

  it('shows a task, its comments oldest first, and opens a subtask only from the subtasks', async () => {
    TestBed.inject(Backend).settings.set({ animations: false, only_lists: ['7'] });
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/user').flush(ada);
    http.expectOne('/api/list/7').flush({ id: '7', name: 'Bugs', task_count: 1 });
    await settle(fixture);
    press('Enter');
    http.expectOne('/api/list/7/task?page=0').flush({ tasks: [task('a', 'in progress', 1)], last_page: true });
    await settle(fixture);
    press('Enter');

    const now = Date.now();
    const cy = { id: 3, username: 'Cy', email: null, color: '#94602A', initials: 'C' };
    http.expectOne('/api/task/a').flush({
      ...task('a', 'in progress', 1), priority: { priority: 'high', color: '#f8ae00' },
      subtasks: [task('s', 'to do', 0, { parent: 'a', date_created: new Date(2019, 8, 5, 7, 4).getTime() })], list: { id: '7', name: 'Bugs' },
      description_html: '<ul><li><span class="check done" role="img" aria-label="Done"></span>Ship it</li></ul>',
      creator: cy, date_created: now - 3 * 86_400_000, date_updated: now - 3_600_000, start_date: null,
      time_estimate: 5_400_000, points: 3,
    });
    http.expectOne('/api/task/a/comment').flush({
      comments: [
        { id: 'c2', comment_text: 'Second', user: cy, date: now - 300_000, reply_count: 2 },
        { id: 'c1', comment_text: 'First', user: null, date: now - 7_200_000, reply_count: 0 },
      ],
      has_more: true,
    });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const page = text(fixture);
    expect(el.querySelector('.find')).toBeNull(); // a task has no search box, so / stays the browser's
    expect(press('/')).toBe(true);
    expect(page).toContain('In Bugs');
    expect(page).toContain('High');
    expect(page).toContain('1 h 30 min');
    expect(page).toContain('3 days ago by Cy');
    const createdProp = [...el.querySelectorAll('.props dt')].find((dt) => dt.textContent === 'Created')?.nextElementSibling;
    expect(createdProp?.querySelector('span')?.getAttribute('title')).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}$/);
    expect(el.querySelector('.task-doc .created')?.getAttribute('title')).toBe('05 Sep 2019 07:04'); // the subtask's column
    expect(el.querySelector('.task-doc .task-id')?.textContent).toBe('ID s');
    expect(page).toContain('Unknown user');
    expect(page).toContain('2 replies');
    expect(page.indexOf('First')).toBeLessThan(page.indexOf('Second'));
    expect(el.querySelector('.md .check.done')?.getAttribute('aria-label')).toBe('Done'); // kept by the sanitizer
    expect(el.querySelectorAll('.lvl.stem-on').length).toBe(1);

    [...el.querySelectorAll<HTMLButtonElement>('.comments button')].find((b) => b.textContent?.includes('Load older'))?.click();
    http.expectOne(`/api/task/a/comment?start=${now - 7_200_000}&start_id=c1`).flush({
      comments: [{ id: 'c0', comment_text: 'Zeroth', user: cy, date: now - 86_400_000, reply_count: 0 }],
      has_more: false,
    });
    await settle(fixture);
    expect(text(fixture).indexOf('Zeroth')).toBeLessThan(text(fixture).indexOf('First'));
    expect(text(fixture)).not.toContain('Load older comments');

    press('Enter', el.querySelector('.view-body')!); // reading the task: Enter opens nothing
    http.expectNone('/api/task/s');
    const subtasks = el.querySelector<HTMLElement>('.task-doc .rows')!;
    subtasks.focus();
    press('Enter', subtasks);
    http.expectOne('/api/task/s/comment').flush({ comments: [], has_more: false });
    http.expectOne('/api/task/s').flush({ ...task('s', 'to do', 0, { parent: 'a' }), subtasks: [], description_html: '' });
    await settle(fixture);
    expect(text(fixture)).toContain('Subtask of Task a');
  });

  it('searches a list as you type, leaves the typing keys to the box, and Esc steps back out', async () => {
    const fixture = await openList();
    const zoe = { id: 4, username: 'Zoë', email: null, color: null, initials: 'Z' };
    http.expectOne('/api/list/7/task?page=0').flush({
      tasks: [
        task('a', 'to do', 0, { name: 'Café crash' }),
        task('b', 'to do', 0, { tags: [{ name: 'ui', tag_fg: null, tag_bg: null }] }),
        task('c', 'in progress', 1, { custom_id: 'BUG-12', assignees: [zoe] }),
      ],
      last_page: false,
    });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const box = () => el.querySelector<HTMLInputElement>('.find')!;
    const rows = () => el.querySelector<HTMLElement>('.rows')!;
    const search = async (value: string) => {
      type(box(), value);
      await settle(fixture);
    };

    press('End');
    press('ArrowUp'); // Task c
    expect(press('/')).toBe(false);
    expect(document.activeElement).toBe(box());
    await search('task'); // typing selects the first match
    expect(selected(el)).toBe('Task b');
    expect(text(fixture)).toContain('2 matches among 3 open tasks');
    await search('CAFE');
    expect(names(el)).toEqual(['Café crash', 'Load more tasks']);
    expect([...el.querySelectorAll('.group-head')].map((h) => h.textContent)).toEqual(['To do1']);
    expect(text(fixture)).toContain('1 match among 3 open tasks so far, closed ones hidden');
    expect(box().getAttribute('aria-activedescendant')).toBe(el.querySelector('[aria-selected="true"]')?.id);
    expect(box().getAttribute('aria-controls')).toBe(rows().id);
    const composing = { key: 'Enter', bubbles: true, cancelable: true };
    expect(box().dispatchEvent(new KeyboardEvent('keydown', { ...composing, isComposing: true }))).toBe(true); // left to the IME
    expect(box().dispatchEvent(new KeyboardEvent('keydown', { ...composing, keyCode: 229 }))).toBe(true); // Safari's
    await search('zoe bug-12'); // an assignee, and the ID the row shows
    expect(names(el)).toEqual(['Task c', 'Load more tasks']);
    await search('UI'); // a tag
    expect(names(el)).toEqual(['Task b', 'Load more tasks']);

    for (const key of ['j', 'k', 'r', 's', '?', '/', ' ', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(press(key, box())).toBe(true); // left to the box
    }
    await settle(fixture);
    http.expectNone('/api/settings'); // r didn't refresh
    expect(document.title).toBe('Bugs – ClickDown'); // Backspace didn't go back
    expect(text(fixture)).not.toContain('Sorted');

    await search('zoe');
    expect(press('ArrowDown', box())).toBe(false);
    expect(press('PageDown', box())).toBe(false);
    await settle(fixture);
    expect(selected(el)).toBe('Load more tasks');
    press('ArrowUp', box());
    press('Enter', box());
    http.expectOne('/api/task/c/comment').flush({ comments: [], has_more: false });
    http.expectOne('/api/task/c').flush({ ...task('c', 'in progress', 1), subtasks: [], description_html: '' });
    await settle(fixture);
    expect(document.title).toBe('Task c – ClickDown');

    press('Escape'); // back in Bugs, still searched
    await settle(fixture);
    expect(box().value).toBe('zoe');
    expect(names(el)).toEqual(['Task c', 'Load more tasks']);
    expect(document.activeElement).toBe(rows());
    press('/'); // selects the text, so typing starts afresh
    expect([box().selectionStart, box().selectionEnd]).toEqual([0, 3]);
    press('Escape', rows()); // clears the search, and stays on the row
    await settle(fixture);
    expect(box().value).toBe('');
    expect(names(el)).toEqual(['Café crash', 'Task b', 'Task c', 'Load more tasks']);
    expect(selected(el)).toBe('Task c');
    expect(document.title).toBe('Bugs – ClickDown');

    press('/');
    await search('zzz'); // nothing loaded matches, but the next page might
    expect(names(el)).toEqual(['Load more tasks']);
    press('Enter', box());
    http.expectOne('/api/list/7/task?page=1').flush({ tasks: [task('e', 'to do', 0, { name: 'zzz later' })], last_page: true });
    await settle(fixture);
    expect(names(el)).toEqual(['zzz later']);
    expect(selected(el)).toBe('zzz later');
    expect(text(fixture)).toContain('Loaded 1 more task, 1 matching the search. That’s all of them.');

    press('Escape', box()); // clears the text
    await settle(fixture);
    expect(box().value).toBe('');
    expect(document.activeElement).toBe(box());
    expect(selected(el)).toBe('zzz later');
    press('Escape', box()); // leaves the box
    expect(document.activeElement).toBe(rows());
    press('Escape', rows()); // goes back
    await settle(fixture);
    expect(document.title).toBe('Eng – ClickDown');
  });

  it('sorts a list’s tasks within each status, keeps the selected task, and keeps the order for the next list', async () => {
    const fixture = await openList();
    const day = 86_400_000;
    const now = Date.now();
    const page = {
      tasks: [
        task('10', 'to do', 0, { priority: { priority: 'low', color: null } }),
        task('9', 'to do', 0, { due_date: now + 2 * day }),
        task('11', 'to do', 0, { due_date: now + day, priority: { priority: 'urgent', color: null } }),
        task('d', 'in progress', 1, { due_date: now }), // due first, but in another status
      ],
      last_page: false,
    };
    http.expectOne('/api/list/7/task?page=0').flush(page);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = () => el.querySelector<HTMLButtonElement>('.tools .btn')!;
    const order = () => names(el).slice(0, 3); // the "to do" group
    expect(button().textContent).toContain('Sort: ClickUp’s order');

    press('ArrowDown');
    press('ArrowDown');
    expect(press('s')).toBe(false);
    await settle(fixture);
    expect(names(el)).toEqual(['Task 11', 'Task 9', 'Task 10', 'Task d', 'Load more tasks']);
    expect(text(fixture)).toContain('Sorted by due date, soonest first, among the 4 tasks loaded so far.');
    expect(selected(el)).toBe('Task 11');
    expect(button().textContent).toContain('Sort: Due date');
    expect(text(fixture)).toContain('4 open tasks so far, closed ones hidden');

    press('s');
    await settle(fixture);
    expect(order()).toEqual(['Task 11', 'Task 10', 'Task 9']); // urgent, low, none
    press('s');
    await settle(fixture);
    expect(order()).toEqual(['Task 9', 'Task 10', 'Task 11']); // numbers in names sort as numbers
    button().click();
    await settle(fixture);
    expect(order()).toEqual(['Task 10', 'Task 9', 'Task 11']);
    expect(text(fixture)).toContain('Sorted in ClickUp’s order.');

    press('s');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', repeat: true, bubbles: true })); // held down
    await settle(fixture);
    expect(button().textContent).toContain('Sort: Due date');

    press('Escape'); // the next list opens in the same order
    await settle(fixture);
    press('Enter');
    http.expectOne('/api/list/7/task?page=0').flush(page);
    await settle(fixture);
    expect(order()).toEqual(['Task 11', 'Task 9', 'Task 10']);
    expect(button().textContent).toContain('Sort: Due date');

    press('End'); // Load more under a sort: the first new task on screen is selected
    press('Enter');
    http.expectOne('/api/list/7/task?page=1').flush({
      tasks: [task('x', 'to do', 0, { due_date: now + 3 * day }), task('w', 'to do', 0, { due_date: now })],
      last_page: true,
    });
    await settle(fixture);
    expect(selected(el)).toBe('Task w');
    press('s');
    await settle(fixture);
    expect(text(fixture)).toContain('Sorted by priority, urgent first.'); // every task is loaded now
    expect(text(fixture)).not.toContain('loaded so far');
  });

  it('searches names on every screen, and says when nothing matches', async () => {
    const fixture = TestBed.createComponent(App);
    const teams = [{ id: '1', name: 'Acme', color: null, member_count: 1 }, { id: '2', name: 'Café Nord', color: null, member_count: 1 }];
    http.expectOne('/api/user').flush(ada);
    http.expectOne('/api/team').flush({ teams });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const box = el.querySelector<HTMLInputElement>('.find')!;
    expect(box.placeholder).toBe('Search by name');
    expect(el.querySelector('.tools .btn')).toBeNull(); // only lists sort
    expect(press('s')).toBe(true);

    press('/');
    type(box, 'CAFE');
    await new Promise((done) => setTimeout(done, 700)); // screen readers hear the count once typing pauses
    await settle(fixture);
    expect(names(el)).toEqual(['Café Nord']);
    expect(el.querySelector('.sr-only[role="status"]')?.textContent).toBe('1 match among 2 workspaces');

    type(box, 'zzz');
    await settle(fixture);
    expect(text(fixture)).toContain('Nothing here matches “zzz”. Esc clears the search.');
    expect(text(fixture)).toContain('No matches among 2 workspaces');
    expect(box.getAttribute('aria-expanded')).toBe('false');
    expect(box.hasAttribute('aria-activedescendant')).toBe(false);
    expect(box.hasAttribute('aria-controls')).toBe(false);
    press('Enter', box); // opens nothing: afterEach's verify()

    press('Escape', box);
    await settle(fixture);
    expect(el.querySelectorAll('.row').length).toBe(2);
    expect(el.querySelector('.view-sub')?.textContent?.trim()).toBe('2 workspaces');
    expect(document.activeElement).toBe(box);
  });

  it('only skips the splash with the first key', async () => {
    TestBed.inject(Backend).settings.set({ animations: true, only_lists: [] });
    const fixture = TestBed.createComponent(App);
    http.expectOne('/api/user').flush(ada);
    http.expectOne('/api/team').flush({ teams: [{ id: '9', name: 'Acme', color: null, member_count: 1 }] });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('.splash')).not.toBeNull();

    press('Enter');
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('.splash')).toBeNull();
    http.expectNone('/api/team/9/space'); // the Enter didn't open Acme
  });

  it('maps backend errors', async () => {
    const backend = TestBed.inject(Backend);

    const down = backend.get('/api/team');
    http.expectOne('/api/team').flush('proxy error', { status: 500, statusText: 'Internal Server Error' });
    await expect(down).rejects.toEqual({ kind: 'unreachable' });

    const refused = backend.get('/api/user');
    http.expectOne('/api/user').flush(rejected, { status: 401, statusText: 'Unauthorized' });
    await expect(refused).rejects.toEqual({ kind: 'unauthorized', message: 'Token invalid', configPath: '/x/config.toml' });
  });
});
