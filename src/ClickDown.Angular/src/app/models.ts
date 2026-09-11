// The backend's JSON, exactly as described in the backend/UI contract.
export interface Settings { animations: boolean; only_lists: string[] }  // only_lists: list ids from config.toml; [] = everything
export interface User { id: number; username: string | null; email: string | null; color: string | null; initials: string | null }
export interface Team { id: string; name: string; color: string | null; member_count: number }
export interface Status { status: string; color: string | null; type: string | null; orderindex: number | null }
export interface Space { id: string; name: string; color: string | null; statuses: Status[] }
export interface Folder { id: string; name: string; task_count: number | null; list_count: number | null }  // list_count: null when shared with you
export interface List { id: string; name: string; task_count: number | null }
export interface SharedHierarchy { shared: { folders: Folder[]; lists: List[] } }  // shared with you directly
export interface Priority { priority: string; color: string | null }
export interface Tag { name: string; tag_fg: string | null; tag_bg: string | null }
export interface Task {
  id: string; custom_id: string | null; name: string;
  status: Status; priority: Priority | null;
  assignees: User[]; tags: Tag[];
  due_date: number | null;          // epoch ms
  parent: string | null;
}
export interface TaskDetail extends Task {
  subtasks: Task[]; description_html: string;
  list: { id: string; name: string } | null;
  creator: User | null;
  date_created: number | null; date_updated: number | null; start_date: number | null;  // epoch ms
  time_estimate: number | null;     // ms
  points: number | null;
}
export interface Comment { id: string; comment_text: string; user: User | null; date: number | null; reply_count: number | null }
export interface TasksPage { tasks: Task[]; last_page: boolean }
export interface CommentsPage { comments: Comment[]; has_more: boolean }  // newest first, 25 a page
export interface RateLimit { limit: number; remaining: number }  // from the x-ratelimit-* headers

export type ApiErrorBody =
  | { error: 'unauthorized'; message: string; config_path: string }
  | { error: 'rate_limited'; retry_in_s: number }
  | { error: 'network'; message: string }
  | { error: 'clickup'; status: number; message: string }
  | { error: 'not_allowed'; message: string }  // outside only_lists in config.toml
  | { error: 'bad_request' } | { error: 'forbidden' } | { error: 'not_found' };
