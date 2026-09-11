import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { App } from './app';
import { Backend } from './backend';

const ada = { user: { id: 1, username: 'Ada', email: null, color: '#7b68ee', initials: 'A' } };
const rejected = { error: 'unauthorized', message: 'Token invalid', config_path: '/x/config.toml' };
const task = (id: string, status: string, orderindex: number, extra: object = {}) => ({
  id, custom_id: null, name: `Task ${id}`, status: { status, color: '#87909e', type: 'custom', orderindex },
  priority: null, assignees: [], tags: [], due_date: null, parent: null, ...extra,
});

describe('App', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Backend).settings.set({ animations: false, only_lists: [] }); // no splash to skip
  });

  afterEach(() => http.verify());

  const press = (key: string, target: EventTarget = document) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  const text = (fixture: ComponentFixture<App>) => (fixture.nativeElement as HTMLElement).textContent ?? '';
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
      tasks: [task('a', 'in progress', 1), task('b', 'to do', 0), task('c', 'in progress', 1)], last_page: false,
    });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const heads = [...el.querySelectorAll('.group-head')].map((h) => h.textContent);
    expect(heads).toEqual(['To do1', 'In progress2']);
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
      subtasks: [task('s', 'to do', 0, { parent: 'a' })], list: { id: '7', name: 'Bugs' },
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
    expect(page).toContain('In Bugs');
    expect(page).toContain('High');
    expect(page).toContain('1 h 30 min');
    expect(page).toContain('3 days ago by Cy');
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
