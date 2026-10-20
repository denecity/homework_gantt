import type { AppState, Assignment, Course, Marker, NotificationRule } from "../shared/schema";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${method} ${path} failed (${res.status})`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  state: () => request<AppState>("GET", "/api/state"),
  version: () => request<{ version: number }>("GET", "/api/version").then((r) => r.version),
  setDone: (id: string, done: boolean) => request("POST", "/api/done", { id, done }),
  createAssignment: (body: Partial<Assignment> & { course_id: string }) =>
    request<Assignment>("POST", "/api/assignments", body),
  updateAssignment: (id: string, patch: Partial<Assignment>) =>
    request<Assignment>("PATCH", `/api/assignments/${enc(id)}`, patch),
  deleteAssignment: (id: string) => request("DELETE", `/api/assignments/${enc(id)}`),
  reorderCourses: (ids: string[]) => request("PUT", "/api/courses/order", { ids }),
  updateCourse: (id: string, patch: Partial<Course>) => request<Course>("PATCH", `/api/courses/${enc(id)}`, patch),
  updateMarker: (id: string, patch: Partial<Marker>) => request<Marker>("PATCH", `/api/markers/${enc(id)}`, patch),
  deleteMarker: (id: string) => request("DELETE", `/api/markers/${enc(id)}`),
  pushConfig: () => request<{ publicKey: string | null; configured: boolean; devices: number }>("GET", "/api/push/config"),
  updateRule: (id: string, patch: Partial<NotificationRule>) =>
    request<NotificationRule>("PATCH", `/api/notification-rules/${enc(id)}`, patch),
  testNotification: () => request<{ sent: number; failed: number; pruned: number }>("POST", "/api/notifications/test", {}),
};
