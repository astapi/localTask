import type { Task } from "./types.js";

export interface Summary {
  total: number;
  inProgress: Task[];
  undeployed: Task[];
  overdue: Task[];
  dueSoon: Task[]; // 今日〜3日以内
  inbox: Task[];
}

/** 残タスク（未完了・非アーカイブ）からサマリを組み立てる */
export function buildSummary(openTasks: Task[], now = new Date()): Summary {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const soonLimit = new Date(today);
  soonLimit.setDate(soonLimit.getDate() + 3);

  const overdue: Task[] = [];
  const dueSoon: Task[] = [];

  for (const t of openTasks) {
    if (!t.dueDate) continue;
    const due = new Date(t.dueDate);
    if (Number.isNaN(due.getTime())) continue;
    if (due < today) overdue.push(t);
    else if (due <= soonLimit) dueSoon.push(t);
  }

  return {
    total: openTasks.length,
    inProgress: openTasks.filter((t) => t.localState === "in_progress"),
    undeployed: openTasks.filter((t) => t.localState === "undeployed"),
    overdue,
    dueSoon,
    inbox: openTasks.filter((t) => t.localState === "inbox"),
  };
}

/** 前営業日の0:00を返す（土日はスキップ。月曜なら金曜になる） */
export function previousBusinessDayStart(now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  do {
    d.setDate(d.getDate() - 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

/** 6/19(金) のような日本語日付ラベル */
export function jpDateLabel(d: Date): string {
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${w})`;
}

function line(t: Task): string {
  const due = t.dueDate ? ` (期限: ${t.dueDate})` : "";
  return `• ${t.title}${due}`;
}

/** ターミナル/ログ向けのテキストサマリ */
export function formatSummaryText(s: Summary): string {
  const out: string[] = [];
  out.push(`📋 残タスク: ${s.total}件`);
  out.push(
    `   進行中 ${s.inProgress.length} / 未デプロイ ${s.undeployed.length} / 未着手 ${s.inbox.length}`,
  );

  if (s.overdue.length) {
    out.push(`\n🔴 期限超過 (${s.overdue.length})`);
    s.overdue.slice(0, 10).forEach((t) => out.push(line(t)));
  }
  if (s.dueSoon.length) {
    out.push(`\n🟡 期限間近・3日以内 (${s.dueSoon.length})`);
    s.dueSoon.slice(0, 10).forEach((t) => out.push(line(t)));
  }
  if (s.undeployed.length) {
    out.push(`\n🚀 未デプロイ (${s.undeployed.length})`);
    s.undeployed.slice(0, 10).forEach((t) => out.push(line(t)));
  }
  if (s.inProgress.length) {
    out.push(`\n🔵 進行中 (${s.inProgress.length})`);
    s.inProgress.slice(0, 10).forEach((t) => out.push(line(t)));
  }
  return out.join("\n");
}
